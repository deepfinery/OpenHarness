import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Open Harness execution (issues #5 and #6): execute, stream with spec events, reattach with Last-Event-ID,
// cancel, result, tool calls and listing, against the real stack and the fixture model.
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const harness = `${base}/openharness/v1/harnesses/openharness`;
const suffix = randomUUID().slice(0, 8);
const admin = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
let cookie = '';
let provider: any, broken: any, connection: any, toolFlow: any, plainFlow: any;

const session = () => ({ Cookie: cookie, Origin: base });
async function call(
  url: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = session(),
) {
  const response = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined, headers: response.headers };
}
async function studio(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const r = await call(`${base}/api${path}`, method, body);
  assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
type Sse = { event: string; id: string; data: any };
/** Reads a whole SSE response (the adapter closes it after `done`). */
async function sse(
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      ...session(),
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  const events: Sse[] = [];
  for (const block of (await response.text()).split('\n\n')) {
    const lines = block.split('\n').filter((l) => l && !l.startsWith(':'));
    if (!lines.length) continue;
    const field = (name: string) =>
      lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2) ?? '';
    events.push({ event: field('event'), id: field('id'), data: JSON.parse(field('data')) });
  }
  return { events, executionId: response.headers.get('x-execution-id')! };
}
async function waitFor(id: string, statuses = ['completed', 'failed', 'cancelled']) {
  for (let i = 0; i < 120; i++) {
    const r = await call(`${harness}/executions/${id}`);
    if (statuses.includes(r.data.execution.status)) return r.data.execution;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Execution ${id} did not reach ${statuses.join('/')}`);
}
const agentWorkflow = (name: string, providerId: string, withTools: boolean) => ({
  name,
  startAt: 'start',
  nodes: [
    { id: 'start', name: 'Start', type: 'start', next: 'assistant' },
    {
      id: 'assistant',
      name: 'Assistant',
      type: 'agent',
      prompt: '{{input}}',
      next: 'finish',
      config: { name: 'Assistant', providerId, systemPrompt: 'Use tools when asked.' },
    },
    { id: 'finish', name: 'Finish', type: 'finish', template: '{{last}}' },
  ],
  ...(withTools
    ? {
        resources: [
          { id: 'tools', name: 'Tools', type: 'mcp', connectionId: connection.id, tools: ['lookup'] },
        ],
        bindings: [{ agentNodeId: 'assistant', resourceId: 'tools' }],
      }
    : {}),
});
before(async () => {
  const status = await (await fetch(base + '/api/auth/status')).json();
  if (status.needsSetup) {
    const setupToken = (await readFile('.env', 'utf8'))
      .split('\n')
      .find((l) => l.startsWith('SETUP_TOKEN='))!
      .slice('SETUP_TOKEN='.length);
    await call(
      `${base}/api/auth/setup`,
      'POST',
      { ...admin, name: 'Test Administrator', setupToken },
      { Origin: base },
    );
  }
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(admin),
  });
  assert.equal(login.status, 200, 'Could not sign in to the isolated stack');
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  provider = await studio('/providers', {
    name: `Execution model ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
  });
  broken = await studio('/providers', {
    name: `Broken model ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/missing/v1',
    model: `missing-${suffix}`,
  });
  connection = await studio('/connections', {
    name: `Execution MCP ${suffix}`,
    url: 'http://fixtures:9090/mcp',
  });
  await studio(`/connections/${connection.id}/discover`, {});
  toolFlow = await studio('/workflows', agentWorkflow(`OH tool agent ${suffix}`, provider.id, true));
  plainFlow = await studio('/workflows', agentWorkflow(`OH plain agent ${suffix}`, provider.id, false));
});

test('the manifest now reports execution and models as supported', async () => {
  const caps = (await call(`${harness}/capabilities`)).data.capabilities;
  assert.equal(caps.execution.supported, true);
  for (const op of ['sync', 'stream', 'cancel', 'tool-calls'])
    assert.ok(caps.execution.operations.includes(op), op);
  assert.ok(!caps.execution.operations.includes('artifacts'));
  assert.ok(caps.execution.limitations.length > 0);
  assert.deepEqual(caps.models.operations, ['multi-model', 'model-switch']);
});

test('execute accepts a task without an agent, runs it on the default agent and returns the result', async () => {
  const accepted = await call(`${harness}/execute`, 'POST', { message: `Hello harness ${suffix}` });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.data));
  assert.ok(accepted.data.execution_id);
  assert.ok(['pending', 'running'].includes(accepted.data.status));
  assert.equal(accepted.data.stream_url, `${harness}/executions/${accepted.data.execution_id}/stream`);
  const early = await call(`${harness}/executions/${accepted.data.execution_id}/result`);
  if (early.status !== 200) assert.equal(early.data.error.code, 'CONFLICT');
  const execution = await waitFor(accepted.data.execution_id);
  assert.equal(execution.status, 'completed', JSON.stringify(execution));
  assert.equal(execution.harness_id, 'openharness');
  assert.ok(execution.completed_at && execution.started_at);
  const { result } = (await call(`${harness}/executions/${execution.id}/result`)).data;
  assert.equal(result.output, `Completed: Hello harness ${suffix}`);
  assert.equal(result.status, 'completed');
  assert.ok(result.usage.total_tokens > 0);
  assert.deepEqual(result.tool_calls, []);
  // The same default agent is reused on the next request.
  const again = await call(`${harness}/execute`, 'POST', { message: 'Second default task' });
  const second = await waitFor(again.data.execution_id);
  assert.equal(second['x-openharness'].agent_id, execution['x-openharness'].agent_id);
});

test('execute/stream emits spec events: tool calls, results, progress, text and exactly one done', async () => {
  const { events, executionId } = await sse(`${harness}/execute/stream`, {
    method: 'POST',
    body: { message: 'Please use tool to look this up', agent_id: toolFlow.id },
  });
  assert.ok(executionId);
  const types = events.map((e) => e.event);
  assert.equal(types.filter((t) => t === 'done').length, 1);
  assert.equal(types.at(-1), 'done');
  assert.ok(!types.includes('error'), JSON.stringify(events.filter((e) => e.event === 'error')));
  const start = events.find((e) => e.event === 'tool_call_start')!;
  assert.equal(start.data.name, 'lookup');
  assert.deepEqual(start.data.input, { query: 'orchestration test' });
  const end = events.find((e) => e.event === 'tool_call_end')!;
  const result = events.find((e) => e.event === 'tool_result')!;
  assert.equal(end.data.id, start.data.id);
  assert.equal(result.data.id, start.data.id);
  assert.equal(result.data.success, true);
  assert.ok(types.indexOf('tool_call_start') < types.indexOf('tool_result'));
  const progress = events.filter((e) => e.event === 'progress');
  assert.ok(progress.length >= 2);
  assert.ok(progress.every((p) => p.data.total_steps === 2 && p.data.percentage <= 99));
  const text = events
    .filter((e) => e.event === 'text')
    .map((e) => e.data.content)
    .join('');
  const output = (await call(`${harness}/executions/${executionId}/result`)).data.result.output;
  assert.match(output, /MCP lookup/);
  assert.ok(text.endsWith(output), `streamed text ends with the answer: ${JSON.stringify(text)}`);
  const done = events.at(-1)!.data;
  assert.ok(done.usage.total_tokens > 0);
  assert.equal(done['x-openharness'].status, 'completed');
  // Ids are monotonic "<events>.<text>" cursors.
  for (const e of events) assert.match(e.id, /^\d+\.\d+$/);

  // Reattaching replays the log; Last-Event-ID resumes after the tool result without repeats.
  const replay = await sse(`${harness}/executions/${executionId}/stream`);
  assert.deepEqual(
    replay.events.filter((e) => e.event !== 'text').map((e) => [e.event, e.data]),
    events.filter((e) => e.event !== 'text').map((e) => [e.event, e.data]),
  );
  const resumed = await sse(`${harness}/executions/${executionId}/stream`, {
    headers: { 'Last-Event-ID': result.id },
  });
  assert.ok(!resumed.events.some((e) => e.event.startsWith('tool_call')));
  assert.equal(resumed.events.at(-1)!.event, 'done');

  const calls = (await call(`${harness}/executions/${executionId}/tool-calls`)).data.tool_calls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'lookup');
  assert.equal(calls[0].status, 'completed');
  assert.match(calls[0].output.content, /MCP lookup/);
  assert.ok(calls[0].started_at && calls[0].completed_at && calls[0].duration_ms >= 0);
  const summary = (await call(`${harness}/executions/${executionId}/result`)).data.result.tool_calls;
  assert.deepEqual(
    summary.map((c: any) => [c.name, c.success]),
    [['lookup', true]],
  );
});

test('a failed execution streams an error event before done', async () => {
  const { events } = await sse(`${harness}/execute/stream`, {
    method: 'POST',
    body: { message: 'This provider is broken', agent_id: plainFlow.id, model: broken.name },
  });
  assert.deepEqual(
    events.slice(-2).map((e) => e.event),
    ['error', 'done'],
  );
  assert.equal(events.at(-2)!.data.code, 'EXECUTION_FAILED');
  assert.equal(events.at(-2)!.data.recoverable, false);
  assert.equal(events.at(-1)!.data['x-openharness'].status, 'failed');
});

test('a running execution can be cancelled once; results wait for it to finish', async () => {
  const accepted = await call(`${harness}/execute`, 'POST', {
    message: 'Take your time: delay-model',
    agent_id: plainFlow.id,
  });
  const id = accepted.data.execution_id;
  await waitFor(id, ['running']);
  const running = await call(`${harness}/executions/${id}/result`);
  assert.equal(running.status, 409);
  assert.equal(running.data.error.code, 'CONFLICT');
  const cancel = await call(`${harness}/executions/${id}/cancel`, 'POST');
  assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
  assert.equal(cancel.data.cancelled, true);
  const done = await waitFor(id, ['cancelled']);
  assert.equal(done.status, 'cancelled');
  const again = await call(`${harness}/executions/${id}/cancel`, 'POST');
  assert.equal(again.status, 409);
  const { events } = await sse(`${harness}/executions/${id}/stream`);
  assert.equal(events.at(-2)!.data.code, 'EXECUTION_CANCELLED');
  assert.equal(events.at(-1)!.event, 'done');
});

test('executions are listed with status, agent and time filters and limit/offset pages', async () => {
  const since = new Date(Date.now() - 3600000).toISOString();
  const byAgent = await call(
    `${harness}/executions?agent_id=${toolFlow.id}&status=completed&since=${encodeURIComponent(since)}`,
  );
  assert.equal(byAgent.status, 200, JSON.stringify(byAgent.data));
  assert.ok(byAgent.data.total >= 1);
  assert.ok(
    byAgent.data.data.every(
      (e: any) => e['x-openharness'].agent_id === toolFlow.id && e.status === 'completed',
    ),
  );
  const pageOne = await call(`${harness}/executions?limit=1`);
  assert.equal(pageOne.data.data.length, 1);
  assert.equal(pageOne.data.has_more, pageOne.data.total > 1);
  const cancelled = await call(`${harness}/executions?status=cancelled`);
  assert.ok(cancelled.data.data.every((e: any) => e.status === 'cancelled'));
  const future = await call(
    `${harness}/executions?since=${encodeURIComponent(new Date(Date.now() + 86400000).toISOString())}`,
  );
  assert.equal(future.data.total, 0);
});

test('per-execution overrides and request validation follow the spec', async () => {
  const unknownModel = await call(`${harness}/execute`, 'POST', { message: 'x', model: 'no-such-model' });
  assert.equal(unknownModel.status, 400);
  assert.equal(unknownModel.data.error.code, 'model_not_available');
  assert.ok(unknownModel.data.error.details.available.includes('test-chat'));
  const tooLong = await call(`${harness}/execute`, 'POST', { message: 'x'.repeat(32001) });
  assert.equal(tooLong.data.error.code, 'context_length_exceeded');
  const withSession = await call(`${harness}/execute`, 'POST', { message: 'x', session_id: 'abc' });
  assert.equal(withSession.status, 501);
  assert.equal(withSession.data.error.domain, 'sessions');
  const unknownAgent = await call(`${harness}/execute`, 'POST', { message: 'x', agent_id: randomUUID() });
  assert.equal(unknownAgent.status, 404);
  const missing = await call(`${harness}/executions/${randomUUID()}`);
  assert.equal(missing.status, 404);

  const accepted = await call(`${harness}/execute`, 'POST', {
    message: 'Override check',
    agent_id: plainFlow.id,
    model: provider.name,
    system_prompt: 'Always be brief.',
  });
  await waitFor(accepted.data.execution_id);
  const run = await studio(`/runs/${accepted.data.execution_id}`);
  assert.deepEqual(run.overrides, { systemPrompt: 'Always be brief.', providerId: provider.id });
  assert.equal(run.trigger, 'api');
});

test('workflow keys execute only their workflow and see only their own executions', async () => {
  const scoped = await studio('/integrations/tokens', {
    name: `OH exec key ${suffix}`,
    workflowIds: [plainFlow.id],
  });
  const auth = { Authorization: `Bearer ${scoped.token}` };
  const own = await call(
    `${harness}/execute`,
    'POST',
    { message: 'Scoped task', agent_id: plainFlow.id },
    auth,
  );
  assert.equal(own.status, 202, JSON.stringify(own.data));
  const other = await call(`${harness}/execute`, 'POST', { message: 'x', agent_id: toolFlow.id }, auth);
  assert.equal(other.status, 403);
  const defaultAgent = await call(`${harness}/execute`, 'POST', { message: 'x' }, auth);
  assert.equal(defaultAgent.status, 403);
  const list = await call(`${harness}/executions`, 'GET', undefined, auth);
  assert.deepEqual(
    list.data.data.map((e: any) => e.id),
    [own.data.execution_id],
  );
  const all = await call(`${harness}/executions?limit=100`);
  const foreign = all.data.data.find((e: any) => e.id !== own.data.execution_id)!;
  assert.equal((await call(`${harness}/executions/${foreign.id}`, 'GET', undefined, auth)).status, 404);
  // The same execution is readable through the key that created it.
  await waitFor(own.data.execution_id);
  const result = await call(`${harness}/executions/${own.data.execution_id}/result`, 'GET', undefined, auth);
  assert.equal(result.data.result.output, 'Completed: Scoped task');
});
