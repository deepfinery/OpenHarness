import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const suffix = randomUUID().slice(0, 8);
let cookie = '';
let provider: any, kb: any, flow: any;
async function request(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  auth = cookie,
) {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: { Origin: base, Cookie: auth, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}
async function ok(path: string, body?: unknown, method?: string) {
  const r = await request(path, body, method);
  assert.ok(r.status < 300, `${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
async function run(input: string, target: Record<string, string> = { workflowId: flow.id }) {
  const started = await ok('/runs', { ...target, input });
  for (let i = 0; i < 180; i++) {
    const result = await ok(`/runs/${started.id}`);
    if (!['queued', 'running'].includes(result.status)) {
      assert.equal(result.status, 'succeeded', result.error);
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Run timed out');
}
before(async () => {
  const admin = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
  const status = await (await fetch(base + '/api/auth/status')).json();
  if (status.needsSetup) {
    const setupToken = (await readFile('.env', 'utf8'))
      .split('\n')
      .find((line) => line.startsWith('SETUP_TOKEN='))!
      .slice(12);
    await request('/auth/setup', { ...admin, name: 'Test administrator', setupToken });
  }
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(admin),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  provider = await ok('/providers', {
    name: `Memory model ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
    embeddingModel: 'test-embedding',
  });
  kb = await ok('/knowledge', { name: `Long-term memory ${suffix}`, providerId: provider.id });
  flow = await ok('/workflows', {
    name: `Task memory ${suffix}`,
    startAt: 'lead',
    nodes: [
      {
        id: 'lead',
        name: 'Lead',
        type: 'agent',
        config: {
          name: 'Lead',
          providerId: provider.id,
          systemPrompt: 'Coordinate analysis.',
          delegation: { enabled: true },
          maxTurns: 12,
          tokenBudget: 400000,
        },
      },
    ],
    workspace: { knowledgeBaseId: kb.id },
  });
});

test('task memory is immediately searchable and readable, isolated between queries, and promotable for future tasks', async () => {
  const first = await run('task notebook roundtrip');
  assert.match(first.output, /Read task evidence: immediate evidence/);
  const listing = await ok(`/runs/${first.id}/memory`);
  assert.equal(listing.notes.length, 1);
  assert.equal(listing.longTermAvailable, true);
  const note = listing.notes[0];
  const content = await ok(`/runs/${first.id}/memory/${note.note_id}`);
  assert.deepEqual(content.sources, ['fixture://evidence']);
  assert.ok(new Date(content.expires_at).getTime() > Date.now() + 6 * 86400000);
  assert.equal(
    (await ok(`/knowledge/${kb.id}/documents`)).filter((d: any) => d.meta?.record_type !== 'experiment')
      .length,
    0,
    'saving an unreviewed experiment does not promote temporary notes into verified findings',
  );
  assert.equal(
    (await ok(`/runs/${first.id}/memory?query=${encodeURIComponent('.*')}`)).notes.length,
    0,
    'search is literal, not a caller-controlled regex',
  );

  const second = await run(`read task note ${note.note_id}`);
  assert.match(second.output, /No note with this id in this task/);
  assert.equal((await request(`/runs/${second.id}/memory/${note.note_id}`)).status, 404);
  assert.equal((await request(`/runs/${second.id}/memory/${note.note_id}/promote`, {})).status, 404);
  assert.equal((await request(`/runs/${first.id}/memory`, undefined, 'GET', '')).status, 401);
  const email = `memory-other-${suffix}@openharness.test`;
  const password = 'Memory-other-password-42';
  await ok('/users', { name: 'Other memory tenant', email, password, workspace: 'new' });
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(login.status, 200);
  const otherCookie = login.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await request(`/runs/${first.id}/memory`, undefined, 'GET', otherCookie)).status, 404);
  assert.equal(
    (await request(`/runs/${first.id}/memory/${note.note_id}`, undefined, 'GET', otherCookie)).status,
    404,
  );
  assert.equal(
    (await request(`/runs/${first.id}/memory/${note.note_id}/promote`, {}, 'POST', otherCookie)).status,
    404,
  );

  const promoted = await ok(`/runs/${first.id}/memory/${note.note_id}/promote`, {});
  const stored = await ok(`/documents/${promoted.note_id}/content`);
  assert.match(stored.content, /immediate evidence/);
  assert.match(stored.content, new RegExp(`task_id: ${first.id}`));
  const later = await run(`Please read note ${promoted.note_id} for details`);
  assert.match(later.output, /immediate evidence/, 'a later query can read promoted knowledge');
  assert.equal(
    (await ok(`/runs/${later.id}/memory`)).notes.length,
    0,
    'the new query did not inherit the old task notebook',
  );
});

