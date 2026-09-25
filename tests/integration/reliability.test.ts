import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { makeStarter } from '../../packages/core/src/starters.js';

const enabled = process.env.TEST_FAULT_INJECTION === 'true';
const project = process.env.TEST_COMPOSE_PROJECT ?? 'agentic-orchestration-test';
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const fixture = process.env.TEST_FIXTURE_URL ?? 'http://localhost:19090';
const command = promisify(execFile);
let cookie = '';
let agentId = '';
let workflowId = '';
let providerId = '';
let connectionId = '';
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function compose(...args: string[]) {
  if (!project.startsWith('agentic-test-') && project !== 'agentic-orchestration-test')
    throw new Error('Fault injection is restricted to isolated agentic test projects');
  await command(
    'docker',
    ['compose', '-p', project, '-f', 'compose.yaml', '-f', 'tests/compose.test.yaml', ...args],
    { timeout: 60000 },
  );
}
async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(base + '/api' + path, {
    method,
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(25000),
  });
  const data = await r.json();
  assert.ok(r.ok, `${path}: ${r.status} ${JSON.stringify(data)}`);
  return data as any;
}
async function until<T>(get: () => Promise<T>, check: (v: T) => boolean, timeout = 90000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await get();
    if (check(result)) return result;
    await pause(1000);
  }
  throw new Error('Condition was not reached in time');
}
before(async () => {
  if (!enabled) return;
  const admin = { email: 'admin@agentic.test', password: 'Integration-test-password-42' };
  const status = await request('/auth/status');
  if (status.needsSetup) {
    const setupToken = (await readFile('.env', 'utf8'))
      .split('\n')
      .find((l) => l.startsWith('SETUP_TOKEN='))!
      .slice(12);
    await request('/auth/setup', { ...admin, name: 'Test Administrator', setupToken });
  }
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(admin),
  });
  assert.ok(login.ok);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  const provider = await request('/providers', {
    name: `Recovery provider ${randomUUID().slice(0, 6)}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
  });
  providerId = provider.id;
  const agent = await request('/agents', {
    name: 'Recovery agent',
    providerId: provider.id,
    systemPrompt: 'Answer accurately.',
    maxTurns: 4,
  });
  agentId = agent.id;
  const c = await request('/connections', { name: 'Recovery MCP', url: 'http://fixtures:9090/mcp' });
  connectionId = c.id;
  await request(`/connections/${c.id}/discover`, {});
  const flow = await request('/workflows', {
    name: 'Interrupted MCP call',
    startAt: 'tool',
    nodes: [
      {
        id: 'tool',
        name: 'Slow MCP call',
        type: 'tool',
        connectionId: c.id,
        tool: 'lookup',
        arguments: { query: 'slow operation' },
      },
    ],
  });
  workflowId = flow.id;
});
test(
  'durable outbox delivers runs accepted during a RabbitMQ outage',
  { skip: !enabled, timeout: 180000 },
  async () => {
    let id = '';
    try {
      await compose('stop', 'rabbitmq');
      const run = await request('/runs', { agentId, input: 'Accepted while the broker is offline' });
      id = run.id;
      assert.equal(run.status, 'queued');
    } finally {
      await compose('start', 'rabbitmq');
    }
    await compose('up', '-d', 'runner');
    const result = await until(
      () => request(`/runs/${id}`),
      (r) => ['succeeded', 'failed'].includes(r.status),
    );
    assert.equal(result.status, 'succeeded', result.error);
    assert.match(result.output, /broker is offline/);
  },
);
test(
  'forced runner interruption never silently repeats a tool side effect',
  { skip: !enabled, timeout: 120000 },
  async () => {
    const previous = ((await (await fetch(fixture + '/stats')).json()) as any).tools;
    const run = await request('/runs', { workflowId, input: 'Start the slow tool' });
    await until(
      async () => ((await (await fetch(fixture + '/stats')).json()) as any).tools,
      (n) => n === previous + 1,
      20000,
    );
    try {
      await compose('kill', '-s', 'SIGKILL', 'runner');
    } finally {
      await compose('up', '-d', 'runner');
    }
    const result = await until(
      () => request(`/runs/${run.id}`),
      (r) => r.status === 'interrupted',
      60000,
    );
    assert.match(result.error, /external tool may already have acted/);
    assert.equal(((await (await fetch(fixture + '/stats')).json()) as any).tools, previous + 1);
    const next = await request('/runs', { agentId, input: 'A new run after recovery' });
    assert.equal(
      (
        await until(
          () => request(`/runs/${next.id}`),
          (r) => ['succeeded', 'failed'].includes(r.status),
        )
      ).status,
      'succeeded',
    );
  },
);
test(
  'a run without external side effects resumes on a replacement runner after a crash',
  { skip: !enabled, timeout: 150000 },
  async () => {
    const before = ((await (await fetch(fixture + '/stats')).json()) as any).models;
    // No tools: the agent only talks to the model, so resuming is safe by the default policy.
    const agent = await request('/agents', {
      name: 'Resumable agent',
      providerId,
      systemPrompt: 'Answer accurately.',
    });
    const run = await request('/runs', { agentId: agent.id, input: 'Resume after delay-model' });
    await until(
      async () => ((await (await fetch(fixture + '/stats')).json()) as any).models,
      (n) => n > before,
      30000,
    );
    try {
      await compose('kill', '-s', 'SIGKILL', 'runner');
    } finally {
      await compose('up', '-d', 'runner');
    }
    const result = await until(
      () => request(`/runs/${run.id}`),
      (r) => ['succeeded', 'failed', 'interrupted'].includes(r.status),
      120000,
    );
    assert.equal(result.status, 'succeeded', result.error);
    assert.equal(result.resumeCount, 1);
    assert.ok(result.events.some((e: any) => e.type === 'resumed'));
    assert.match(result.output, /Resume after delay-model/);
  },
);
test(
  'scheduled workflows persist and dispatch a run without browser activity',
  { skip: !enabled, timeout: 30000 },
  async () => {
    const w = await request('/workflows', {
      name: `Scheduled ${randomUUID().slice(0, 6)}`,
      startAt: 'answer',
      nodes: [{ id: 'answer', type: 'output', name: 'Answer', template: '{{input}}' }],
      schedule: { enabled: true, everyMinutes: 60, input: 'Scheduled task input' },
    });
    try {
      const runs = await until(
        () => request('/runs'),
        (r) => r.some((run: any) => run.workflowId === w.id),
      );
      const run = runs.find((r: any) => r.workflowId === w.id);
      const result = await until(
        () => request(`/runs/${run.id}`),
        (r) => r.status === 'succeeded',
      );
      assert.equal(result.output, 'Scheduled task input');
    } finally {
      await fetch(base + `/api/workflows/${w.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie, Origin: base },
      });
    }
  },
);

