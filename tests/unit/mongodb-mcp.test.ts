import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { connectionSchema } from '../../packages/core/src/schema.js';

process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.SETUP_TOKEN = 'unit-test-setup-token'.repeat(3);
const { mongoPins, pinArguments, pinTools, workspaceDatabase, PRECONFIGURED_CONNECTION } =
  await import('../../packages/core/src/mongoMcp.js');

const tool = (name: string, properties: Record<string, unknown>, required: string[] = []): Tool => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: 'object', properties, required },
});
const catalog = [
  tool(
    'find',
    { connectionId: { type: 'string' }, database: { type: 'string' }, collection: { type: 'string' } },
    ['connectionId', 'database', 'collection'],
  ),
  tool('list-connections', {}),
  tool('list-databases', { connectionId: { type: 'string' } }, ['connectionId']),
];

test('workspace databases are distinct per workspace, stable, and valid MongoDB names', () => {
  const a = workspaceDatabase('tenant-a');
  assert.equal(a, workspaceDatabase('tenant-a'));
  assert.notEqual(a, workspaceDatabase('tenant-b'));
  assert.match(a, /^oh_ws_[0-9a-f]{24}$/);
  assert.notEqual(a, 'agentic');
});

test('built-in connections use the workspace database; external ones need their own', () => {
  assert.equal(mongoPins({ kind: 'mcp', ownerId: 't' }), undefined);
  assert.deepEqual(mongoPins({ kind: 'mongodb', builtIn: true, database: 'agentic', ownerId: 't' }), {
    database: workspaceDatabase('t'),
    builtIn: true,
  });
  assert.deepEqual(mongoPins({ kind: 'mongodb', database: 'analytics', ownerId: 't' }), {
    database: 'analytics',
    builtIn: false,
  });
  assert.throws(() => mongoPins({ kind: 'mongodb', ownerId: 't' }), /Choose the database/);
});

test('pinned tools hide the connection and database, and the built-in server only offers one-database tools', () => {
  const builtIn = pinTools(catalog, { database: 'oh_ws_x', builtIn: true });
  assert.deepEqual(
    builtIn.map((t) => t.name),
    ['find'],
  );
  assert.deepEqual(Object.keys(builtIn[0].inputSchema.properties ?? {}), ['collection']);
  assert.deepEqual(builtIn[0].inputSchema.required, ['collection']);
  // Another MongoDB MCP server keeps its other tools, still without the pinned arguments.
  const external = pinTools(catalog, { database: 'analytics', builtIn: false });
  assert.deepEqual(
    external.map((t) => t.name),
    ['find', 'list-connections', 'list-databases'],
  );
  assert.deepEqual(external[2].inputSchema.required, []);
});

test('calls always carry the pinned database and connection, whatever the caller sent', () => {
  const pins = { database: 'oh_ws_x', builtIn: true };
  assert.deepEqual(pinArguments({ collection: 'c', database: 'agentic', connectionId: 'evil' }, pins, true), {
    collection: 'c',
    database: 'oh_ws_x',
    connectionId: PRECONFIGURED_CONNECTION,
  });
  // Servers whose tools take no connection id do not receive one.
  assert.deepEqual(pinArguments({ collection: 'c', connectionId: 'x' }, pins, false), {
    collection: 'c',
    database: 'oh_ws_x',
  });
});

test('aggregation stages cannot write to or read from another database', () => {
  const pins = { database: 'oh_ws_x', builtIn: true };
  for (const pipeline of [
    [{ $out: { db: 'agentic', coll: 'users' } }],
    [{ $merge: { into: { db: 'oh_ws_other', coll: 'stolen' } } }],
    [{ $lookup: { from: { db: 'agentic', coll: 'sessions' }, as: 's', pipeline: [] } }],
  ])
    assert.throws(
      () => pinArguments({ collection: 'c', pipeline }, pins, true),
      /only use the database oh_ws_x/,
    );
  // The same database, plain collection names, and a document field named `db` are fine.
  assert.doesNotThrow(() =>
    pinArguments(
      {
        collection: 'c',
        pipeline: [
          { $match: { db: 'postgres' } },
          { $out: { db: 'oh_ws_x', coll: 'copy' } },
          { $merge: { into: 'summary' } },
        ],
      },
      pins,
      true,
    ),
  );
});

test('MongoDB connections validate their database name', () => {
  const base = { name: 'Mongo', url: 'https://mcp.example.com/mcp', kind: 'mongodb' };
  assert.equal(connectionSchema.parse({ ...base, database: 'analytics_2026' }).database, 'analytics_2026');
  for (const database of ['a.b', 'a b', '$x', 'x'.repeat(64), ''])
    assert.throws(() => connectionSchema.parse({ ...base, database }));
});
