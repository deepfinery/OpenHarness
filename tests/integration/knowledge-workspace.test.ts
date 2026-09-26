import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// The knowledge base as the source of truth (#24): agents write findings and decisions into workspace folders,
// search and read them selectively, and large tool results are offloaded instead of filling the context.
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const suffix = randomUUID().slice(0, 8);
const admin = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
let cookie = '';
let workspace: any, flow: any, plain: any;

async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined };
}
async function ok(path: string, body?: unknown, method?: string) {
  const r = await request(path, body, method);
  assert.ok(r.status < 300, `${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string) {
  for (let i = 0; i < 80; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
async function run(workflowId: string, input: string) {
  const accepted = await ok('/runs', { workflowId, input });
  const done = await until(
    () => ok(`/runs/${accepted.id}`),
    (r: any) => !['queued', 'running'].includes(r.status),
    'the run',
  );
  assert.equal(done.status, 'succeeded', done.error);
  return done;
}
const documents = () => ok(`/knowledge/${workspace.id}/documents`);
const content = async (id: string) => (await ok(`/documents/${id}/content`)).content as string;
const definition = (name: string, withWorkspace: boolean, connectionId: string, providerId: string) => ({
  name,
  startAt: 'start',
  nodes: [
    { id: 'start', name: 'Start', type: 'start', next: 'agent' },
    {
      id: 'agent',
      name: 'Researcher',
      type: 'agent',
      prompt: '{{input}}',
      next: 'finish',
      config: { name: 'Researcher', providerId, systemPrompt: 'Research carefully.' },
    },
    { id: 'finish', name: 'Finish', type: 'finish', template: '{{last}}' },
  ],
  resources: [{ id: 'tools', name: 'Tools', type: 'mcp', connectionId, tools: ['lookup', 'bigdata'] }],
  bindings: [{ agentNodeId: 'agent', resourceId: 'tools' }],
  ...(withWorkspace ? { workspace: { knowledgeBaseId: workspace.id } } : {}),
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
  const provider = await ok('/providers', {
    name: `Workspace model ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
    embeddingModel: 'test-embedding',
  });
  const connection = await ok('/connections', {
    name: `Workspace tools ${suffix}`,
    url: 'http://fixtures:9090/mcp',
  });
  await ok(`/connections/${connection.id}/discover`, {});
  workspace = await ok('/knowledge', { name: `Research workspace ${suffix}`, providerId: provider.id });
  flow = await ok('/workflows', definition(`Workspace research ${suffix}`, true, connection.id, provider.id));
  plain = await ok('/workflows', definition(`No workspace ${suffix}`, false, connection.id, provider.id));
});

let finding: any;
test('agents record findings and decisions as notes with provenance in per-kind folders', async () => {
  const first = await run(flow.id, 'Please record a finding about the sky');
  assert.ok(first.events.some((e: any) => e.type === 'knowledge_written'));
  const written = JSON.parse(first.output.replace(/^Tool completed: /, ''));
  assert.match(written.path, /^research\/Sky colour\.md$/);
  const second = await run(flow.id, 'Now record a decision about the palette');
  const decision = JSON.parse(second.output.replace(/^Tool completed: /, ''));
  assert.match(decision.path, /^decisions\//);
  const docs = await documents();
  finding = docs.find((d: any) => d.id === written.note_id);
  assert.equal(finding.folder, 'research');
  assert.equal(finding.meta.kind, 'finding');
  assert.equal(finding.meta.run_id, first.id);
  assert.equal(finding.meta.agent, 'Researcher');
  assert.deepEqual(finding.meta.sources, ['fixture://physics']);
  assert.equal(finding.meta.confidence, 0.9);
  const text = await content(finding.id);
  assert.match(
    text,
    /^---\n[\s\S]*kind: finding[\s\S]*---\n\n# Sky colour\n\nThe sky looks blue because of Rayleigh scattering/,
  );
  assert.match(await content(decision.note_id), /\*\*Reasons:\*\* It matches the sky finding/);
});

test('agents search the workspace for references and read only the part they need', async () => {
  await until(documents, (docs: any[]) => docs.every((d) => d.status === 'ready'), 'indexing');
  const searched = await run(flow.id, 'Please search the workspace for the sky colour');
  const hits = JSON.parse(searched.output.replace(/^Tool completed: /, ''));
  const hit = hits.find((h: any) => h.note_id === finding.id);
  assert.ok(hit, JSON.stringify(hits));
  assert.equal(hit.path, 'research/Sky colour.md');
  assert.equal(hit.kind, 'finding');
  assert.ok(hit.snippet.length <= 600);
  const read = await run(flow.id, `Please read note ${finding.id} for details`);
  const note = JSON.parse(read.output.replace(/^Tool completed: /, ''));
  assert.equal(note.note_id, finding.id);
  assert.match(note.content, /Rayleigh scattering/);
  assert.equal(note.offset, 0);
  assert.ok(note.total_chars > 0);
  const missing = await run(flow.id, `Please read note ${randomUUID()} too`);
  assert.match(missing.output, /Workspace error: No note/);
});

test('large tool results are saved as notes and summarised in the context', async () => {
  const offloaded = await run(flow.id, 'Please use big tool to fetch telemetry');
  assert.match(offloaded.output, /BIGDATA START/);
  assert.doesNotMatch(offloaded.output, /BIGDATA END/, 'the agent only sees the head of the result');
  const reference = /Task note ([0-9a-f-]{36}) \((task\/[^)]+)\)/.exec(offloaded.output);
  assert.ok(reference, offloaded.output.slice(-400));
  const saved = (await ok(`/runs/${offloaded.id}/memory`)).notes.find(
    (d: any) => d.note_id === reference![1],
  );
  assert.match(saved.path, /\/scratch\//);
  assert.equal(saved.kind, 'tool-result');
  let tail = await ok(`/runs/${offloaded.id}/memory/${saved.note_id}?offset=0&limit=8000`);
  let full = tail.content;
  while (tail.next_offset !== undefined) {
    tail = await ok(`/runs/${offloaded.id}/memory/${saved.note_id}?offset=${tail.next_offset}&limit=8000`);
    full += tail.content;
  }
  assert.match(full, /BIGDATA END/, 'the full result is kept in task memory');
  assert.ok(
    !(await documents()).some((d: any) => d.id === saved.note_id),
    'temporary telemetry is not indexed as long-term knowledge',
  );

  const edited = { ...flow, workspace: { knowledgeBaseId: workspace.id, offloadToolResults: false } };
  delete edited.id;
  await ok(`/workflows/${flow.id}`, edited, 'PUT');
  const inline = await run(flow.id, 'Please use big tool once more');
  assert.doesNotMatch(inline.output, /Task note/);
});

test('without a workspace, agents get no workspace tools', async () => {
  const out = await run(plain.id, 'Please record a finding about the sky');
  assert.equal(out.output, 'Completed: Please record a finding about the sky');
  assert.ok(!out.events.some((e: any) => e.type === 'knowledge_written'));
});

test('the workspace must be a knowledge base of this workspace, and notes accept folders', async () => {
  const bad = {
    ...definition(
      `Bad workspace ${suffix}`,
      false,
      flow.resources[0].connectionId,
      flow.nodes[1].config.providerId,
    ),
    workspace: { knowledgeBaseId: randomUUID() },
  };
  assert.equal((await request('/workflows', bad)).status, 400);
  const note = await ok(`/knowledge/${workspace.id}/notes`, {
    title: 'Weekly summary',
    content: 'All good.',
    folder: 'Reports/Weekly',
  });
  assert.equal(note.folder, 'reports/weekly');
});
