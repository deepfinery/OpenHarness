import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { timeContext } from '../../packages/core/src/timeContext.js';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const fixture = process.env.TEST_FIXTURE_URL ?? 'http://localhost:19090';
let cookie = '';
let providerId = '';
let connectionId = '';
async function ok(path: string, body?: unknown) {
  const response = await fetch(base + '/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`);
  return result;
}
async function run(
  settings: Record<string, unknown>,
  input: string,
  history: unknown[] = [],
  workflowTimezone?: string,
  requestTimezone?: string,
) {
  const config = {
    name: 'Clock probe',
    providerId,
    systemPrompt: 'Research accurately.',
    tokenBudget: 200000,
    ...settings,
  };
  let target;
  if (workflowTimezone) {
    const workflow = await ok('/workflows', {
      name: 'Clock workflow',
      startAt: 'start',
      schedule: { enabled: false, everyMinutes: 1440, timezone: workflowTimezone },
      nodes: [
        { id: 'start', type: 'start', name: 'Start', next: 'agent' },
        { id: 'agent', type: 'agent', name: 'Research', prompt: '{{input}}', config, next: 'finish' },
        { id: 'finish', type: 'finish', name: 'Finish', template: '{{last}}' },
      ],
    });
    target = { workflowId: workflow.id };
  } else {
    const agent = await ok('/agents', config);
    target = { agentId: agent.id };
    assert.equal((await ok(`/agents/${agent.id}`)).timezone, settings.timezone);
  }
  const started = await ok('/runs', {
    ...target,
    input,
    history,
    ...(requestTimezone ? { timezone: requestTimezone } : {}),
  });
  for (let i = 0; i < 160; i++) {
    const result = await ok(`/runs/${started.id}`);
    if (!['queued', 'running'].includes(result.status)) {
      assert.equal(result.status, 'succeeded', result.error);
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Run did not finish');
}
before(async () => {
  const credentials = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
  if ((await ok('/auth/status')).needsSetup) {
    const setupToken = (await readFile('.env', 'utf8'))
      .split('\n')
      .find((line) => line.startsWith('SETUP_TOKEN='))!
      .slice(12);
    await ok('/auth/setup', { ...credentials, name: 'Test administrator', setupToken });
  }
  async function login(credentials: { email: string; password: string }) {
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie')!.split(';')[0];
  }
  await login(credentials);
  const isolated = { email: `clock-${randomUUID()}@openharness.test`, password: credentials.password };
  await ok('/users', { ...isolated, name: 'Clock regression', workspace: 'new' });
  await login(isolated);
  providerId = (
    await ok('/providers', {
      name: 'Clock fixture',
      kind: 'openai-compatible',
      baseUrl: 'http://fixtures:9090/v1',
      model: 'test-clock',
      contextWindow: 8192,
      maxOutputTokens: 1024,
    })
  ).id;
  connectionId = (await ok('/connections', { name: 'Search fixture', url: 'http://fixtures:9090/mcp' })).id;
  await ok(`/connections/${connectionId}/discover`, {});
});

const clocks = (r: any) => r.events.filter((e: any) => e.type === 'runtime_clock').map((e: any) => e.data);

test('server clock reaches the model despite stale history, survives compaction, and defaults to UTC', async () => {
  const before = Date.now();
  const result = await run({}, 'clock-probe: What happened last week?', [
    { role: 'user', content: 'What happened last week?' },
    { role: 'assistant', content: 'Last week: March 17–21, 2025. '.repeat(700) },
  ]);
  const clock = clocks(result)[0];
  assert.ok(Date.parse(clock.referenceTime) >= before && Date.parse(clock.referenceTime) <= Date.now());
  assert.deepEqual(clock, timeContext(clock.referenceTime));
  assert.equal(clock.fallback, true);
  const event = result.events.find((e: any) => e.type === 'runtime_clock');
  assert.match(
    event.message,
    /UTC default because neither the agent, the request nor a schedule set a timezone/,
  );
  assert.match(result.output, /\[Runtime clock\]/);
  assert.match(result.output, /No timezone was configured or sent with this request/);
  assert.ok(result.output.includes(clock.referenceTime));
  assert.ok(!result.output.includes('March 17'));
  assert.ok(result.events.some((e: any) => e.type === 'context_compacted'));
});

test('MCP search uses explicit dates and the same clock reaches the reserved final answer', async () => {
  const result = await run(
    { timezone: 'America/New_York', maxTurns: 1, connections: [{ connectionId, tools: ['lookup'] }] },
    'research-clock: What happened last week in stock markets?',
  );
  const clock = clocks(result)[0];
  assert.deepEqual(clock, timeContext(clock.referenceTime, 'America/New_York'));
  const search = result.events.find((e: any) => e.type === 'tool_started' && e.data?.tool === 'lookup');
  assert.ok(search, 'real MCP search ran');
  assert.ok(search.data.arguments.includes(clock.lastWeek.start));
  assert.ok(search.data.arguments.includes(clock.lastWeek.end));
  assert.match(result.output, /Final synthesis/);
  assert.ok(result.output.includes(clock.referenceTime));
  const stats = await (await fetch(fixture + '/stats')).json();
  const calls = stats.clockRequests.filter((r: any) => r.system.includes(clock.referenceTime));
  assert.ok(calls.some((r: any) => r.tools > 0));
  assert.ok(calls.some((r: any) => r.tools === 0));
  for (const call of calls) {
    assert.equal(call.system.split('[Runtime clock]').length, 2);
    assert.match(call.system, /Verify publication AND event dates/);
    assert.match(call.system, /date filters only as defined by the tool schema/);
    assert.match(call.system, /If current evidence is unavailable, say so/);
  }
});

test('subagents inherit the parent clock and timezone', async () => {
  const result = await run({ timezone: 'Asia/Kathmandu', delegation: { enabled: true } }, 'delegate-clock');
  const observed = clocks(result);
  const childId = result.events.find((e: any) => e.type === 'subagent_started')?.data.subagentId;
  assert.ok(childId);
  const child = await ok(`/runs/${childId}`);
  assert.equal(child.status, 'succeeded', child.error);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].timezone, 'Asia/Kathmandu');
  assert.deepEqual(observed[0], clocks(child)[0]);
  assert.ok(child.output.includes(observed[0].referenceTime));
});

test('the request timezone sets the clock unless the agent pins one, and beats a schedule timezone', async () => {
  const requested = await run({}, 'clock-probe', [], undefined, 'America/New_York');
  const clock = clocks(requested)[0];
  assert.deepEqual(clock, timeContext(clock.referenceTime, 'America/New_York'));
  assert.equal(clock.fallback, false);
  assert.ok(requested.output.includes('(America/New_York)'));
  assert.ok(!requested.output.includes('No timezone was configured'));
  assert.equal(requested.timezone, 'America/New_York');
  const pinned = await run({ timezone: 'Asia/Tokyo' }, 'clock-probe', [], undefined, 'America/New_York');
  assert.equal(clocks(pinned)[0].timezone, 'Asia/Tokyo');
  const scheduled = await run({}, 'clock-probe', [], 'Asia/Tokyo', 'America/New_York');
  assert.equal(clocks(scheduled)[0].timezone, 'America/New_York');
  const rejected = await fetch(base + '/api/runs', {
    method: 'POST',
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: requested.agentId, input: 'x', timezone: 'Mars/Olympus' }),
  });
  assert.equal(rejected.status, 400);
  assert.match(JSON.stringify(await rejected.json()), /Unknown time zone/);
});

