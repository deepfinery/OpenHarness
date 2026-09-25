import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Learning from experience (#19): feedback and failures become lessons in the workspace's experience/ folder,
// and later runs recall the relevant lessons into their prompts.
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const suffix = randomUUID().slice(0, 8);
const admin = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
let cookie = '';
let provider: any, workspace: any, learning: any, failing: any, forgetful: any;

async function request(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  headers: Record<string, string> = {},
) {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {}
  return { status: response.status, data };
}
async function ok(path: string, body?: unknown, method?: string) {
  const r = await request(path, body, method);
  assert.ok(r.status < 300, `${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const finished = (id: string) =>
  until(
    () => ok(`/runs/${id}`),
    (r: any) => !['queued', 'running'].includes(r.status),
    'the run',
  );
const reflected = (id: string) =>
  until(
    () => ok(`/runs/${id}`),
    (r: any) => ['done', 'failed', 'skipped'].includes(r.reflection?.status),
    'the reflection',
  );
const agentNode = (next = 'finish') => ({
  id: 'agent',
  name: 'Writer',
  type: 'agent',
  prompt: '{{input}}',
  next,
  config: { name: 'Writer', providerId: provider.id, systemPrompt: 'Write useful summaries.' },
});
before(async () => {
  const status = await (await fetch(base + '/api/auth/status')).json();
  if (status.needsSetup) {
    const setupToken = (await readFile('.env', 'utf8'))
      .split('\n')
      .find((l) => l.startsWith('SETUP_TOKEN='))!
      .slice('SETUP_TOKEN='.length);
    await fetch(base + '/api/auth/setup', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...admin, name: 'Test Administrator', setupToken }),
    });
  }
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(admin),
  });
  assert.equal(login.status, 200, 'Could not sign in to the isolated stack');
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  provider = await ok('/providers', {
    name: `Learning model ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
    embeddingModel: 'test-embedding',
  });
  const connection = await ok('/connections', {
    name: `Learning tools ${suffix}`,
    url: 'http://fixtures:9090/mcp',
  });
  await ok(`/connections/${connection.id}/discover`, {});
  workspace = await ok('/knowledge', { name: `Learning workspace ${suffix}`, providerId: provider.id });
  const settings = { workspace: { knowledgeBaseId: workspace.id }, experience: { enabled: true } };
  learning = await ok('/workflows', {
    name: `Learning writer ${suffix}`,
    startAt: 'start',
    nodes: [
      { id: 'start', name: 'Start', type: 'start', next: 'agent' },
      agentNode(),
      { id: 'finish', name: 'Finish', type: 'finish', template: '{{last}}' },
    ],
    ...settings,
  });
  failing = await ok('/workflows', {
    name: `Failing writer ${suffix}`,
    startAt: 'start',
    nodes: [
      { id: 'start', name: 'Start', type: 'start', next: 'agent' },
      agentNode('broken'),
      {
        id: 'broken',
        name: 'Broken step',
        type: 'tool',
        connectionId: connection.id,
        tool: 'fail',
        arguments: {},
        next: 'finish',
      },
      { id: 'finish', name: 'Finish', type: 'finish', template: '{{last}}' },
    ],
    ...settings,
  });
  forgetful = await ok('/workflows', {
    name: `Forgetful writer ${suffix}`,
    startAt: 'start',
    nodes: [
      { id: 'start', name: 'Start', type: 'start', next: 'agent' },
      agentNode(),
      { id: 'finish', name: 'Finish', type: 'finish', template: '{{last}}' },
    ],
    workspace: { knowledgeBaseId: workspace.id },
  });
});

let rejected: any;
test('negative feedback becomes a lesson with provenance in experience/', async () => {
  const run = await ok('/runs', { workflowId: learning.id, input: 'Summarize the Q3 revenue report' });
  await finished(run.id);
  assert.equal((await request(`/runs/${run.id}/feedback`, { rating: 'meh' })).status, 400);
  const given = await ok(`/runs/${run.id}/feedback`, {
    rating: 'down',
    comment: 'Use bullet points, not paragraphs',
  });
  assert.equal(given.learning, true);
  rejected = await reflected(run.id);
  assert.equal(rejected.reflection.status, 'done', rejected.reflection.error);
  assert.equal(rejected.reflection.reason, 'feedback');
  assert.equal(rejected.feedback.rating, 'down');
  assert.match(
    rejected.reflection.lesson,
    /^Lesson: for requests like "Summarize the Q3 revenue report", avoid what the user rejected \(Use bullet points, not paragraphs\)/,
  );
  const note = (await ok(`/knowledge/${workspace.id}/documents`)).find(
    (d: any) => d.id === rejected.reflection.noteId,
  );
  assert.equal(note.folder, 'experience');
  assert.equal(note.meta.kind, 'experience');
  assert.equal(note.meta.run_id, run.id);
  assert.equal(note.meta.rating, 'down');
  assert.equal(note.meta.score, -1);
  assert.equal(note.meta.lesson, rejected.reflection.lesson);
});

