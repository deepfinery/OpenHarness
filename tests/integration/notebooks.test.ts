import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const suffix = randomUUID().slice(0, 8);
let cookie = '',
  provider: any,
  notebook: any,
  other: any;
async function request(path: string, body?: unknown) {
  const response = await fetch(base + '/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
}
async function ok(path: string, body?: unknown) {
  const result = await request(path, body);
  assert.ok(result.status < 300, `${path}: ${JSON.stringify(result)}`);
  return result.data;
}
async function until(path: string, ready: (value: any) => boolean) {
  for (let i = 0; i < 160; i++) {
    const value = await ok(path);
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${path}`);
}
async function run(target: Record<string, string>, input: string, history: unknown[] = []) {
  const started = await ok('/runs', { ...target, input, history });
  const finished = await until(`/runs/${started.id}`, (r) => !['running', 'queued'].includes(r.status));
  assert.equal(finished.status, 'succeeded', finished.error);
  return finished;
}
const agent = (patch: Record<string, unknown> = {}) =>
  ok('/agents', {
    name: `Notebook ${suffix}`,
    providerId: provider.id,
    systemPrompt: 'Use your notebooks and cite evidence.',
    knowledgeBaseIds: [notebook.id],
    ...patch,
  });
before(async () => {
  const credentials = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
  if ((await ok('/auth/status')).needsSetup) {
    const setupToken = (await readFile('.env', 'utf8'))
      .split('\n')
      .find((line) => line.startsWith('SETUP_TOKEN='))!
      .slice(12);
    await ok('/auth/setup', { ...credentials, name: 'Administrator', setupToken });
  }
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  // A separate tenant keeps this regression suite within the normal per-tenant submission limits.
  const isolated = {
    email: `notebook-regression-${randomUUID()}@openharness.test`,
    password: credentials.password,
  };
  await ok('/users', { ...isolated, name: 'Regression user', workspace: 'new' });
  const session = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(isolated),
  });
  assert.equal(session.status, 200);
  cookie = session.headers.get('set-cookie')!.split(';')[0];

  provider = await ok('/providers', {
    name: `Notebook model ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
    embeddingModel: 'test-embedding',
  });
  notebook = await ok('/knowledge', { name: `Cedar notebook ${suffix}`, providerId: provider.id });
  other = await ok('/knowledge', { name: `Other notebook ${suffix}`, providerId: provider.id });
});

test('a plain knowledge attachment supports notebook write/read/search and future recall', async () => {
  const a = await agent();
  const first = await run({ agentId: a.id }, 'notebook environment roundtrip');
  assert.match(first.output, /cedar notebook: deployment requires three health checks/);
  assert.ok(first.events.some((e: any) => e.type === 'knowledge_written'));
  const notes = await ok(`/knowledge/${notebook.id}/documents`);
  const note = notes.find((n: any) => n.meta?.kind === 'environment');
  assert.equal(note.folder, 'environment');
  const text = await ok(`/documents/${note.id}/content`);
  assert.match(text.content, /fixture:\/\/cedar/);
  const second = await run({ agentId: a.id }, 'cedar notebook deployment health checks');
  assert.match(second.output, /three health checks/);
  assert.ok(second.events.some((e: any) => e.type === 'memory_recalled'));
  assert.equal((await ok(`/runs/${second.id}/memory`)).longTermAvailable, true);
});

test('loaded skills can save durable conversation notes and auto records preserve conversation context', async () => {
  const skill = await ok('/skills', {
    name: `Notebook rule ${suffix}`,
    description: 'Use for notebook skill record.',
    instructions: 'NOTEBOOK_RULE: Save user preferences in the persistent notebook using kb_write.',
  });
  const a = await agent({ skillIds: [skill.id] });
  const first = await run({ agentId: a.id }, 'notebook skill record', [
    { role: 'user', content: 'Use confidence levels in future reports.' },
    { role: 'assistant', content: 'I will include confidence levels.' },
  ]);
  assert.match(first.output, /Skill note saved/);
  assert.ok(first.events.some((e: any) => e.type === 'skill_loaded'));
  const docs = await ok(`/knowledge/${notebook.id}/documents`);
  const note = docs.find((d: any) => d.meta?.run_id === first.id && d.meta?.kind === 'conversation');
  assert.equal(note.folder, 'conversations');
  assert.match(
    (await ok(`/documents/${note.id}/content`)).content,
    /include confidence and evidence sources/,
  );
  const memory = await until(`/runs/${first.id}/memory`, (m) => m.experiments.length === 1);
  assert.match(
    (await ok(`/documents/${memory.experiments[0].id}/content`)).content,
    /Use confidence levels in future reports/,
  );
});

