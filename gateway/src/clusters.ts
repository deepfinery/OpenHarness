import { z } from 'zod';
import type { Collection } from 'mongodb';
export const clusterSchema = z.object({
  name: z.string().trim().min(1).max(100),
  disabled: z.boolean().default(false),
  max_nodes: z.number().int().min(1).max(10000).default(5000),
  remediation: z.enum(['disabled', 'approval', 'automatic']).default('disabled'),
  actions: z
    .array(z.enum(['gpu_reset', 'restart_fabric_manager', 'reboot']))
    .max(3)
    .default([]),
  cooldown_seconds: z.number().int().min(60).max(86400).default(600),
});
export type Cluster = z.infer<typeof clusterSchema> & {
  _id: string;
  owner: string;
  token_hash: string;
  created_at: string;
  next_action_at?: number;
  slots?: string[];
};
export interface ClusterStore {
  get(id: string): Promise<Cluster | null>;
  list(owner?: string): Promise<Cluster[]>;
  create(cluster: Cluster): Promise<void>;
  update(id: string, patch: Partial<Cluster>): Promise<void>;
  claimNode(id: string, deviceId: string): Promise<boolean>;
  reserveAction(id: string, now: number, action?: string, mode?: Cluster['remediation']): Promise<boolean>;
}
export class MemoryClusters implements ClusterStore {
  records = new Map<string, Cluster>();
  async get(id: string) {
    return structuredClone(this.records.get(id) ?? null);
  }
  async list(owner?: string) {
    return structuredClone([...this.records.values()].filter((c) => !owner || c.owner === owner));
  }
  async create(cluster: Cluster) {
    this.records.set(cluster._id, structuredClone(cluster));
  }
  async update(id: string, patch: Partial<Cluster>) {
    Object.assign(this.records.get(id)!, patch);
  }
  async claimNode(id: string, deviceId: string) {
    const c = this.records.get(id);
    if (!c || c.disabled) return false;
    c.slots ??= [];
    if (c.slots.includes(deviceId)) return true;
    if (c.slots.length >= c.max_nodes) return false;
    c.slots.push(deviceId);
    return true;
  }
  async reserveAction(id: string, now: number, action?: string, mode?: Cluster['remediation']) {
    const c = this.records.get(id);
    if (
      !c ||
      c.disabled ||
      c.remediation === 'disabled' ||
      (mode && c.remediation !== mode) ||
      (action && !c.actions.includes(action as any)) ||
      (c.next_action_at ?? 0) > now
    )
      return false;
    c.next_action_at = now + c.cooldown_seconds * 1000;
    return true;
  }
}
export class MongoClusters implements ClusterStore {
  constructor(private rows: Collection<Cluster>) {}
  get(id: string) {
    return this.rows.findOne({ _id: id });
  }
  list(owner?: string) {
    return this.rows
      .find(owner ? { owner } : {})
      .limit(1000)
      .toArray();
  }
  async create(cluster: Cluster) {
    await this.rows.insertOne(cluster);
  }
  async update(id: string, patch: Partial<Cluster>) {
    await this.rows.updateOne({ _id: id }, { $set: patch });
  }
  async claimNode(id: string, deviceId: string) {
    return Boolean(
      (
        await this.rows.updateOne(
          {
            _id: id,
            disabled: false,
            $or: [
              { slots: deviceId },
              { $expr: { $lt: [{ $size: { $ifNull: ['$slots', []] } }, '$max_nodes'] } },
            ],
          },
          { $addToSet: { slots: deviceId } },
        )
      ).matchedCount,
    );
  }
  async reserveAction(id: string, now: number, action?: string, mode?: Cluster['remediation']) {
    return Boolean(
      (
        await this.rows.updateOne(
          {
            _id: id,
            disabled: false,
            remediation: mode ?? { $ne: 'disabled' },
            ...(action ? { actions: action as any } : {}),
            $or: [{ next_action_at: { $exists: false } }, { next_action_at: { $lte: now } }],
          },
          [{ $set: { next_action_at: { $add: [now, { $multiply: ['$cooldown_seconds', 1000] }] } } }],
        )
      ).modifiedCount,
    );
  }
}
export const clusterTools = ['system_info', 'gpu_inspect', 'gpu_remediate'];
export const clusterView = ({ token_hash, slots, ...c }: Cluster) => ({
  ...c,
  node_count: slots?.length ?? 0,
});
