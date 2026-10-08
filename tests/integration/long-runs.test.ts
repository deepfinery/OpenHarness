import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Long jobs: limits set to 0 mean no limit, so an agent or a harness cycle runs until the work is done.
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const project = process.env.TEST_COMPOSE_PROJECT ?? '';
const command = promisify(execFile);
let cookie = '';
let providerId = '';
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
async function finished(id: string, timeoutMs = 300000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const run = await ok(`/runs/${id}`);
    if (!['queued', 'running'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Run did not finish');
}
const events = (run: any, type: string) => run.events.filter((e: any) => e.type === type);

before(async () => {
  const credentials = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
  if ((await ok('/auth/status')).needsSetup) {
    const setupToken = (await readFile('.env', 'utf8'))
      .split('\n')
      .find((line) => line.startsWith('SETUP_TOKEN='))!
      .slice(12);
    await ok('/auth/setup', { ...credentials, name: 'Test administrator', setupToken });
  }
  async function login(c: { email: string; password: string }) {
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify(c),
    });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie')!.split(';')[0];
  }
  await login(credentials);
  const isolated = { email: `long-runs-${randomUUID()}@openharness.test`, password: credentials.password };
  await ok('/users', { ...isolated, name: 'Long runs', workspace: 'new' });
  await login(isolated);
  providerId = (
    await ok('/providers', {
      name: 'Long-run fixture',
      kind: 'openai-compatible',
      baseUrl: 'http://fixtures:9090/v1',
      model: 'test-long-runs',
      contextWindow: 200000,
      maxOutputTokens: 1024,
    })
  ).id;
});

test('an agent with no turn, token or time limit keeps working past the old caps', async () => {
  // The fixture answers with a tool call 41 times before it finishes; a 12-turn agent would have stopped early.
  const unlimited = await ok('/agents', {
    name: 'Inspector',
    providerId,
    systemPrompt: 'Inspect everything.',
    effort: 'light',
    maxTurns: 0,
    tokenBudget: 0,
    timeoutSeconds: 0,
  });
  const saved = await ok(`/agents/${unlimited.id}`);
  assert.equal(saved.maxTurns, 0);
  assert.equal(saved.tokenBudget, 0);
  assert.equal(saved.timeoutSeconds, 0);
  const run = await finished((await ok('/runs', { agentId: unlimited.id, input: 'inspect past forty' })).id);
  assert.equal(run.status, 'succeeded', run.error);
  assert.match(run.output, /Completed 41 inspection turns/);
  assert.equal(events(run, 'tool_completed').length, 41);
  assert.deepEqual(events(run, 'turn_limit'), []);
  assert.deepEqual(events(run, 'budget_exhausted'), []);
  // The same work under the light preset is cut short, as before.
  const limited = await ok('/agents', {
    name: 'Light inspector',
    providerId,
    systemPrompt: 'Inspect.',
    effort: 'light',
  });
  const short = await finished((await ok('/runs', { agentId: limited.id, input: 'inspect past forty' })).id);
  assert.ok(events(short, 'turn_limit').length >= 1, 'the light preset still stops at its turn limit');
  assert.ok(events(short, 'tool_completed').length < 41);
});

test('the loop pattern with 0 iterations continues until the agent says it is done', async () => {
  const agent = await ok('/agents', {
    name: 'Looper',
    providerId,
    systemPrompt: 'Process every item.',
    pattern: 'loop',
    effort: 'medium',
    maxTurns: 0,
    tokenBudget: 0,
    timeoutSeconds: 0,
    patternConfig: { iterations: 0, doneMarker: 'DONE' },
  });
  // 25 iterations: more than twice the previous maximum of 10.
  const run = await finished((await ok('/runs', { agentId: agent.id, input: 'loop until iteration 25' })).id);
  assert.equal(run.status, 'succeeded', run.error);
  assert.equal(events(run, 'iteration').length, 25);
  assert.deepEqual(events(run, 'loop_limit'), []);
  assert.match(run.output, /Every item is done/);
  assert.ok(!/DONE\s*$/.test(run.output.trim()), 'the done marker is not part of the answer');
});

test('a harness cycle with step budget 0 runs well past 500 steps and stops at Finish', async () => {
  const token = randomUUID().slice(0, 8);
  const harness = await ok('/workflows', {
    name: 'Long cycle',
    startAt: 'start',
    maxSteps: 0,
    nodes: [
      { id: 'start', type: 'start', name: 'Start', next: 'worker' },
      {
        id: 'worker',
        type: 'agent',
        name: 'Worker',
        prompt: '{{input}}',
        config: { name: 'Worker', providerId, systemPrompt: 'Do one unit of work.', effort: 'light' },
        next: 'check',
      },
      {
        id: 'check',
        type: 'condition',
        name: 'Done?',
        value: '{{last}}',
        operator: 'contains',
        compare: 'DONE',
        onTrue: 'finish',
        onFalse: 'worker',
      },
      // The condition's own result is a boolean; the answer is the worker's last output.
      { id: 'finish', type: 'finish', name: 'Finish', template: '{{steps.worker}}' },
    ],
  });
  assert.equal(harness.maxSteps, 0);
  // 300 visits = 601 steps (start + 300 × agent + 300 × condition): beyond the previous cap of 500.
  const run = await finished(
    (await ok('/runs', { workflowId: harness.id, input: `cycle until 300 ${token}` })).id,
    900000,
  );
  assert.equal(run.status, 'succeeded', run.error);
  assert.match(run.output, /Visit 300: DONE/);
  assert.ok(run.checkpoint?.steps >= 601, `steps=${run.checkpoint?.steps}`);
  assert.equal(run.checkpoint?.nodeAttempts?.worker, 300);
});

test(
  'the broker waits far longer than 30 minutes for a run to be acknowledged',
  { skip: !project },
  async () => {
    const { stdout } = await command(
      'docker',
      [
        'compose',
        '-p',
        project,
        '-f',
        'compose.yaml',
        '-f',
        'tests/compose.test.yaml',
        'exec',
        '-T',
        'rabbitmq',
        'rabbitmqctl',
        'eval',
        'application:get_env(rabbit, consumer_timeout).',
      ],
      { timeout: 60000 },
    );
    assert.match(stdout, /\{ok,2592000000\}/, stdout);
  },
);