test('Playground chat turns send the browser timezone to the run', async () => {
  const agent = await ok('/agents', { name: 'Chat clock', providerId, systemPrompt: 'Research accurately.' });
  const turn = await ok('/chat', { agentId: agent.id, message: 'clock-probe', timezone: 'Europe/Berlin' });
  let result;
  for (let i = 0; i < 160; i++) {
    result = await ok(`/runs/${turn.runId}`);
    if (!['queued', 'running'].includes(result.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(result.status, 'succeeded', result.error);
  assert.equal(result.timezone, 'Europe/Berlin');
  assert.equal(clocks(result)[0].timezone, 'Europe/Berlin');
  assert.ok(result.output.includes('(Europe/Berlin)'));
});

test('workflow schedule timezone is inherited unless the agent explicitly overrides it', async () => {
  for (const [settings, expected] of [
    [{}, 'Asia/Tokyo'],
    [{ timezone: 'UTC' }, 'UTC'],
  ] as const) {
    const result = await run(settings, 'clock-probe', [], 'Asia/Tokyo');
    assert.equal(clocks(result)[0].timezone, expected);
    assert.ok(result.output.includes(`(${expected})`));
  }
});

test('all reasoning patterns retain the clock when a tiny budget immediately reserves synthesis', async () => {
  for (const pattern of ['react', 'plan-execute', 'reflection', 'loop']) {
    const result = await run({ pattern, tokenBudget: 1000 }, 'clock-probe');
    assert.match(result.output, /Final synthesis/);
    assert.ok(result.output.includes(clocks(result)[0].referenceTime));
    assert.ok(result.events.some((e: any) => e.type === 'budget_exhausted'));
  }
});
