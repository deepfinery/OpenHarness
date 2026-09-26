import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const base = process.env.TEST_BASE_URL ?? 'http://localhost:18088';
const project = process.env.TEST_COMPOSE_PROJECT;
let cookie = '',
  cluster: any,
  token = '',
  provider: any;
const containers: string[] = [];
const suffix = randomUUID().slice(0, 8);
async function raw(path: string, body?: any, method = body === undefined ? 'GET' : 'POST') {
  return fetch(base + '/api' + path, {
    method,
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function ok(path: string, body?: any, method?: string) {
  const r = await raw(path, body, method);
  const data = await r.json();
  assert.ok(r.ok, `${path}: ${JSON.stringify(data)}`);
  return data;
}
async function until(fn: () => Promise<any>) {
  for (let i = 0; i < 160; i++) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Condition timed out');
}
before(async () => {
  if (project) assert.match(project, /^openharness-test-/, 'Use only an isolated test Compose project');
  const credentials = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
  cookie = (await raw('/auth/login', credentials)).headers.get('set-cookie')!.split(';')[0];
  const user = { email: `cluster-${suffix}@openharness.test`, password: credentials.password };
  await ok('/users', { ...user, name: 'Cluster admin', role: 'admin', workspace: 'new' });
  cookie = (await raw('/auth/login', user)).headers.get('set-cookie')!.split(';')[0];
  const created = await ok('/clusters', { name: `Training ${suffix}` });
  cluster = created.cluster;
  token = created.install.token;
  assert.match(created.install.privilegedCommand, /--host-access/);
  provider = await ok('/providers', {
    name: 'Cluster fixture',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-cluster',
    maxOutputTokens: 1024,
    embeddingModel: 'test-embedding',
  });
});
after(async () => {
  if (cluster) await ok(`/clusters/${cluster._id}`, { disabled: true }, 'PUT').catch(() => {});
  for (const id of containers) await exec('docker', ['rm', '-f', id]).catch(() => {});
});
test(
  'shared cluster enrollment creates real node connectors and durable bounded monitoring cycles',
  { skip: !project },
  async () => {
    for (let i = 0; i < 3; i++) {
      const name = `openharness-cluster-test-${suffix}-${i}`;
      await exec('docker', [
        'run',
        '-d',
        '--name',
        name,
        '--network',
        `${project}_default`,
        '--label',
        'openharness.test=cluster',
        '-e',
        'GATEWAY_URL=ws://gateway:8090/connect',
        '-e',
        'GATEWAY_ALLOW_INSECURE=true',
        '-e',
        `DEVICE_TOKEN=${token}`,
        '-e',
        `DEVICE_ID=cluster-${suffix}-${i}`,
        '-e',
        'HOST_ACCESS=true',
        'openharness-connector-cluster-test:local',
      ]);
      containers.push(name);
    }
    const devices = await until(async () => {
      const { machines } = await ok('/devices');
      const nodes = machines.filter((m: any) => m.cluster_id === cluster._id && m.online);
      return nodes.length === 3 ? nodes : null;
    });
    assert.equal(devices.length, 3);
    await exec('docker', ['restart', `${project}-gateway-1`]);
    await until(async () => {
      try {
        return (
          (await ok('/devices')).machines.filter((m: any) => m.cluster_id === cluster._id && m.online)
            .length === 3
        );
      } catch {
        return false;
      }
    });
    assert.equal((await ok('/clusters')).clusters[0].node_count, 3);
    assert.ok(
      devices.every((d: any) => d.tools.every((t: any) => ['system_info', 'gpu_inspect'].includes(t.name))),
    );
    const agent = await ok('/agents', {
      name: 'GPU monitor',
      providerId: provider.id,
      systemPrompt: 'Inspect your assigned node and report evidence. Do not invent telemetry.',
      maxTurns: 3,
      tokenBudget: 16000,
    });
    await ok(
      `/clusters/${cluster._id}/monitor`,
      { agentId: agent.id, enabled: true, intervalSeconds: 300, concurrency: 1 },
      'PUT',
    );
    await until(async () => (await ok(`/clusters/${cluster._id}/cycles`))[0]?.active?.length > 0);
    await exec('docker', ['restart', `${project}-api-1`]);
    await until(async () => {
      try {
        return (await fetch(base + '/api/health')).ok;
      } catch {
        return false;
      }
    });
    const cycle = await until(async () => {
      const rows = await ok(`/clusters/${cluster._id}/cycles`);
      const c = rows[0];
      if (!c) return null;
      assert.ok(c.active.length <= 1);
      return c.status === 'completed' ? c : null;
    });
    assert.equal(cycle.completed, 3);
    assert.equal(cycle.failed, 0);
    assert.equal(cycle.nodeCount, 3);
    const runs = await ok(`/runs?cycle=${cycle._id}`);
    assert.equal(runs.length, 3);
    for (const run of runs) {
      const detail = await ok(`/runs/${run.id}`);
      assert.match(detail.output, /Node diagnostic evidence/);
      assert.ok(detail.events.some((e: any) => e.type === 'tool_completed' && e.data.tool === 'gpu_inspect'));
      assert.ok(detail.device.id.startsWith(`cluster-${suffix}`));
    }
    await ok(`/clusters/${cluster._id}/monitor`, { agentId: agent.id, enabled: false }, 'PUT');
    const rotated = await ok(`/clusters/${cluster._id}/rotate-token`, {});
    assert.notEqual(rotated.install.token, token);
    await until(
      async () => !(await ok('/devices')).machines.some((m: any) => m.cluster_id === cluster._id && m.online),
    );
    await ok(`/clusters/${cluster._id}`, { disabled: true }, 'PUT');
  },
);
test('cluster credentials and monitoring controls are isolated by workspace', async () => {
  const ownCookie = cookie;
  const other = {
    email: `other-cluster-${suffix}@openharness.test`,
    password: 'Integration-test-password-42',
  };
  await ok('/users', { ...other, name: 'Other admin', workspace: 'new', role: 'admin' });
  cookie = (await raw('/auth/login', other)).headers.get('set-cookie')!.split(';')[0];
  assert.equal((await raw(`/clusters/${cluster._id}/rotate-token`, {})).status, 404);
  assert.equal((await raw(`/clusters/${cluster._id}`, { disabled: false }, 'PUT')).status, 404);
  assert.equal((await ok('/clusters')).clusters.length, 0);
  cookie = ownCookie;
});
