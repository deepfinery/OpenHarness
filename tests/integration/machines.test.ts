// End to end: enroll a machine, start a Linux connector container with no inbound ports, and let a workflow's
// agent run a command on it through the gateway. Needs TEST_COMPOSE_PROJECT (docker compose is used to start
// the connector container inside the isolated stack's network).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { makeStarter } from '../../packages/core/src/starters.js';

const exec = promisify(execFile);
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const project = process.env.TEST_COMPOSE_PROJECT;
const suffix = randomUUID().slice(0, 6);
const deviceId = `test-box-${suffix}`;
const admin = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
let cookie = '';
let containerId = '';
async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined };
}
async function ok(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const r = await request(path, method, body);
  assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
const compose = (...args: string[]) =>
  exec(
    'docker',
    ['compose', '-p', project!, '-f', 'compose.yaml', '-f', 'tests/compose.test.yaml', ...args],
    {
      env: { ...process.env, TEST_DEVICE_ID: deviceId },
      maxBuffer: 10_000_000,
    },
  );
async function waitFor<T>(fn: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
async function waitRun(id: string) {
  return waitFor(
    async () => {
      const run = await ok(`/runs/${id}`);
      return ['running', 'queued'].includes(run.status) ? undefined : run;
    },
    90_000,
    'run to finish',
  );
}

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
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
});
after(async () => {
  if (containerId) await exec('docker', ['rm', '-f', containerId]).catch(() => {});
});

