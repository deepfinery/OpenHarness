import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Budgeted sub-agents (#23): an agent spins up parallel sub-agents with fresh contexts and budget shares; they
// write to the knowledge workspace and report back summaries and note ids.
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const suffix = randomUUID().slice(0, 8);
const admin = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
let cookie = '';
let provider: any, workspace: any, skill: any;

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
async function run(workflowId: string, input: string) {
  const accepted = await ok('/runs', { workflowId, input });
  for (let i = 0; i < 160; i++) {
    const r = await ok(`/runs/${accepted.id}`);
    if (!['queued', 'running'].includes(r.status)) {
      assert.equal(r.status, 'succeeded', r.error);
      return r;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Run did not finish');
}
async function flow(name: string, agent: Record<string, unknown>, withWorkspace = true) {
  return ok('/workflows', {
    name: `${name} ${suffix}`,
    startAt: 'start',
    nodes: [
      { id: 'start', name: 'Start', type: 'start', next: 'lead' },
      {
        id: 'lead',
        name: 'Lead',
        type: 'agent',
        prompt: '{{input}}',
        next: 'finish',
        config: { name: 'Lead', providerId: provider.id, systemPrompt: 'Coordinate the research.', ...agent },
      },
      { id: 'finish', name: 'Finish', type: 'finish', template: '{{last}}' },
    ],
    ...(withWorkspace ? { workspace: { knowledgeBaseId: workspace.id } } : {}),
  });
}
const results = (output: string) => JSON.parse(output.replace(/^Tool completed: /, ''));
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
    name: `Delegation model ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
    embeddingModel: 'test-embedding',
  });
  workspace = await ok('/knowledge', { name: `Delegation workspace ${suffix}`, providerId: provider.id });
  skill = await ok('/skills', {
    name: `Report checklist ${suffix}`,
    description: 'Use when writing a report.',
    instructions: 'CHECKLIST: title, three findings, one recommendation.',
  });
});

test('an agent spins up parallel sub-agents that report summaries, notes and token use', async () => {
  const lead = await flow('Delegating lead', {
    delegation: { enabled: true, maxAgents: 4 },
    effort: 'medium',
  });
  const parent = await run(lead.id, 'Please research with sub-agents');
  const reports = results(parent.output);
  assert.equal(reports.length, 2);
  assert.ok(
    reports.every((r: any) => r.status === 'succeeded' && r.tokens_used > 0),
    JSON.stringify(reports),
  );
  const [sky, price] = reports;
  assert.equal(sky.notes.length, 2, 'workspace finding and automatic task report');
  assert.match(sky.notes[0].path, /^research\//);
  assert.match(sky.notes[1].path, /^task\//);
  assert.equal(price.summary, 'Completed: Sub-task: check the widget price list');

  const started = parent.events.filter((e: any) => e.type === 'subagent_started');
  const completed = parent.events.filter((e: any) => e.type === 'subagent_completed');
  assert.equal(started.length, 2);
  assert.equal(completed.length, 2);
  for (const e of started) {
    assert.equal(e.data.effort, 'light');
    assert.ok(e.data.tokenBudget > 0 && e.data.tokenBudget <= 30000, JSON.stringify(e.data));
  }
  // Each sub-agent is its own run, linked to the parent, with its own trace.
  const child = await ok(`/runs/${sky.subagent_id}`);
  assert.equal(child.parentRunId, parent.id);
  assert.equal(child.parentNodeId, 'lead');
  assert.equal(child.trigger, 'subagent');
  assert.equal(child.status, 'succeeded');
  assert.equal(child.tokensUsed, sky.tokens_used);
  assert.ok(child.events.some((e: any) => e.type === 'knowledge_written'));
  // The note was written by the sub-agent, into the shared workspace.
  const note = (await ok(`/knowledge/${workspace.id}/documents`)).find(
    (d: any) => d.id === sky.notes[0].note_id,
  );
  assert.equal(note.meta.run_id, sky.subagent_id);
  // Sub-agent tokens count against the parent.
  const lastModel = parent.events.filter((e: any) => e.type === 'model').at(-1);
  assert.ok(lastModel.data.tokensUsed >= sky.tokens_used + price.tokens_used, JSON.stringify(lastModel.data));
});

test('a sub-agent can follow one of the parent skills', async () => {
  const lead = await flow('Skilled lead', { delegation: { enabled: true }, skillIds: [skill.id] });
  const parent = await run(lead.id, 'Please delegate with a skill');
  const [report] = results(parent.output);
  assert.equal(report.summary, 'Following skill: CHECKLIST: title, three findings, one recommendation.');
  assert.equal(parent.events.find((e: any) => e.type === 'subagent_started').data.skill, skill.name);
});

test('sub-agents cannot start sub-agents of their own', async () => {
  const lead = await flow('Recursive lead', { delegation: { enabled: true } });
  const parent = await run(lead.id, 'Please delegate recursively');
  const [report] = results(parent.output);
  assert.equal(report.status, 'succeeded');
  const child = await ok(`/runs/${report.subagent_id}`);
  assert.equal(child.input, 'Sub-task: research with sub-agents one level deeper');
  assert.equal(report.summary, child.output);
  assert.equal(parent.events.filter((e: any) => e.type === 'subagent_started').length, 1);
  assert.ok(!child.events.some((e: any) => e.type === 'subagent_started'));
});

test('delegation respects the per-run limit and the remaining budget', async () => {
  const limited = await flow('Limited lead', { delegation: { enabled: true, maxAgents: 2 } });
  const crowd = await run(limited.id, 'Please delegate a crowd');
  assert.match(crowd.output, /Delegation error: This agent may start 2 sub-agents per run/);
  const tight = await flow('Tight lead', { delegation: { enabled: true }, tokenBudget: 5000 });
  const broke = await run(tight.id, 'Please research with sub-agents');
  assert.match(broke.output, /Delegation error: Not enough budget left for 2 sub-agents/);
  assert.ok(!broke.events.some((e: any) => e.type === 'subagent_started'));
});

test('agents without delegation are not offered the tool', async () => {
  const plain = await flow('Plain lead', {}, false);
  const out = await run(plain.id, 'Please research with sub-agents');
  assert.equal(out.output, 'Completed: Please research with sub-agents');
});
