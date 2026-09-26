// Storage contracts for the gateway. Everything the gateway persists goes through these two interfaces, so
// swapping MongoDB for another database (for example PostgreSQL) means adding one implementation of each.
import { MemoryClusters, type ClusterStore } from './clusters.js';
import type { Platform } from '@openharness/connector-core';

export type DeviceRecord = {
  device_id: string;
  cluster_id?: string;
  name: string;
  /** argon2id hash of the device token; the token itself is never stored. */
  token_hash: string;
  platform: Platform;
  allowed_tools: string[];
  owner: string;
  created_at: string;
  last_seen?: string;
  disabled: boolean;
};
export type DevicePatch = Partial<
  Pick<DeviceRecord, 'name' | 'token_hash' | 'allowed_tools' | 'disabled' | 'owner'>
>;
export interface Registry {
  get(deviceId: string): Promise<DeviceRecord | undefined>;
  list(owner?: string): Promise<DeviceRecord[]>;
  /** Fails with DuplicateDeviceError when the id exists. */
  create(record: DeviceRecord): Promise<void>;
  update(deviceId: string, patch: DevicePatch): Promise<boolean>;
  touch(deviceId: string, when: Date): Promise<void>;
  delete(deviceId: string): Promise<boolean>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
/** One persisted tool call (see audit.ts). Stores keep what they are given; redaction happens before. */
export type StoredAuditRecord = {
  ts: Date;
  identity: string;
  device_id: string;
  tool: string;
  arguments: unknown;
  duration_ms: number;
  outcome: string;
  error?: string;
};
export interface AuditStore {
  insert(record: StoredAuditRecord): Promise<void>;
  recent(filter: { device_id?: string; limit?: number }): Promise<StoredAuditRecord[]>;
}
export class DuplicateDeviceError extends Error {
  constructor(deviceId: string) {
    super(`device ${deviceId} already exists`);
  }
}
export type Storage = {
  consumeApproval(id: string, expires: Date): Promise<boolean>;
  registry: Registry;
  clusters: ClusterStore;
  audit: AuditStore;
  close(): Promise<void>;
};

/** In-process storage for tests and throwaway runs. Nothing survives a restart. */
export class MemoryRegistry implements Registry {
  private devices = new Map<string, DeviceRecord>();
  async get(deviceId: string) {
    const d = this.devices.get(deviceId);
    return d ? structuredClone(d) : undefined;
  }
  async list(owner?: string) {
    return [...this.devices.values()]
      .filter((d) => owner === undefined || d.owner === owner)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((d) => structuredClone(d));
  }
  async create(record: DeviceRecord) {
    if (this.devices.has(record.device_id)) throw new DuplicateDeviceError(record.device_id);
    this.devices.set(record.device_id, structuredClone(record));
  }
  async update(deviceId: string, patch: DevicePatch) {
    const d = this.devices.get(deviceId);
    if (!d) return false;
    Object.assign(d, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    return true;
  }
  async touch(deviceId: string, when: Date) {
    const d = this.devices.get(deviceId);
    if (d) d.last_seen = when.toISOString();
  }
  async delete(deviceId: string) {
    return this.devices.delete(deviceId);
  }
  async ping() {}
  async close() {}
}
export class MemoryAuditStore implements AuditStore {
  records: StoredAuditRecord[] = [];
  async insert(record: StoredAuditRecord) {
    this.records.push(record);
    if (this.records.length > 10_000) this.records.shift();
  }
  async recent({ device_id, limit = 100 }: { device_id?: string; limit?: number }) {
    return this.records
      .filter((r) => !device_id || r.device_id === device_id)
      .slice(-limit)
      .reverse();
  }
}
export const memoryStorage = (): Storage => {
  const used = new Map<string, number>();
  return {
    consumeApproval: async (id, expires) => {
      for (const [key, end] of used) if (end <= Date.now()) used.delete(key);
      if (used.has(id)) return false;
      used.set(id, expires.getTime());
      return true;
    },
    registry: new MemoryRegistry(),
    clusters: new MemoryClusters(),
    audit: new MemoryAuditStore(),
    close: async () => {},
  };
};

/** Picks the configured backend. MongoDB is the only persistent one today. */
export async function createStorage(config: {
  GATEWAY_MONGODB_URI?: string;
  GATEWAY_MONGODB_DATABASE: string;
  GATEWAY_AUDIT_RETENTION_DAYS: number;
}): Promise<Storage> {
  if (!config.GATEWAY_MONGODB_URI)
    throw new Error(
      'GATEWAY_MONGODB_URI is required: the gateway stores its device registry and audit trail in MongoDB',
    );
  const { connectMongoStorage } = await import('./mongoStorage.js');
  return connectMongoStorage(
    config.GATEWAY_MONGODB_URI,
    config.GATEWAY_MONGODB_DATABASE,
    config.GATEWAY_AUDIT_RETENTION_DAYS,
  );
}
