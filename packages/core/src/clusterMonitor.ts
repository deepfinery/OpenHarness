import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { collection } from './db.js';
import { gatewayAdmin, ensureDeviceConnection, type DeviceView } from './devices.js';
import { createRun } from './runs.js';
import { safeError } from './security.js';
import type { Run } from './schema.js';
export const monitorSchema = z.object({
  enabled: z.boolean().default(false),
  agentId: z.string().uuid(),
  intervalSeconds: z.number().int().min(300).max(86400).default(300),
  concurrency: z.number().int().min(1).max(50).default(4),
  instructions: z
    .string()
    .min(1)
    .max(8000)
    .default(
      'Inspect GPU health, NVIDIA kernel Xid errors, NVLink status and DCGM. Identify likely causes of training slowdowns, compare with saved observations, and report evidence and uncertainty. Only request remediation supported by evidence and allowed by cluster policy. Never stop workloads or reset additional GPUs to work around a refused operation.',
    ),
});
/** Durable coordinator: small waves of independent node agents, one active cycle per cluster. */
export async function dispatchClusterMonitors() {
  const monitors = collection<any>('cluster_monitors'),
    cycles = collection<any>('cluster_cycles');
  for (const m of await monitors.find({ enabled: true }).limit(100).toArray()) {
    const leaseId = randomUUID(),
      now = new Date();
    const lock = await monitors.updateOne(
      { _id: m._id, enabled: true, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: now } }] },
      {
        $set: { leaseId, leaseUntil: new Date(Date.now() + 60000) },
      },
    );
    if (!lock.modifiedCount) continue;
    try {
      const result = await gatewayAdmin<{ clusters: any[] }>(
        `/clusters?owner=${encodeURIComponent(m.ownerId)}`,
      );
      const cluster = result.clusters.find((c) => c._id === m._id);
      if (!cluster || cluster.disabled) continue;
      let cycle = await cycles.findOne({ clusterId: m._id, status: 'running' });
      if (!cycle && new Date(m.nextAt).getTime() <= Date.now()) {
        const { devices } = await gatewayAdmin<{ devices: DeviceView[] }>(
          `/devices?owner=${encodeURIComponent(m.ownerId)}`,
        );
        cycle = {
          _id: randomUUID(),
          clusterId: m._id,
          ownerId: m.ownerId,
          createdAt: new Date(),
          status: 'running',
          deviceIds: devices
            .filter((d) => d.cluster_id === m._id && !d.disabled && d.online)
            .map((d) => d.device_id)
            .sort(),
          offline: devices.filter((d) => d.cluster_id === m._id && !d.disabled && !d.online).length,
          cursor: 0,
          active: [],
          completed: 0,
          failed: 0,
          skipped: 0,
          agentId: m.agentId,
          instructions: m.instructions,
          clusterName: cluster.name,
        };
        await cycles.insertOne(cycle);
      }
      if (!cycle) continue;
      // Reconcile from durable run records; no duplicate effects if the API dies after creating a run.
      const active: string[] = [];
      for (const id of cycle.active as string[]) {
        const run = await collection<Run>('runs').findOne({ _id: id, ownerId: m.ownerId });
        if (run && ['queued', 'running', 'waiting_for_human'].includes(run.status)) active.push(id);
        else if (run?.status === 'succeeded') cycle.completed++;
        else cycle.failed++;
      }
      cycle.active = active;
      const { devices } = await gatewayAdmin<{ devices: DeviceView[] }>(
        `/devices?owner=${encodeURIComponent(m.ownerId)}`,
      );
      // Limit dispatcher work per tick; queue capacity remains governed by MAX_ACTIVE_RUNS as well.
      for (
        let sent = 0;
        sent < 4 && cycle.active.length < m.concurrency && cycle.cursor < cycle.deviceIds.length;
        sent++
      ) {
        const deviceId = cycle.deviceIds[cycle.cursor];
        const device = devices.find(
          (d) => d.device_id === deviceId && d.cluster_id === m._id && !d.disabled && d.online,
        );
        if (!device) {
          cycle.skipped++;
          cycle.cursor++;
          continue;
        }
        try {
          await ensureDeviceConnection(m.ownerId, device, m.createdBy);
          const run = await createRun(
            m.ownerId,
            {
              agentId: cycle.agentId,
              deviceId,
              input: `${cycle.instructions}\n\nCluster: ${cycle.clusterName}\nTarget node: ${deviceId}\nCycle: ${cycle._id}`,
              history: [],
            },
            {
              idempotencyKey: `cluster:${cycle._id}:${deviceId}`,
              initiatedBy: m.createdBy,
              monitoring: { clusterId: m._id, cycleId: cycle._id },
            },
          );
          cycle.active.push(run._id);
          cycle.cursor++;
        } catch (error) {
          if ((error as any).status === 429) break;
          // Retry transient dispatch failures on the same node, rather than silently omitting evidence.
          cycle.error = safeError(error);
          break;
        }
      }
      if (cycle.cursor >= cycle.deviceIds.length && !cycle.active.length) {
        cycle.status = 'completed';
        cycle.finishedAt = new Date();
        await monitors.updateOne(
          { _id: m._id, leaseId },
          { $set: { nextAt: new Date(Date.now() + m.intervalSeconds * 1000) } },
        );
      }
      // Renew/check ownership before publishing coordinator progress.
      const owned = await monitors.updateOne(
        { _id: m._id, leaseId },
        { $set: { leaseUntil: new Date(Date.now() + 60000) } },
      );
      if (owned.matchedCount) await cycles.replaceOne({ _id: cycle._id }, cycle);
    } catch (error) {
      await monitors.updateOne({ _id: m._id, leaseId }, { $set: { error: safeError(error) } });
    } finally {
      await monitors.updateOne({ _id: m._id, leaseId }, { $unset: { leaseId: '', leaseUntil: '' } });
    }
  }
}
