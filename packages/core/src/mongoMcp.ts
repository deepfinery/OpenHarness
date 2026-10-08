import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { config } from './config.js';
import { collection, mongo } from './db.js';
import { decrypt, encrypt, hash, HttpError, randomToken, safeError } from './security.js';
import type { McpConnection } from './schema.js';

/** The MongoDB MCP server's id for the connection string it was started with. */
export const PRECONFIGURED_CONNECTION = 'preconfigured';
/** Arguments OpenHarness supplies on every MongoDB tool call; agents and the studio never choose them. */
const PINNED = ['connectionId', 'database'] as const;
/** Lets the built-in server's user list a collection's indexes with `$indexStats`. */
const INDEX_STATS_ROLE = 'openharness_index_stats';

type MongoConnection = Pick<McpConnection, 'kind' | 'database' | 'builtIn'> & { ownerId: string };
export type MongoPins = { database: string; builtIn: boolean };

/** The database a workspace's built-in MongoDB connection reads and writes. Never the application database. */
export function workspaceDatabase(ownerId: string) {
  return `oh_ws_${hash(`mongodb-collections:${ownerId}`).slice(0, 24)}`;
}
export function mongoPins(connection: MongoConnection): MongoPins | undefined {
  if (connection.kind !== 'mongodb') return undefined;
  const database = connection.builtIn ? workspaceDatabase(connection.ownerId) : connection.database;
  if (!database) throw new HttpError(400, 'Choose the database this MongoDB connection uses');
  return { database, builtIn: Boolean(connection.builtIn) };
}
type Schema = { properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
/**
 * The tools as agents see them: the pinned arguments are removed from each schema. The built-in server only exposes
 * tools that act on one database, so nothing can list or reach the databases of other workspaces.
 */
export function pinTools(tools: Tool[], pins: MongoPins): Tool[] {
  return tools.flatMap((tool) => {
    const schema = tool.inputSchema as Schema;
    const properties = { ...(schema.properties ?? {}) };
    if (pins.builtIn && !('database' in properties)) return [];
    for (const key of PINNED) delete properties[key];
    return [
      {
        ...tool,
        description:
          `${tool.description ?? ''} Uses the MongoDB database configured for this connection.`.trim(),
        inputSchema: {
          ...schema,
          properties,
          ...(schema.required
            ? { required: schema.required.filter((k) => !(PINNED as readonly string[]).includes(k)) }
            : {}),
        } as Tool['inputSchema'],
      },
    ];
  });
}
/**
 * Arguments for the server: the caller's, with the pinned database (and connection, when the tool takes one).
 * Aggregation stages that name a namespace ({ db, coll }) must stay in that database.
 */
export function pinArguments(
  args: Record<string, unknown> | undefined,
  pins: MongoPins,
  takesConnection: boolean,
) {
  const pinned: Record<string, unknown> = { ...(args ?? {}), database: pins.database };
  if (takesConnection) pinned.connectionId = PRECONFIGURED_CONNECTION;
  else delete pinned.connectionId;
  if (pinned.pipeline !== undefined) assertSameDatabase(pinned.pipeline, pins.database);
  return pinned;
}
export function assertSameDatabase(value: unknown, database: string): void {
  if (Array.isArray(value)) return value.forEach((v) => assertSameDatabase(v, database));
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  // A namespace ($out, $merge into, $lookup from) names both; a document field called `db` alone is just data.
  if ('db' in record && 'coll' in record && record.db !== database)
    throw new HttpError(400, `This connection can only use the database ${database}`);
  for (const v of Object.values(record)) assertSameDatabase(v, database);
}

/**
 * Creates (or re-passwords) the built-in MongoDB MCP server's user with the application's administrator connection.
 * It starts with no roles: each workspace database is granted when a workspace connects, so the user can never read
 * the application database. Returns false when this installation has no built-in server.
 */
export async function ensureMongoMcpUser() {
  if (!config.MONGODB_MCP_URL || !config.MONGODB_MCP_PASSWORD) return false;
  const admin = mongo.db('admin');
  const user = config.MONGODB_MCP_USER;
  const existing = (await admin.command({ usersInfo: user })) as { users: unknown[] };
  if (existing.users.length) await admin.command({ updateUser: user, pwd: config.MONGODB_MCP_PASSWORD });
  else await admin.command({ createUser: user, pwd: config.MONGODB_MCP_PASSWORD, roles: [] });
  return true;
}
/** Grants the built-in server read/write (and index listing) on one workspace database. Idempotent. */
export async function grantWorkspaceDatabase(database: string) {
  if (!config.MONGODB_MCP_URL || !config.MONGODB_MCP_PASSWORD)
    throw new HttpError(503, 'This installation has no MongoDB MCP server');
  const db = mongo.db(database);
  const roles = (await db.command({ rolesInfo: INDEX_STATS_ROLE })) as { roles: unknown[] };
  if (!roles.roles.length)
    await db
      .command({
        createRole: INDEX_STATS_ROLE,
        privileges: [{ resource: { db: database, collection: '' }, actions: ['indexStats'] }],
        roles: [],
      })
      .catch((error: { codeName?: string }) => {
        // A concurrent grant created it first.
        if (error?.codeName !== 'Location51002' && error?.codeName !== 'DuplicateKey') throw error;
      });
  await mongo.db('admin').command({
    grantRolesToUser: config.MONGODB_MCP_USER,
    roles: [
      { role: 'readWrite', db: database },
      { role: INDEX_STATS_ROLE, db: database },
    ],
  });
}
/** At startup: provision the user and re-grant every workspace that already has a built-in connection. */
export async function provisionMongoMcp(ownerIds: () => Promise<string[]>) {
  try {
    if (!(await ensureMongoMcpUser())) return;
    for (const ownerId of await ownerIds()) await grantWorkspaceDatabase(workspaceDatabase(ownerId));
  } catch (error) {
    console.warn('MongoDB MCP access is not provisioned:', safeError(error));
  }
}

/** A MongoDB user that can read and write one workspace database, for the Python jobs of that workspace. */
type WorkspaceMongoUser = { _id: string; user: string; passwordEncrypted: string; createdAt: Date };
const workspaceUsers = () => collection<WorkspaceMongoUser>('workspace_mongo_users');
/**
 * The connection string a workspace's Python jobs use: its own user with readWrite on its own database only, so
 * code can reach that workspace's collections and nothing else. The user is created on first use with the
 * application's administrator connection; the password is kept encrypted and reused.
 */
export async function workspaceJobMongoUri(ownerId: string) {
  const database = workspaceDatabase(ownerId);
  const user = `oh_job_${hash(`mongodb-jobs:${ownerId}`).slice(0, 24)}`;
  const admin = mongo.db('admin');
  let stored = await workspaceUsers().findOne({ _id: ownerId });
  if (!stored) {
    const password = randomToken();
    stored = { _id: ownerId, user, passwordEncrypted: encrypt(password), createdAt: new Date() };
    try {
      await workspaceUsers().insertOne(stored);
    } catch (error) {
      // A concurrent job created it first; use that one.
      if ((error as { code?: number }).code !== 11000) throw error;
      stored = (await workspaceUsers().findOne({ _id: ownerId }))!;
    }
  }
  const password = decrypt(stored.passwordEncrypted);
  const existing = (await admin.command({ usersInfo: stored.user })) as { users: unknown[] };
  const roles = [{ role: 'readWrite', db: database }];
  if (existing.users.length) await admin.command({ updateUser: stored.user, pwd: password, roles });
  else await admin.command({ createUser: stored.user, pwd: password, roles });
  const source = new URL(config.MONGODB_URI);
  const target = new URL(`mongodb://${source.host}/${database}`);
  target.username = stored.user;
  target.password = password;
  target.searchParams.set('authSource', 'admin');
  for (const key of ['replicaSet', 'tls', 'ssl', 'directConnection'])
    if (source.searchParams.has(key)) target.searchParams.set(key, source.searchParams.get(key)!);
  return target.toString();
}