test('writes can choose an attached notebook but cannot escape their attachment grants', async () => {
  const a = await agent({ knowledgeBaseIds: [notebook.id, other.id] });
  const chosen = await run({ agentId: a.id }, `write notebook ${other.id}`);
  assert.match(chosen.output, /note_id/);
  assert.ok(
    (await ok(`/knowledge/${other.id}/documents`)).some(
      (d: any) => d.meta?.run_id === chosen.id && d.meta?.kind === 'environment',
    ),
  );
  const restricted = await agent();
  const denied = await run({ agentId: restricted.id }, `write notebook ${other.id}`);
  assert.match(denied.output, /Choose a notebook attached to this agent/);
  assert.ok(!denied.events.some((e: any) => e.type === 'knowledge_written'));
});

test('resource-edge notebooks save experiments, learn from feedback, and support promotion', async () => {
  const flow = await ok('/workflows', {
    name: `Bound notebook ${suffix}`,
    startAt: 'worker',
    nodes: [
      {
        id: 'worker',
        name: 'Worker',
        type: 'agent',
        config: {
          name: 'Worker',
          providerId: provider.id,
          systemPrompt: 'Use your notebook.',
          experience: { enabled: true },
        },
      },
    ],
    resources: [{ id: 'book', name: 'Notebook', type: 'knowledge', knowledgeBaseId: notebook.id }],
    bindings: [{ resourceId: 'book', agentNodeId: 'worker' }],
  });
  const first = await run({ workflowId: flow.id }, 'Summarize the cedar deployment experiment');
  const memory = await until(`/runs/${first.id}/memory`, (m) => m.experiments.length === 1);
  assert.equal(memory.longTermAvailable, true);
  assert.equal(memory.learning, true);
  assert.deepEqual(memory.notebookIds, [notebook.id]);
  assert.equal(
    (await ok(`/runs/${first.id}/feedback`, { rating: 'down', comment: 'Include a rollback check' }))
      .learning,
    true,
  );
  const reflected = await until(`/runs/${first.id}`, (r) =>
    ['done', 'failed'].includes(r.reflection?.status),
  );
  assert.equal(reflected.reflection.status, 'done', reflected.reflection.error);
  const next = await run({ workflowId: flow.id }, 'what did we learn about the cedar deployment experiment?');
  assert.match(next.output, /Include a rollback check/);
  const temporary = await run({ workflowId: flow.id }, 'task notebook roundtrip');
  const notes = (await ok(`/runs/${temporary.id}/memory`)).notes;
  const promoted = await ok(`/runs/${temporary.id}/memory/${notes[0].note_id}/promote`, {});
  assert.ok(
    (await ok(`/knowledge/${notebook.id}/documents`)).some((doc: any) => doc.id === promoted.note_id),
  );
});

test('legacy saved-agent workflow references retain their own notebook after the run', async () => {
  const a = await agent();
  const flow = await ok('/workflows', {
    name: `Legacy notebook ${suffix}`,
    startAt: 'parallel',
    nodes: [{ id: 'parallel', name: 'Parallel', type: 'parallel', agentIds: [a.id] }],
  });
  const result = await run({ workflowId: flow.id }, 'notebook environment roundtrip');
  const memory = await until(`/runs/${result.id}/memory`, (m) => m.experiments.length === 1);
  assert.equal(memory.learning, true);
  assert.deepEqual(memory.notebookIds, [notebook.id]);
});

test('sub-agents inherit a dedicated agent notebook without a workflow workspace', async () => {
  const a = await agent({
    workspace: { knowledgeBaseId: notebook.id },
    knowledgeBaseIds: [],
    delegation: { enabled: true },
    tokenBudget: 200000,
  });
  const result = await run({ agentId: a.id }, 'Please research with sub-agents');
  const children = result.events.filter((e: any) => e.type === 'subagent_started');
  assert.equal(children.length, 2);
  const child = await ok(`/runs/${children[0].data.subagentId}`);
  assert.equal(child.status, 'succeeded', child.error);
  assert.ok(child.events.some((e: any) => e.type === 'knowledge_written'));
});

test(
  'attached notebooks work with the vector store offline',
  { skip: process.env.TEST_FAULT_INJECTION !== 'true' },
  async () => {
    const project = process.env.TEST_COMPOSE_PROJECT ?? '';
    assert.match(project, /^openharness-test-/);
    const compose = (...args: string[]) =>
      promisify(execFile)(
        'docker',
        ['compose', '-p', project, '-f', 'compose.yaml', '-f', 'tests/compose.test.yaml', ...args],
        { timeout: 60000 },
      );
    const a = await agent();
    try {
      await compose('stop', 'weaviate');
      const result = await run({ agentId: a.id }, 'notebook environment roundtrip');
      assert.match(result.output, /three health checks/);
      const next = await run({ agentId: a.id }, 'cedar notebook health checks');
      assert.match(next.output, /three health checks/);
    } finally {
      await compose('start', 'weaviate');
    }
  },
);