test('later runs recall the relevant lessons into their prompts', async () => {
  await until(
    () => ok(`/knowledge/${workspace.id}/documents`),
    (docs: any[]) => docs.every((d) => d.status === 'ready'),
    'the lesson to be indexed',
  );
  const run = await ok('/runs', {
    workflowId: learning.id,
    input: 'what did we learn about the Q3 revenue report summary?',
  });
  const done = await finished(run.id);
  assert.equal(done.status, 'succeeded', done.error);
  assert.match(done.output, /^Recalled: - Lesson: for requests like "Summarize the Q3 revenue report"/);
  assert.match(done.output, /\(from negative feedback\)/);
  const recalled = done.events.find((e: any) => e.type === 'experience_recalled');
  assert.ok(recalled.data.notes.includes(rejected.reflection.noteId));
});

test('failures become lessons too, and approvals are recorded as positive lessons', async () => {
  const run = await ok('/runs', { workflowId: failing.id, input: 'Summarize the incident log' });
  const done = await finished(run.id);
  assert.equal(done.status, 'failed');
  const lesson = await reflected(run.id);
  assert.equal(lesson.reflection.reason, 'failure');
  assert.match(lesson.reflection.lesson, /check the failing step before relying on it/);

  const good = await ok('/runs', { workflowId: learning.id, input: 'Summarize the hiring plan' });
  await finished(good.id);
  await ok(`/runs/${good.id}/feedback`, { rating: 'up' });
  const approved = await reflected(good.id);
  assert.match(approved.reflection.lesson, /repeat the approach the user approved/);
  const note = (await ok(`/knowledge/${workspace.id}/documents`)).find(
    (d: any) => d.id === approved.reflection.noteId,
  );
  assert.equal(note.meta.score, 1);
});

test('feedback is kept without learning when the workflow does not learn', async () => {
  const run = await ok('/runs', { workflowId: forgetful.id, input: 'Summarize anything' });
  await finished(run.id);
  const given = await ok(`/runs/${run.id}/feedback`, { rating: 'down', comment: 'Too vague' });
  assert.equal(given.learning, false);
  const stored = await ok(`/runs/${run.id}`);
  assert.equal(stored.feedback.comment, 'Too vague');
  assert.equal(stored.reflection, undefined);
  const invalid = await request('/workflows', {
    name: `No workspace ${suffix}`,
    startAt: 'start',
    nodes: [
      { id: 'start', name: 'Start', type: 'start', next: 'finish' },
      { id: 'finish', name: 'Finish', type: 'finish' },
    ],
    experience: { enabled: true },
  });
  assert.equal(invalid.status, 400);
  assert.match(JSON.stringify(invalid.data), /needs a knowledge workspace/);
});

test('API keys rate their own runs, and experience exports as JSON Lines', async () => {
  const key = await ok('/integrations/tokens', {
    name: `Learning key ${suffix}`,
    workflowIds: [learning.id],
  });
  const auth = { Authorization: `Bearer ${key.token}`, Cookie: '' };
  const own = await request(
    '/runs',
    { workflowId: learning.id, input: 'Summarize the roadmap' },
    'POST',
    auth,
  );
  assert.equal(own.status, 202);
  await finished(own.data.id);
  assert.equal((await request(`/runs/${own.data.id}/feedback`, { rating: 'up' }, 'POST', auth)).status, 202);
  assert.equal((await request(`/runs/${rejected.id}/feedback`, { rating: 'up' }, 'POST', auth)).status, 404);

  const exported = await fetch(`${base}/api/workflows/${learning.id}/experience.jsonl`, {
    headers: { Cookie: cookie },
  });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type')!, /application\/x-ndjson/);
  const lines = (await exported.text())
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const row = lines.find((l) => l.run_id === rejected.id);
  assert.equal(row.feedback.rating, 'down');
  assert.equal(row.feedback.comment, 'Use bullet points, not paragraphs');
  assert.equal(row.lesson, rejected.reflection.lesson);
  assert.equal(row.input, 'Summarize the Q3 revenue report');
});
