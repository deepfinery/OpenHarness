import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const password = 'Integration-test-password-42';
let cookie = '';
let otherCookie = '';
let providerId = '';
let connectionId = '';

async function request(path: string, init: { method?: string; body?: unknown; as?: string } = {}) {
  const response = await fetch(base + '/api' + path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { Origin: base, Cookie: init.as ?? cookie, 'Content-Type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const data = response.status === 204 ? undefined : await response.json();
  return { status: response.status, data };
}
async function ok(path: string, body?: unknown, method?: string) {
  const result = await request(path, { body, method });
  assert.ok(result.status < 300, `${path}: ${result.status} ${JSON.stringify(result.data)}`);
  return result.data;
}
async function login(email: string) {
  const response = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie')!.split(';')[0];
}
async function isolatedWorkspace(label: string) {
  const email = `${label}-${randomUUID()}@openharness.test`;
  await ok('/users', { email, password, name: label, workspace: 'new' });
  return email;
}
const collectionsPath = (id = connectionId) => `/mongodb/${id}/collections`;

before(async () => {
  const admin = 'admin@openharness.test';
  if ((await ok('/auth/status')).needsSetup) {
    const setupToken = (await readFile('.env', 'utf8'))
      .split('\n')
      .find((line) => line.startsWith('SETUP_TOKEN='))!
      .slice(12);
    await ok('/auth/setup', { email: admin, password, name: 'Test administrator', setupToken });
  }
  cookie = await login(admin);
  const first = await isolatedWorkspace('mongo-collections');
  const second = await isolatedWorkspace('mongo-other');
  otherCookie = await login(second);
  cookie = await login(first);
  providerId = (
    await ok('/providers', {
      name: 'Mongo fixture',
      kind: 'openai-compatible',
      baseUrl: 'http://fixtures:9090/v1',
      model: 'test-mongo',
      contextWindow: 8192,
      maxOutputTokens: 1024,
    })
  ).id;
});

test('a workspace connects to the installation MongoDB through its MCP server', async () => {
  assert.equal((await ok('/config')).mongodbMcp.builtIn, true);
  // Whatever the browser sends for the address, credentials or database, the installation supplies them.
  const created = await ok('/connections', {
    name: 'Team MongoDB',
    kind: 'mongodb',
    builtIn: true,
    url: 'https://attacker.example/mcp',
    authType: 'token',
    token: 'not-used',
    database: 'agentic',
  });
  connectionId = created.id;
  assert.equal(created.builtIn, true);
  assert.equal(created.url, 'http://mongodb-mcp:3000/mcp');
  assert.equal(created.hasToken, false);
  const tools: { name: string; inputSchema: { properties?: object; required?: string[] } }[] = await ok(
    `/connections/${connectionId}/discover`,
    {},
  );
  const names = tools.map((t) => t.name);
  for (const name of ['find', 'aggregate', 'insert-many', 'update-many', 'create-collection', 'create-index'])
    assert.ok(names.includes(name), `${name} is offered`);
  for (const name of ['list-databases', 'drop-database', 'connect', 'list-connections', 'aggregate-db'])
    assert.ok(!names.includes(name), `${name} is not offered`);
  for (const tool of tools) {
    assert.ok(!('database' in (tool.inputSchema.properties ?? {})), `${tool.name} hides database`);
    assert.ok(!('connectionId' in (tool.inputSchema.properties ?? {})), `${tool.name} hides connectionId`);
  }
  const invalid = await request('/connections', {
    body: { name: 'External', kind: 'mongodb', url: 'https://mcp.example.com/mcp' },
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.data.error, /database/);
});

test('collections can be created, filled with any JSON, browsed, indexed and searched', async () => {
  await ok(collectionsPath(), { name: 'customers' });
  const listed = await ok(collectionsPath());
  assert.match(listed.database, /^oh_ws_[0-9a-f]{24}$/);
  assert.deepEqual(
    listed.collections.find((c: { name: string }) => c.name === 'customers'),
    { name: 'customers', count: 0 },
  );
  const inserted = await ok(`${collectionsPath()}/customers/documents`, {
    documents: [
      { name: 'Ada Lovelace', tier: 'gold', joined: { $date: '2026-01-05T00:00:00Z' }, tags: ['math'] },
      { name: 'Grace Hopper', tier: 'silver', address: { city: 'Arlington' } },
      42,
    ],
  });
  assert.equal(inserted.inserted, 3);
  const single = await ok(`${collectionsPath()}/customers/documents`, { documents: { name: 'Solo' } });
  assert.equal(single.inserted, 1);

  const gold = await ok(
    `${collectionsPath()}/customers/documents?filter=${encodeURIComponent('{"tier":"gold"}')}`,
  );
  assert.equal(gold.total, 1);
  assert.equal(gold.documents[0].name, 'Ada Lovelace');
  assert.deepEqual(gold.documents[0].joined, { $date: '2026-01-05T00:00:00.000Z' });
  const page = await ok(
    `${collectionsPath()}/customers/documents?skip=1&limit=1&sort=${encodeURIComponent('{"name":-1}')}`,
  );
  assert.equal(page.total, 4);
  assert.equal(page.documents.length, 1);
  assert.equal(page.documents[0].name, 'Grace Hopper');
  const wrapped = await ok(
    `${collectionsPath()}/customers/documents?filter=${encodeURIComponent('{"value":42}')}`,
  );
  assert.equal(wrapped.total, 1);
  const badFilter = await request(`${collectionsPath()}/customers/documents?filter=not-json`);
  assert.equal(badFilter.status, 400);

  assert.equal((await ok(`${collectionsPath()}/customers/indexes`, { field: 'tier' })).name, 'tier_1');
  assert.equal(
    (await ok(`${collectionsPath()}/customers/indexes`, { field: 'name', type: 'text' })).name,
    'name_text',
  );
  const indexes = (await ok(`${collectionsPath()}/customers/indexes`)).indexes.map(
    (i: { name: string }) => i.name,
  );
  assert.deepEqual(indexes.sort(), ['_id_', 'name_text', 'tier_1']);
  const searched = await ok(
    `${collectionsPath()}/customers/documents?filter=${encodeURIComponent('{"$text":{"$search":"hopper"}}')}`,
  );
  assert.equal(searched.total, 1);
  assert.equal(searched.documents[0].name, 'Grace Hopper');
  await ok(`${collectionsPath()}/customers/indexes/tier_1`, undefined, 'DELETE');
  assert.equal(
    (await request(`${collectionsPath()}/customers/indexes/_id_`, { method: 'DELETE' })).status,
    400,
  );

  // Editing replaces the document in place: changed fields are set, removed ones are unset, the _id stays.
  const ada = gold.documents[0];
  assert.equal(
    (
      await ok(
        `${collectionsPath()}/customers/documents/${ada._id.$oid}`,
        { document: { ...ada, tier: 'platinum', tags: undefined, note: 'edited in the studio' } },
        'PUT',
      )
    ).modified,
    1,
  );
  const edited = (
    await ok(
      `${collectionsPath()}/customers/documents?filter=${encodeURIComponent('{"name":"Ada Lovelace"}')}`,
    )
  ).documents[0];
  assert.equal(edited._id.$oid, ada._id.$oid);
  assert.equal(edited.tier, 'platinum');
  assert.equal(edited.note, 'edited in the studio');
  assert.ok(!('tags' in edited));
  assert.equal(
    (
      await request(`${collectionsPath()}/customers/documents/${ada._id.$oid}`, {
        method: 'PUT',
        body: { document: { $where: 'x' } },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`${collectionsPath()}/customers/documents/${'0'.repeat(24)}`, {
        method: 'PUT',
        body: { document: { name: 'missing' } },
      })
    ).status,
    404,
  );
  const solo = (
    await ok(`${collectionsPath()}/customers/documents?filter=${encodeURIComponent('{"name":"Solo"}')}`)
  ).documents[0];
  assert.equal(
    (await ok(`${collectionsPath()}/customers/documents/${solo._id.$oid}`, undefined, 'DELETE')).deleted,
    1,
  );
  assert.equal(
    (await ok(collectionsPath())).collections.find((c: { name: string }) => c.name === 'customers').count,
    3,
  );
  for (const name of ['system.users', 'bad$name', '.hidden'])
    assert.equal((await request(collectionsPath(), { body: { name } })).status, 400);
});

test('agents read and write the same collections, always in the workspace database', async () => {
  const agent = await ok('/agents', {
    name: 'Mongo writer',
    providerId,
    systemPrompt: 'Keep notes in MongoDB.',
    connections: [{ connectionId, tools: ['insert-many', 'find'] }],
  });
  const started = await ok('/runs', { agentId: agent.id, input: 'mongo collection roundtrip' });
  let run;
  for (let i = 0; i < 160; i++) {
    run = await ok(`/runs/${started.id}`);
    if (!['queued', 'running'].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(run.status, 'succeeded', run.error);
  assert.match(run.output, /Collection verified/);
  assert.match(run.output, /written by the agent/);
  const calls = run.events.filter((e: { type: string }) => e.type === 'tool_started');
  assert.ok(calls.length >= 2);
  // What the agent wrote is what the Knowledge page browses.
  const notes = await ok(`${collectionsPath()}/agent_notes/documents`);
  assert.equal(notes.total, 1);
  assert.equal(notes.documents[0].note, 'written by the agent');
});

test('a harness runs the whole collection lifecycle through the MongoDB MCP tools', async () => {
  const tools = [
    'create-collection',
    'insert-many',
    'find',
    'update-many',
    'delete-many',
    'count',
    'drop-collection',
  ];
  const harness = await ok('/workflows', {
    name: 'MongoDB lifecycle harness',
    startAt: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'Start', next: 'agent' },
      {
        id: 'agent',
        type: 'agent',
        name: 'Collection keeper',
        prompt: '{{input}}',
        config: {
          name: 'Collection keeper',
          providerId,
          systemPrompt: 'Manage records in MongoDB collections.',
          maxTurns: 20,
          connections: [{ connectionId, tools }],
        },
        next: 'finish',
      },
      { id: 'finish', type: 'finish', name: 'Finish', template: '{{last}}' },
    ],
  });
  const started = await ok('/runs', { workflowId: harness.id, input: 'mongo harness lifecycle' });
  let run;
  for (let i = 0; i < 240; i++) {
    run = await ok(`/runs/${started.id}`);
    if (!['queued', 'running'].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(run.status, 'succeeded', run.error);
  assert.match(run.output, /Lifecycle complete after 8 MongoDB calls/);
  assert.deepEqual(
    run.events.filter((e: { type: string }) => e.type === 'tool_error'),
    [],
  );
  const results: { tool: string; result: string }[] = run.events
    .filter((e: { type: string }) => e.type === 'tool_completed')
    .map((e: { data: { tool: string; result: string } }) => e.data);
  assert.deepEqual(
    results.map((r) => r.tool),
    [
      'create-collection',
      'insert-many',
      'find',
      'update-many',
      'find',
      'delete-many',
      'count',
      'drop-collection',
    ],
  );
  const [created, inserted, read, updated, reread, deleted, counted, dropped] = results.map((r) => r.result);
  const database = (await ok(collectionsPath())).database;
  // Every call landed in the workspace database, never one the agent chose.
  assert.ok(created.includes(`created in database`) && created.includes(database), created);
  assert.match(inserted, /Inserted `1` document/);
  assert.match(read, /"status":"new"/);
  assert.match(updated, /Matched 1 document\(s\)\. Modified 1 document\(s\)/);
  assert.match(reread, /"status":"shipped"/);
  assert.match(reread, /"qty":3/);
  assert.match(deleted, /Deleted `1` document\(s\)/);
  assert.match(counted, /Found 0 documents/);
  assert.match(dropped, /Successfully dropped the requested collection/);
  const names = (await ok(collectionsPath())).collections.map((c: { name: string }) => c.name);
  assert.ok(!names.includes('harness_lifecycle'), 'the harness dropped its collection');
});

test('another workspace sees neither the connection nor the collections', async () => {
  const foreign = await request(collectionsPath(), { as: otherCookie });
  assert.equal(foreign.status, 404);
  const own = await request('/connections', {
    as: otherCookie,
    body: { name: 'Other MongoDB', kind: 'mongodb', builtIn: true, url: '' },
  });
  assert.equal(own.status, 201, JSON.stringify(own.data));
  const listed = await request(collectionsPath(own.data.id), { as: otherCookie });
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  assert.notEqual(listed.data.database, (await ok(collectionsPath())).database);
  assert.deepEqual(listed.data.collections, []);
});

test('dropping a collection removes it', async () => {
  await ok(`${collectionsPath()}/customers`, undefined, 'DELETE');
  const names = (await ok(collectionsPath())).collections.map((c: { name: string }) => c.name);
  assert.ok(!names.includes('customers'));
});
