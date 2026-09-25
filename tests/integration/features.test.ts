import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { makeStarter } from '../../packages/core/src/starters.js';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const fixture = process.env.TEST_FIXTURE_URL ?? 'http://localhost:19090';
const suffix = randomUUID().slice(0, 8);
let cookie = '';
let provider: any, connection: any;
async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined, headers: response.headers };
}
async function ok(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const r = await request(path, method, body);
  assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
async function waitRun(id: string) {
  for (let i = 0; i < 120; i++) {
    const run = await ok(`/runs/${id}`);
    if (!['running', 'queued'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Run did not finish');
}
const stats = async () => (await (await fetch(`${fixture}/stats`)).json()) as any;
const admin = { email: 'admin@agentic.test', password: 'Integration-test-password-42' };
before(async () => {
  // This file sorts before stack.test.ts, so it may be the first to touch a fresh stack.
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
    name: `Streaming model ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
    embeddingModel: 'test-embedding',
  });
  connection = await ok('/connections', { name: `Feature MCP ${suffix}`, url: 'http://fixtures:9090/mcp' });
  await ok(`/connections/${connection.id}/discover`, {});
});
test('provider drafts can be tested before saving, including the embedding model', async () => {
  const result = await ok('/providers/test-config', {
    name: 'Draft',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
    embeddingModel: 'test-embedding',
  });
  assert.equal(result.chat.ok, true);
  assert.match(result.chat.text, /Completed/);
  assert.equal(result.embedding.ok, true);
  assert.equal(result.embedding.dimensions, 4);
  const broken = await ok('/providers/test-config', {
    name: 'Draft',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/missing',
    model: 'test-chat',
  });
  assert.equal(broken.chat.ok, false);
  assert.match(broken.chat.error, /HTTP 404/);
});
test('answers stream token by token and the run stream delivers events until completion', async () => {
  const before = (await stats()).streams ?? 0;
  const agent = await ok('/agents', {
    name: `Streamer ${suffix}`,
    providerId: provider.id,
    systemPrompt: 'Answer briefly.',
    connections: [{ connectionId: connection.id, tools: ['lookup'] }],
  });
  const run = await ok('/runs', { agentId: agent.id, input: 'Please use tool for streaming' });
  const response = await fetch(`${base}/api/runs/${run.id}/stream`, {
    headers: { Cookie: cookie, Origin: base },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const seen: any[] = [];
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const block of buffer.split('\n\n').slice(0, -1)) {
      const data = block.split('\n').find((l) => l.startsWith('data:'));
      if (data) seen.push(JSON.parse(data.slice(5)));
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
    if (seen.at(-1)?.status === 'succeeded') break;
  }
  assert.equal(seen.at(-1)?.status, 'succeeded', JSON.stringify(seen.at(-1)?.error));
  assert.ok(seen.length >= 2, 'the stream should deliver intermediate states');
  assert.match(seen.at(-1).output, /MCP lookup: orchestration test/);
  assert.ok(seen.at(-1).events.some((e: any) => e.type === 'tool_completed'));
  assert.ok(((await stats()).streams ?? 0) > before, 'the model request used streaming');
  const final = await ok(`/runs/${run.id}`);
  assert.equal(final.partial, undefined, 'streamed text is cleared once the answer is final');
});
test('agentic patterns run their passes and record them in the trace', async () => {
  const planner = await ok('/agents', {
    name: `Planner ${suffix}`,
    providerId: provider.id,
    systemPrompt: 'Plan then act.',
    pattern: 'plan-execute',
    patternConfig: { maxPlanSteps: 3 },
    connections: [{ connectionId: connection.id, tools: ['lookup'] }],
  });
  const planned = await waitRun((await ok('/runs', { agentId: planner.id, input: 'Prepare a briefing' })).id);
  assert.equal(planned.status, 'succeeded', planned.error);
  assert.match(planned.output, /Planned answer: Prepare a briefing/);
  assert.deepEqual(planned.events.find((e: any) => e.type === 'plan').data.steps.length, 2);
  assert.equal(planned.events.filter((e: any) => e.type === 'plan_step').length, 2);

  const writer = await ok('/agents', {
    name: `Writer ${suffix}`,
    providerId: provider.id,
    systemPrompt: 'Write well.',
    pattern: 'reflection',
    patternConfig: { reflections: 1 },
  });
  const reflected = await waitRun((await ok('/runs', { agentId: writer.id, input: 'Draft a note' })).id);
  assert.equal(reflected.status, 'succeeded', reflected.error);
  assert.equal(reflected.output, 'Revised answer with a source.');
  assert.equal(reflected.events.filter((e: any) => e.type === 'reflection').length, 1);

  const worker = await ok('/agents', {
    name: `Worker ${suffix}`,
    providerId: provider.id,
    systemPrompt: 'Work in loops.',
    pattern: 'loop',
    patternConfig: { iterations: 4, doneMarker: 'DONE' },
  });
  const looped = await waitRun((await ok('/runs', { agentId: worker.id, input: 'Finish the checklist' })).id);
  assert.equal(looped.status, 'succeeded', looped.error);
  assert.equal(looped.output, 'Finished the task.');
  assert.equal(looped.events.filter((e: any) => e.type === 'iteration').length, 2);
  assert.equal(
    (await request('/agents', 'POST', { ...planner, id: undefined, pattern: 'invented' })).status,
    400,
  );
});
test('multi-agent starters run end to end, passing results between agents', async () => {
  const team = await ok(
    '/workflows',
    makeStarter({ kind: 'team', providerId: provider.id, connectionId: connection.id, tools: ['lookup'] }),
  );
  const run = await waitRun((await ok('/runs', { workflowId: team.id, input: 'Compare two vendors' })).id);
  assert.equal(run.status, 'succeeded', run.error);
  assert.deepEqual(
    run.events.filter((e: any) => e.type === 'node_started').map((e: any) => e.nodeId),
    ['start', 'planner', 'researcher', 'writer', 'finish'],
  );
  assert.ok(run.events.some((e: any) => e.type === 'plan' && e.nodeId === 'researcher'));
  assert.ok(run.events.some((e: any) => e.type === 'reflection' && e.nodeId === 'writer'));
  const router = await ok('/workflows', makeStarter({ kind: 'router', providerId: provider.id }));
  const routed = await waitRun((await ok('/runs', { workflowId: router.id, input: 'pricing question' })).id);
  assert.equal(routed.status, 'succeeded', routed.error);
  assert.ok(routed.events.some((e: any) => e.type === 'node_started' && e.nodeId === 'route'));
});
test('email settings are workspace-scoped and the Email step sends through them', async () => {
  const initial = await ok('/settings/email');
  assert.equal(initial.hasPassword, false);
  const saved = await ok(
    '/settings/email',
    {
      host: 'fixtures',
      port: 587,
      secure: false,
      username: 'reports',
      password: 'secret-value',
      from: 'reports@example.com',
      enabled: true,
    },
    'PUT',
  );
  assert.equal(saved.source, 'workspace');
  assert.equal(saved.hasPassword, true);
  assert.equal(JSON.stringify(saved).includes('secret-value'), false);
  const kept = await ok('/settings/email', { ...saved, password: undefined }, 'PUT');
  assert.equal(kept.hasPassword, true, 'omitting the password keeps the saved one');
  const test = await ok('/settings/email/test', { to: 'someone@example.com' });
  assert.deepEqual(test.recipients, ['someone@example.com']);
  const flow = await ok(
    '/workflows',
    makeStarter({ kind: 'notify', providerId: provider.id, connectionId: connection.id, tools: ['lookup'] }),
  );
  const emailNode = flow.nodes.find((n: any) => n.type === 'email');
  emailNode.to = 'team@example.com, lead@example.com';
  await ok(`/workflows/${flow.id}`, flow, 'PUT');
  const run = await waitRun((await ok('/runs', { workflowId: flow.id, input: 'Weekly numbers' })).id);
  assert.equal(run.status, 'succeeded', run.error);
  assert.ok(run.events.some((e: any) => e.type === 'email_sent' && e.nodeId === 'email'));
  assert.deepEqual(run.outputs.email.recipients, ['team@example.com', 'lead@example.com']);
  assert.equal(run.outputs.email.subject, 'Report: Weekly numbers');
  emailNode.to = 'not-an-address';
  await ok(`/workflows/${flow.id}`, flow, 'PUT');
  const bad = await waitRun((await ok('/runs', { workflowId: flow.id, input: 'Weekly numbers' })).id);
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /Invalid email recipient/);
  assert.equal(
    (await request('/settings/email', 'PUT', { host: '169.254.169.254', from: 'a@b.co' })).status,
    400,
  );
  await ok('/settings/email', undefined, 'DELETE');
  assert.notEqual((await ok('/settings/email')).source, 'workspace');
});
test('conversations are listed per target for their owner and can be deleted', async () => {
  const agent = await ok('/agents', {
    name: `Chatty ${suffix}`,
    providerId: provider.id,
    systemPrompt: 'Chat.',
  });
  const first = await ok('/chat', { agentId: agent.id, message: 'First topic here' });
  await waitRun(first.id);
  const list = await ok(`/conversations?agentId=${agent.id}`);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, first.conversationId);
  assert.equal(list[0].title, 'First topic here');
  assert.equal(list[0].messageCount, 2);
  assert.equal((await ok('/conversations?workflowId=' + randomUUID())).length, 0);
  await ok(`/conversations/${first.conversationId}`, undefined, 'DELETE');
  assert.equal((await ok(`/conversations?agentId=${agent.id}`)).length, 0);
  assert.equal((await request(`/conversations/${first.conversationId}`)).status, 404);
});