test(
  'an unavailable scheduled agent does not block other workflows',
  { skip: !enabled, timeout: 30000 },
  async () => {
    const originalAgent = await request(`/agents/${agentId}`);
    const workflows: string[] = [];
    try {
      await request(`/agents/${agentId}`, { ...originalAgent, enabled: false }, 'PUT');
      const unavailable = await request('/workflows', {
        name: 'Schedule with a disabled agent',
        startAt: 'agent',
        nodes: [{ id: 'agent', type: 'agent', name: 'Disabled agent', agentId, prompt: '{{input}}' }],
        schedule: { enabled: true, everyMinutes: 60, input: 'Wait for an enabled agent' },
      });
      workflows.push(unavailable.id);
      const healthy = await request('/workflows', {
        name: 'Independent healthy schedule',
        startAt: 'output',
        nodes: [{ id: 'output', type: 'output', name: 'Output', template: '{{input}}' }],
        schedule: { enabled: true, everyMinutes: 60, input: 'Schedules remain independent' },
      });
      workflows.push(healthy.id);
      const failedSchedule = await until(
        () => request(`/workflows/${unavailable.id}`),
        (w) => Boolean(w.lastScheduleError),
        15000,
      );
      assert.match(failedSchedule.lastScheduleError, /missing or disabled/);
      assert.ok(new Date(failedSchedule.nextRunAt).getTime() > Date.now());
      const runs = await until(
        () => request('/runs'),
        (r) => r.some((run: any) => run.workflowId === healthy.id && run.status === 'succeeded'),
        15000,
      );
      const result = await request(`/runs/${runs.find((r: any) => r.workflowId === healthy.id).id}`);
      assert.equal(result.output, 'Schedules remain independent');
    } finally {
      for (const id of workflows) {
        await fetch(base + `/api/workflows/${id}`, {
          method: 'DELETE',
          headers: { Cookie: cookie, Origin: base },
        });
      }
      await request(`/agents/${agentId}`, originalAgent, 'PUT');
    }
  },
);

test(
  'queued conversation keeps its harness and tool grants when teammates edit the workflow',
  { skip: !enabled, timeout: 120000 },
  async () => {
    const flow = await request(
      '/workflows',
      makeStarter({
        kind: 'mcp',
        providerId,
        connectionId,
        tools: ['lookup'],
        name: 'Queued harness snapshot',
      }),
    );
    let accepted: any;
    try {
      await compose('stop', 'runner');
      accepted = await request('/chat', {
        workflowId: flow.id,
        message: 'Please use tool from the accepted snapshot',
      });
      assert.equal(accepted.status, 'queued');
      const changed = structuredClone(flow);
      changed.resources = [];
      changed.bindings = [];
      changed.nodes.find((n: any) => n.type === 'finish').template = 'Workflow edited after submission';
      await request(`/workflows/${flow.id}`, changed, 'PUT');
    } finally {
      await compose('up', '-d', 'runner');
    }
    const run = await until(
      () => request(`/runs/${accepted.id}`),
      (r) => ['succeeded', 'failed'].includes(r.status),
    );
    assert.equal(run.status, 'succeeded', run.error);
    assert.match(run.output, /MCP lookup/);
    assert.equal(run.events.filter((e: any) => e.type === 'tool_completed').length, 1);
    const conversation = await request(`/conversations/${accepted.conversationId}`);
    assert.equal(conversation.activeRunId, undefined);
    assert.equal(conversation.messages.length, 2);
    const subsequent = await request('/chat', {
      conversationId: accepted.conversationId,
      message: 'Use the updated workflow for this new turn',
    });
    const result = await until(
      () => request(`/runs/${subsequent.id}`),
      (r) => ['succeeded', 'failed'].includes(r.status),
    );
    assert.equal(result.output, 'Workflow edited after submission');
  },
);
