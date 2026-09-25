// MongoDB implementation of the gateway storage contracts. The gateway uses its own database
// (default `agentic_gateway`), separate from the orchestrator's, so neither reads the other's data.
import { MongoClient, MongoServerError, type Collection } from 'mongodb';
import {
  DuplicateDeviceError,
  type AuditStore,
  type DevicePatch,
  type DeviceRecord,
  type Registry,
  type Storage,
  type StoredAuditRecord,
} from './registry.js';

type DeviceDoc = Omit<DeviceRecord, 'device_id' | 'created_at' | 'last_seen'> & {
  _id: string;
  created_at: Date;
  last_seen?: Date;
};
const toRecord = ({ _id, created_at, last_seen, ...rest }: DeviceDoc): DeviceRecord => ({
  ...rest,
  device_id: _id,
  created_at: created_at.toISOString(),
  ...(last_seen ? { last_seen: last_seen.toISOString() } : {}),
});

class MongoRegistry implements Registry {
  constructor(
    private readonly devices: Collection<DeviceDoc>,
    private readonly client: MongoClient,
  ) {}
  async get(deviceId: string) {
    const doc = await this.devices.findOne({ _id: deviceId });
    return doc ? toRecord(doc) : undefined;
  }
  async list(owner?: string) {
    const docs = await this.devices
      .find(owner === undefined ? {} : { owner })
      .sort({ created_at: 1 })
      .limit(5000)
      .toArray();
    return docs.map(toRecord);
  }
  async create(record: DeviceRecord) {
    const { device_id, created_at, last_seen, ...rest } = record;
    try {
      await this.devices.insertOne({
        ...rest,
        _id: device_id,
        created_at: new Date(created_at),
        ...(last_seen ? { last_seen: new Date(last_seen) } : {}),
      });
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000)
        throw new DuplicateDeviceError(device_id);
      throw error;
    }
  }
  async update(deviceId: string, patch: DevicePatch) {
    const $set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (!Object.keys($set).length)
      return Boolean(await this.devices.findOne({ _id: deviceId }, { projection: { _id: 1 } }));
    return (await this.devices.updateOne({ _id: deviceId }, { $set })).matchedCount > 0;
  }
  async touch(deviceId: string, when: Date) {
    await this.devices.updateOne({ _id: deviceId }, { $set: { last_seen: when } });
  }
  async delete(deviceId: string) {
    return (await this.devices.deleteOne({ _id: deviceId })).deletedCount > 0;
  }
  async ping() {
    await this.client.db('admin').command({ ping: 1 });
  }
  async close() {
    await this.client.close();
  }
}
class MongoAuditStore implements AuditStore {
  constructor(private readonly calls: Collection<StoredAuditRecord>) {}
  async insert(record: StoredAuditRecord) {
    await this.calls.insertOne({ ...record });
  }
  async recent({ device_id, limit = 100 }: { device_id?: string; limit?: number }) {
    return this.calls
      .find(device_id ? { device_id } : {}, { projection: { _id: 0 } })
      .sort({ ts: -1 })
      .limit(Math.min(limit, 1000))
      .toArray();
  }
}
export async function connectMongoStorage(
  uri: string,
  database: string,
  retentionDays: number,
): Promise<Storage> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000, appName: 'agentic-gateway' });
  await client.connect();
  const db = client.db(database);
  const devices = db.collection<DeviceDoc>('devices');
  const calls = db.collection<StoredAuditRecord>('tool_calls');
  await Promise.all([
    devices.createIndex({ owner: 1, created_at: 1 }),
    calls.createIndex({ device_id: 1, ts: -1 }),
    // Old audit entries expire on their own; 0 keeps them forever.
    ...(retentionDays > 0
      ? [calls.createIndex({ ts: 1 }, { expireAfterSeconds: retentionDays * 86400, name: 'ts_ttl' })]
      : []),
  ]);
  const registry = new MongoRegistry(devices, client);
  return { registry, audit: new MongoAuditStore(calls), close: () => registry.close() };
}
