import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { requireAdmin, rateLimit } from './auth.js';
import { collection } from '../../../packages/core/src/db.js';
import { gatewayAdmin, gatewayPublicUrl } from '../../../packages/core/src/devices.js';
import { HttpError } from '../../../packages/core/src/security.js';
import { monitorSchema } from '../../../packages/core/src/clusterMonitor.js';
export const clusters = Router();
export async function ownedCluster(ownerId: string, id: string) {
  const result = await gatewayAdmin<{ clusters: any[] }>(`/clusters?owner=${encodeURIComponent(ownerId)}`);
  const cluster = result.clusters.find((c) => c._id === id);
  if (!cluster) throw new HttpError(404, 'Cluster not found');
  return cluster;
}
clusters.get('/', async (req, res) => {
  const ownerId = req.principal!.tenantId;
  const result = await gatewayAdmin<{ clusters: any[] }>(`/clusters?owner=${encodeURIComponent(ownerId)}`);
  const monitors = await collection<any>('cluster_monitors').find({ ownerId }).toArray();
  res.json({
    clusters: result.clusters.map((c) => ({ ...c, monitor: monitors.find((m) => m._id === c._id) })),
  });
});
function install(token: string) {
  const url = `${gatewayPublicUrl()}/connect`;
  // Values go into an env file, never interpolated as shell code. Validate the operator's public URL too.
  if (/[\r\n]/.test(url)) throw new HttpError(500, 'Invalid gateway URL');
  return {
    token,
    connectUrl: url,
    environment: `GATEWAY_URL=${url}\nDEVICE_TOKEN=${token}\nGATEWAY_ALLOW_INSECURE=${url.startsWith('ws://')}\n`,
    command: 'sudo sh connector-linux/install-cluster.sh /path/to/cluster.env',
    privilegedCommand: 'sudo sh connector-linux/install-cluster.sh /path/to/cluster.env --host-access',
  };
}
clusters.post('/', requireAdmin, async (req, res) => {
  await rateLimit(`cluster-create:${req.principal!.tenantId}`, 20);
  const body = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
  const result = await gatewayAdmin<any>('/clusters', 'POST', { ...body, owner: req.principal!.tenantId });
  res.status(201).json({ cluster: result.cluster, install: install(result.token) });
});
clusters.put('/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  await ownedCluster(req.principal!.tenantId, id);
  // The gateway validates and strips all other fields; owner/token/id cannot be patched here.
  const result = await gatewayAdmin<any>(`/clusters/${id}`, 'PUT', req.body);
  res.json(result);
});
clusters.post('/:id/rotate-token', requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  await ownedCluster(req.principal!.tenantId, id);
  const result = await gatewayAdmin<any>(`/clusters/${id}/rotate-token`, 'POST');
  res.json({ install: install(result.token) });
});
clusters.put('/:id/monitor', requireAdmin, async (req, res) => {
  const ownerId = req.principal!.tenantId,
    id = String(req.params.id);
  await ownedCluster(ownerId, id);
  const body = monitorSchema.parse(req.body);
  if (!(await collection('agents').findOne({ _id: body.agentId, ownerId, enabled: true })))
    throw new HttpError(400, 'Choose an enabled agent in this workspace');
  await collection<any>('cluster_monitors').updateOne(
    { _id: id, ownerId },
    {
      $set: { ...body, ownerId, updatedAt: new Date(), createdBy: req.principal!.user._id },
      $setOnInsert: { nextAt: new Date() },
    },
    { upsert: true },
  );
  res.json({ ok: true });
});
clusters.post('/:id/scan', requireAdmin, async (req, res) => {
  const id = String(req.params.id),
    ownerId = req.principal!.tenantId;
  await ownedCluster(ownerId, id);
  const changed = await collection<any>('cluster_monitors').updateOne(
    { _id: id, ownerId, enabled: true },
    { $set: { nextAt: new Date() } },
  );
  if (!changed.matchedCount) throw new HttpError(409, 'Enable a monitor first');
  res.json({ ok: true });
});
clusters.get('/:id/cycles', async (req, res) => {
  const ownerId = req.principal!.tenantId,
    id = String(req.params.id);
  await ownedCluster(ownerId, id);
  const rows = await collection<any>('cluster_cycles')
    .find({ ownerId, clusterId: id })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray();
  res.json(rows.map(({ deviceIds, leaseId, ...row }) => ({ ...row, nodeCount: deviceIds.length })));
});
