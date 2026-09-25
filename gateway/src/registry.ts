// Device registry. SQLite through Node's built-in module by default; the interface leaves room for Postgres.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Platform } from '@agentic/connector-core';

export type DeviceRecord = {
  device_id: string;
  name: string;
  token_hash: string;
  platform: Platform;
  allowed_tools: string[];
  owner: string;
  created_at: string;
  last_seen?: string;
  disabled: boolean;
};
export interface Registry {
  get(deviceId: string): Promise<DeviceRecord | undefined>;
  list(owner?: string): Promise<DeviceRecord[]>;
  create(record: DeviceRecord): Promise<void>;
  update(
    deviceId: string,
    patch: Partial<Pick<DeviceRecord, 'name' | 'token_hash' | 'allowed_tools' | 'disabled' | 'owner'>>,
  ): Promise<boolean>;
  touch(deviceId: string, when: Date): Promise<void>;
  delete(deviceId: string): Promise<boolean>;
  ping(): Promise<void>;
  close(): void;
}
type Row = {
  device_id: string;
  name: string;
  token_hash: string;
  platform: string;
  allowed_tools: string;
  owner: string;
  created_at: string;
  last_seen: string | null;
  disabled: number;
};
const fromRow = (r: Row): DeviceRecord => ({
  device_id: r.device_id,
  name: r.name,
  token_hash: r.token_hash,
  platform: r.platform as Platform,
  allowed_tools: JSON.parse(r.allowed_tools) as string[],
  owner: r.owner,
  created_at: r.created_at,
  last_seen: r.last_seen ?? undefined,
  disabled: r.disabled === 1,
});
export class SqliteRegistry implements Registry {
  private db: DatabaseSync;
  constructor(dataDir: string, file = 'gateway.sqlite') {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file === ':memory:' ? ':memory:' : join(dataDir, file));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        token_hash TEXT NOT NULL,
        platform TEXT NOT NULL,
        allowed_tools TEXT NOT NULL DEFAULT '[]',
        owner TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_seen TEXT,
        disabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS devices_owner ON devices(owner);
    `);
  }
  async get(deviceId: string) {
    const row = this.db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }
  async list(owner?: string) {
    const rows = (
      owner === undefined
        ? this.db.prepare('SELECT * FROM devices ORDER BY created_at').all()
        : this.db.prepare('SELECT * FROM devices WHERE owner = ? ORDER BY created_at').all(owner)
    ) as Row[];
    return rows.map(fromRow);
  }
  async create(record: DeviceRecord) {
    this.db
      .prepare(
        'INSERT INTO devices (device_id, name, token_hash, platform, allowed_tools, owner, created_at, last_seen, disabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        record.device_id,
        record.name,
        record.token_hash,
        record.platform,
        JSON.stringify(record.allowed_tools),
        record.owner,
        record.created_at,
        record.last_seen ?? null,
        record.disabled ? 1 : 0,
      );
  }
  async update(
    deviceId: string,
    patch: Partial<Pick<DeviceRecord, 'name' | 'token_hash' | 'allowed_tools' | 'disabled' | 'owner'>>,
  ) {
    const sets: string[] = [];
    const values: (string | number)[] = [];
    if (patch.name !== undefined) (sets.push('name = ?'), values.push(patch.name));
    if (patch.token_hash !== undefined) (sets.push('token_hash = ?'), values.push(patch.token_hash));
    if (patch.allowed_tools !== undefined)
      (sets.push('allowed_tools = ?'), values.push(JSON.stringify(patch.allowed_tools)));
    if (patch.disabled !== undefined) (sets.push('disabled = ?'), values.push(patch.disabled ? 1 : 0));
    if (patch.owner !== undefined) (sets.push('owner = ?'), values.push(patch.owner));
    if (!sets.length) return Boolean(await this.get(deviceId));
    const result = this.db
      .prepare(`UPDATE devices SET ${sets.join(', ')} WHERE device_id = ?`)
      .run(...values, deviceId);
    return Number(result.changes) > 0;
  }
  async touch(deviceId: string, when: Date) {
    this.db.prepare('UPDATE devices SET last_seen = ? WHERE device_id = ?').run(when.toISOString(), deviceId);
  }
  async delete(deviceId: string) {
    return Number(this.db.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId).changes) > 0;
  }
  async ping() {
    this.db.prepare('SELECT 1').get();
  }
  close() {
    this.db.close();
  }
}
export function createRegistry(config: { GATEWAY_DATA_DIR: string; DATABASE_URL?: string }): Registry {
  if (config.DATABASE_URL)
    throw new Error(
      'DATABASE_URL is set, but the Postgres registry is not available in this build; unset it to use SQLite',
    );
  return new SqliteRegistry(config.GATEWAY_DATA_DIR);
}