test('sub-agents share one task notebook and the parent reads beyond truncated summaries', async () => {
  const parent = await run('delegate task notebook');
  assert.match(parent.output, /REPORT TAIL VERIFIED/);
  const notes = (await ok(`/runs/${parent.id}/memory`)).notes;
  assert.equal(notes.filter((note: any) => note.kind === 'report').length, 2);
  assert.equal(notes.filter((note: any) => note.kind === 'finding').length, 1);
  const children = parent.events.filter((event: any) => event.type === 'subagent_started');
  assert.equal(children.length, 2);
  for (const event of children) {
    const child = await ok(`/runs/${event.data.subagentId}`);
    assert.equal(child.taskId, parent.id);
    assert.equal((await ok(`/runs/${child.id}/memory`)).notes.length, notes.length);
  }
  const paged = await ok(`/runs/${parent.id}/memory?limit=1`);
  assert.equal(paged.next_offset, 1);
  const page2 = await ok(`/runs/${parent.id}/memory?limit=1&offset=1`);
  assert.notEqual(paged.notes[0].note_id, page2.notes[0].note_id);
});

test('turn exhaustion performs one tool-free synthesis and retains the evidence', async () => {
  const agent = await ok('/agents', {
    name: `Limited ${suffix}`,
    providerId: provider.id,
    systemPrompt: 'Inspect carefully.',
    maxTurns: 2,
    tokenBudget: 100000,
  });
  const result = await run('exhaust analysis turns', { agentId: agent.id });
  assert.match(result.output, /Partial assessment.*incomplete/);
  assert.equal(result.events.filter((e: any) => e.type === 'model').length, 3);
  assert.equal(result.events.filter((e: any) => e.type === 'turn_limit').length, 1);
  assert.equal((await ok(`/runs/${result.id}/memory`)).notes.length, 2);
  const refused = await run('exhaust analysis turns ignore synthesis', { agentId: agent.id });
  assert.match(refused.output, /assessment is incomplete/);
  assert.equal(
    (await ok(`/runs/${refused.id}/memory`)).notes.length,
    2,
    'tool requests on the final synthesis turn never dispatch',
  );
});

test('extended limits allow more than forty analysis turns', async () => {
  const agent = await ok('/agents', {
    name: `Extended ${suffix}`,
    providerId: provider.id,
    systemPrompt: 'Inspect carefully.',
    maxTurns: 45,
    timeoutSeconds: 3600,
    tokenBudget: 1000000,
  });
  const result = await run('inspect past forty', { agentId: agent.id });
  assert.match(result.output, /Completed 41 inspection turns/);
  assert.equal(result.events.filter((e: any) => e.type === 'model').length, 42);
  assert.ok(!result.events.some((e: any) => e.type === 'turn_limit'));
});

test(
  'task storage handles concurrent writers and enforces expiry before TTL cleanup',
  { skip: !process.env.TEST_COMPOSE_PROJECT },
  async () => {
    const project = process.env.TEST_COMPOSE_PROJECT!;
    assert.match(project, /^openharness-test-/);
    const script = `
    import assert from 'node:assert/strict';
    import { randomUUID } from 'node:crypto';
    import { collection, mongo } from './dist/packages/core/src/db.js';
    import { writeTaskNote, readTaskNote, searchTaskNotes } from './dist/packages/core/src/memory.js';
    const scope = { ownerId: randomUUID(), taskId: randomUUID() };
    try {
      const notes = await Promise.all(Array.from({length: 12}, (_, n) => writeTaskNote(scope, {runId: String(n), agent: 'Parallel', title: 'Same title', content: 'independent ' + n})));
      assert.equal(new Set(notes.map(n => n.note_id)).size, 12);
      assert.equal((await searchTaskNotes(scope, {limit: 50})).notes.length, 12);
      assert.equal((await searchTaskNotes({...scope, ownerId: randomUUID()})).notes.length, 0);
      await collection('task_notes').updateMany(scope, {$set:{expiresAt: new Date(0)}});
      assert.equal((await searchTaskNotes(scope)).notes.length, 0);
      assert.equal(await readTaskNote(scope, notes[0].note_id), undefined);
      const indexes = await collection('task_notes').indexes();
      assert.ok(indexes.some(i => i.key.expiresAt === 1 && i.expireAfterSeconds === 0));
    } finally { await collection('task_notes').deleteMany(scope); await mongo.close(); }
  `;
    await promisify(execFile)('docker', [
      'compose',
      '-p',
      project,
      '-f',
      'compose.yaml',
      '-f',
      'tests/compose.test.yaml',
      'exec',
      '-T',
      'runner',
      'node',
      '--input-type=module',
      '-e',
      script,
    ]);
  },
);
