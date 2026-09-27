import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const exec = promisify(execFile);
const base = process.env.TEST_BASE_URL ?? 'http://localhost:18088';
const project = process.env.TEST_COMPOSE_PROJECT;
const suffix = randomUUID().slice(0, 8);
let cookie = '',
  gatewayToken = '';
const containers: string[] = [];
async function raw(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  return fetch(base + '/api' + path, {
    method,
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function ok(path: string, body?: unknown, method?: string) {
  const r = await raw(path, body, method);
  const data = await r.json();
  assert.ok(r.ok, `${path}: ${JSON.stringify(data)}`);
  return data;
}
async function until(fn: () => Promise<any>) {
  for (let i = 0; i < 100; i++) {
    const r = await fn();
    if (r) return r;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Condition timed out');
}
before(async () => {
  if (!project) return;
  assert.match(project, /^openharness-test-/);
  const env = await readFile('.env', 'utf8');
  gatewayToken = env
    .split('\n')
    .find((l) => l.startsWith('GATEWAY_API_TOKEN='))!
    .slice('GATEWAY_API_TOKEN='.length);
  const login = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
  if ((await ok('/auth/status')).needsSetup)
    await ok('/auth/setup', {
      ...login,
      name: 'Admin',
      setupToken: env
        .split('\n')
        .find((l) => l.startsWith('SETUP_TOKEN='))!
        .slice(12),
    });
  cookie = (await raw('/auth/login', login)).headers.get('set-cookie')!.split(';')[0];
  const user = { email: `host-access-${suffix}@openharness.test`, password: login.password };
  await ok('/users', { ...user, name: 'Host admin', workspace: 'new', role: 'admin' });
  cookie = (await raw('/auth/login', user)).headers.get('set-cookie')!.split(';')[0];
});
after(async () => {
  for (const c of containers.reverse()) await exec('docker', ['rm', '-f', c]).catch(() => {});
});
test(
  'privileged connector operates only in an isolated target container namespace, with gateway opt-in and revocation',
  { skip: !project, timeout: 120000 },
  async () => {
    const id = `vm2-${suffix}`,
      target = `${project}-target-${suffix}`,
      connector = `${project}-host-${suffix}`;
    const enrolled = await ok('/devices', {
      name: 'VM2 host',
      deviceId: id,
      platform: 'linux',
      accessMode: 'host',
      allowedTools: ['run_command', 'system_info', 'gpu_inspect'],
    });
    assert.equal(enrolled.machine.access_mode, 'host');
    assert.match(enrolled.install.docker, /--privileged --pid=host --user 0/);
    await exec('docker', [
      'run',
      '-d',
      '--name',
      target,
      '--hostname',
      'isolated-vm2',
      '--network',
      `${project}_default`,
      'openharness-host-target-test:local',
    ]);
    containers.push(target);
    // Share ONLY the disposable target container's PID namespace, never the development host's.
    await exec('docker', [
      'run',
      '-d',
      '--name',
      connector,
      '--network',
      `${project}_default`,
      '--privileged',
      `--pid=container:${target}`,
      '--user',
      '0',
      '-e',
      'GATEWAY_URL=ws://gateway:8090/connect',
      '-e',
      'GATEWAY_ALLOW_INSECURE=true',
      '-e',
      `DEVICE_ID=${id}`,
      '-e',
      `DEVICE_TOKEN=${enrolled.token}`,
      '-e',
      'HOST_ACCESS=true',
      '-e',
      'MACHINE_ACCESS_MODE=host',
      'openharness-connector-host-access-test:local',
    ]);
    containers.push(connector);
    const online = await until(async () => {
      const m = (await ok('/devices')).machines.find((m: any) => m.device_id === id);
      return m?.online && m.tools.length ? m : null;
    });
    assert.equal(online.active_access_mode, 'host');
    const client = new Client({ name: 'host-access-regression', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://localhost:18090/mcp/${id}`), {
        requestInit: { headers: { Authorization: `Bearer ${gatewayToken}` } },
      }),
    );
    try {
      for (const [argv, expected] of [
        [['hostname'], 'isolated-vm2'],
        [['id', '-u'], '0'],
        [['nvidia-smi'], 'FIXTURE NVIDIA'],
        [['dcgmi', 'discovery', '--list'], 'FIXTURE DCGM'],
        [['cat', '/target-only-proof'], 'isolated target filesystem'],
      ] as const) {
        const r: any = await client.callTool({ name: 'run_command', arguments: { argv } });
        assert.equal(r.isError, false, JSON.stringify(r));
        assert.equal(r.structuredContent.execution_scope, 'host');
        assert.ok(r.structuredContent.stdout.includes(expected));
      }
      const write: any = await client.callTool({
        name: 'run_command',
        arguments: { argv: ['sh', '-c', 'printf verified > /target-write-proof'] },
      });
      assert.equal(write.isError, false);
      assert.match((await exec('docker', ['exec', target, 'cat', '/target-write-proof'])).stdout, /verified/);
      const info: any = await client.callTool({ name: 'system_info', arguments: {} });
      assert.equal(info.structuredContent.execution_scope, 'host');
      assert.match(info.structuredContent.host_identity, /isolated-vm2/);
      await ok(`/devices/${id}`, { accessMode: 'restricted' }, 'PUT');
      await until(async () => !(await ok('/devices')).machines.find((m: any) => m.device_id === id)?.online);
      await assert.rejects(
        client.callTool({ name: 'run_command', arguments: { argv: ['echo', 'must not execute'] } }),
      );
    } finally {
      await client.close();
    }
  },
);
test(
  'host privileges require administrator approval and Linux; saved restricted machines remain restricted',
  { skip: !project },
  async () => {
    assert.equal(
      (await raw('/devices', { name: 'Invalid', platform: 'windows', accessMode: 'host' })).status,
      400,
    );
    const machine = await ok('/devices', {
      name: 'Restricted',
      deviceId: `restricted-${suffix}`,
      platform: 'linux',
      allowedTools: ['run_command'],
    });
    assert.equal(machine.machine.access_mode, 'restricted');
    assert.ok(!machine.install.docker.includes('--privileged'));
    const adminCookie = cookie,
      user = { email: `member-host-${suffix}@openharness.test`, password: 'Integration-test-password-42' };
    await ok('/users', { ...user, name: 'Member', workspace: 'current', role: 'member' });
    cookie = (await raw('/auth/login', user)).headers.get('set-cookie')!.split(';')[0];
    try {
      assert.equal(
        (await raw('/devices', { name: 'Cannot grant', platform: 'linux', accessMode: 'host' })).status,
        403,
      );
      assert.equal(
        (await raw(`/devices/${machine.machine.device_id}`, { accessMode: 'host' }, 'PUT')).status,
        403,
      );
    } finally {
      cookie = adminCookie;
    }
  },
);