test('the Machines API reports a configured gateway and the platform tool catalog', async () => {
  const listing = await ok('/devices');
  assert.equal(listing.configured, true, 'GATEWAY_* is configured in the test stack');
  assert.match(listing.publicUrl, /^wss?:\/\//);
  assert.ok(listing.catalog.linux.some((t: any) => t.name === 'run_command'));
  assert.ok(listing.catalog.chrome.some((t: any) => t.name === 'list_tabs'));
  assert.equal(
    (
      await request('/connections', 'POST', {
        name: 'Fake machine',
        url: 'http://gateway:8090/mcp/x',
        kind: 'device',
      })
    ).status,
    400,
    'device connections only come from enrollment',
  );
});
test(
  'a Linux connector container enrolls, dials the gateway, and a workflow agent runs a command on it',
  { skip: !project && 'TEST_COMPOSE_PROJECT is required' },
  async () => {
    const enrolled = await ok('/devices', {
      name: `Test box ${suffix}`,
      deviceId,
      platform: 'linux',
      allowedTools: ['run_command', 'system_info', 'list_dir'],
    });
    assert.match(enrolled.token, /^dv_/);
    assert.equal(enrolled.machine.device_id, deviceId);
    assert.match(enrolled.install.docker, new RegExp(`DEVICE_ID=${deviceId}`));
    assert.ok(enrolled.machine.connectionId, 'a device connection mirrors the machine');
    // Start the connector inside the stack's network with no published ports: it can only dial out.
    const { stdout } = await compose(
      'run',
      '-d',
      '--no-deps',
      '-e',
      `DEVICE_TOKEN=${enrolled.token}`,
      '-e',
      `DEVICE_ID=${deviceId}`,
      'device',
    );
    containerId = stdout.trim().split('\n').at(-1)!;
    const online = await waitFor(
      async () => {
        const { machines } = await ok('/devices');
        const m = machines.find((x: any) => x.device_id === deviceId);
        return m?.online && m.tools.length ? m : undefined;
      },
      60_000,
      'the connector to come online with discovered tools',
    );
    assert.equal(online.platform, 'linux');
    assert.ok(online.hostname, 'hostname reported by the connector');
    assert.deepEqual(
      online.tools.map((t: any) => t.name).sort(),
      ['list_dir', 'run_command', 'system_info'],
      'only allowed tools are discovered',
    );
    // A one-agent workflow; the machine is chosen per run, not baked into the workflow.
    const provider = await ok('/providers', {
      name: `Machine model ${suffix}`,
      kind: 'openai-compatible',
      baseUrl: 'http://fixtures:9090/v1',
      model: 'test-chat',
    });
    const workflow = await ok('/workflows', {
      name: `Machine operator ${suffix}`,
      startAt: 'start',
      nodes: [
        { id: 'start', name: 'Start', type: 'start', next: 'operator' },
        {
          id: 'operator',
          name: 'Operator',
          type: 'agent',
          prompt: '{{input}}',
          next: 'finish',
          config: {
            name: 'Operator',
            providerId: provider.id,
            systemPrompt: 'Operate the machine carefully.',
          },
        },
        { id: 'finish', name: 'Finish', type: 'finish', template: '{{last}}' },
      ],
    });
    const run = await waitRun(
      (await ok('/runs', { workflowId: workflow.id, input: 'Please run uname on the machine', deviceId })).id,
    );
    assert.equal(run.status, 'succeeded', run.error);
    assert.equal(run.device?.id, deviceId);
    assert.match(run.output, /Linux/, 'the command output travelled back through the gateway');
    const toolEvent = run.events.find((e: any) => e.type === 'tool_completed');
    assert.ok(toolEvent, 'trace records the tool call');
    assert.match(toolEvent.message, /run_command/);
    assert.match(String(toolEvent.data?.result ?? ''), /Linux/);
    // The chat API remembers the machine for the conversation.
    const chat = await ok('/chat', {
      workflowId: workflow.id,
      message: 'Please run uname on the machine',
      deviceId,
    });
    const chatRun = await waitRun(chat.id);
    assert.equal(chatRun.status, 'succeeded', chatRun.error);
    const conversation = await ok(`/conversations/${chat.conversationId}`);
    assert.equal(conversation.deviceId, deviceId);
    // The Machine operator template binds the machine, so a plain chat runs commands on it without choosing it.
    const template = await ok(
      '/workflows',
      makeStarter({
        kind: 'machine',
        name: `Machine operator template ${suffix}`,
        providerId: provider.id,
        machine: {
          connectionId: online.connectionId,
          name: online.name,
          tools: online.tools.map((t: any) => t.name),
        },
      }),
    );
    const listed = await waitRun(
      (await ok('/chat', { workflowId: template.id, message: 'Please run ls on the machine' })).id,
    );
    assert.equal(listed.status, 'succeeded', listed.error);
    assert.equal(listed.device, undefined, 'no machine was chosen for the chat');
    const ls = listed.events.find((e: any) => e.type === 'tool_completed');
    assert.match(ls.message, /run_command/);
    assert.match(String(ls.data?.result ?? ''), /total \d+/, 'ls -la output came back from the machine');
    // Denied at the connector: rm is not on the container's ALLOW_COMMANDS, so the agent sees a policy error, not a crash.
    const denied = await waitRun(
      (await ok('/runs', { workflowId: workflow.id, input: 'use tool please', deviceId })).id,
    );
    assert.equal(denied.status, 'succeeded', denied.error);
    // The registry lives in MongoDB: after a gateway restart the machine is still enrolled and reconnects on its own.
    await compose('restart', 'gateway');
    await waitFor(
      async () => {
        const r = await request('/devices');
        return r.status === 200 && r.data.machines.find((x: any) => x.device_id === deviceId)?.online
          ? true
          : undefined;
      },
      90_000,
      'the connector to reconnect after a gateway restart',
    );
    const again = await waitRun(
      (await ok('/runs', { workflowId: workflow.id, input: 'Please run uname on the machine', deviceId })).id,
    );
    assert.equal(again.status, 'succeeded', again.error);
    // A machine that is not enrolled cannot be chosen.
    assert.equal(
      (await request('/runs', 'POST', { workflowId: workflow.id, input: 'x', deviceId: 'nope-123' })).status,
      404,
    );
    // A machine that a workflow still uses cannot be removed.
    assert.equal((await request(`/devices/${deviceId}`, 'DELETE')).status, 409);
    await ok(`/workflows/${template.id}`, undefined, 'DELETE');
    // Removing the machine drops its connection and the gateway refuses the connector afterwards.
    assert.equal((await request(`/devices/${deviceId}`, 'DELETE')).status, 204);
    assert.ok(!(await ok('/devices')).machines.some((m: any) => m.device_id === deviceId));
    assert.equal(
      (await request('/runs', 'POST', { workflowId: workflow.id, input: 'x', deviceId })).status,
      404,
    );
  },
);
