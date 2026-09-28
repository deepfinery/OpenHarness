// End to end: enroll an OpenShell managed machine, start its connector (with the OpenShell CLI test double) inside
// the isolated stack with no inbound ports, drive sandboxes and policies from the console API, and let a
// harness agent work inside a sandbox through the machine's MCP tools. Needs TEST_COMPOSE_PROJECT.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const exec = promisify(execFile);
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const project = process.env.TEST_COMPOSE_PROJECT;
const suffix = randomUUID().slice(0, 6);
const deviceId = `test-openshell-${suffix}`;
const sandbox = `agent-${suffix}`;
const admin = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
let cookie = '';
let containerId = '';
async function login(credentials: { email: string; password: string }) {
  const response = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  assert.equal(response.status, 200, await response.text());
  return response.headers.get('set-cookie')!.split(';')[0];
}
async function requestAs(as: string, path: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: { Origin: base, Cookie: as, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined };
}
const request = (path: string, method = 'GET', body?: unknown) => requestAs(cookie, path, method, body);
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
/** Builds the edge image once per machine; the stack script also prebuilds it. */
async function ensureImages() {
  const missing = await exec('docker', ['image', 'inspect', 'openharness-edge:local']).then(
    () => false,
    () => true,
  );
  if (missing)
    await exec(
      'docker',
      ['build', '-f', 'connector-go/Dockerfile', '--target', 'edge', '-t', 'openharness-edge:local', '.'],
      { maxBuffer: 50_000_000 },
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
  cookie = await login(admin);
});
after(async () => {
  if (containerId) await exec('docker', ['rm', '-f', containerId]).catch(() => {});
});

test('the inventory offers OpenShell as a resource type with its own tool catalog', async () => {
  const listing = await ok('/devices');
  assert.equal(listing.configured, true);
  const names = listing.catalog.openshell.map((t: any) => t.name);
  for (const tool of [
    'openshell_status',
    'list_sandboxes',
    'exec_in_sandbox',
    'get_policy',
    'set_policy',
    'approve_rule',
  ])
    assert.ok(names.includes(tool), `${tool} in the OpenShell catalog`);
  assert.equal((await request('/openshell/machines')).status, 200);
  assert.equal((await request('/openshell/nope-1/status')).status, 404, 'unknown machines are 404');
});

test(
  'an OpenShell connector enrolls like a machine; the console manages sandboxes and policies and a harness agent works inside a sandbox',
  { skip: !project && 'TEST_COMPOSE_PROJECT is required' },
  async () => {
    await ensureImages();
    const agentTools = [
      'openshell_status',
      'list_sandboxes',
      'get_sandbox',
      'exec_in_sandbox',
      'sandbox_logs',
      'get_policy',
      'list_rule_proposals',
    ];
    const enrolled = await ok('/devices', {
      name: `Lab OpenShell ${suffix}`,
      deviceId,
      platform: 'openshell',
      allowedTools: agentTools,
    });
    assert.match(enrolled.token, /^dv_/);
    assert.equal(enrolled.machine.platform, 'openshell');
    assert.match(enrolled.install.openshell, new RegExp(`OPENHARNESS_DEVICE_ID=${deviceId}`));
    assert.match(enrolled.install.openshell, /deploy\/openshell/);
    assert.match(enrolled.install.openshell, /OPENHARNESS_TOKEN=dv_/);
    assert.ok(enrolled.machine.connectionId, 'a device connection mirrors the machine');
    assert.equal(
      (
        await request('/devices', 'POST', {
          name: 'x',
          deviceId: `${deviceId}-h`,
          platform: 'openshell',
          accessMode: 'host',
          allowedTools: [],
        })
      ).status,
      400,
      'privileged host mode stays Linux-only',
    );
    // The connector dials out from inside the stack network; nothing listens on it.
    const { stdout } = await compose(
      'run',
      '-d',
      '--no-deps',
      '-e',
      `DEVICE_TOKEN=${enrolled.token}`,
      '-e',
      `DEVICE_ID=${deviceId}`,
      'openshell-device',
    );
    containerId = stdout.trim().split('\n').at(-1)!;
    const online = await waitFor(
      async () => {
        const { machines } = await ok('/devices');
        const m = machines.find((x: any) => x.device_id === deviceId);
        return m?.online && m.tools.length ? m : undefined;
      },
      90_000,
      'the OpenShell connector to come online with discovered tools',
    );
    assert.equal(online.platform, 'openshell');
    assert.deepEqual(
      online.tools.map((t: any) => t.name).sort(),
      [...agentTools].sort(),
      'agents only see the allowed tools',
    );
    assert.ok(
      !online.tools.some((t: any) => t.name === 'set_policy'),
      'policy changes are not offered to agents here',
    );
    assert.ok((await ok('/openshell/machines')).machines.some((m: any) => m.device_id === deviceId));

    const status = await ok(`/openshell/${deviceId}/status`);
    assert.equal(status.status.status, 'connected');
    assert.equal(status.status.authentication.status, 'authenticated');
    assert.ok(status.edge_version, 'the edge reports its version');
    assert.equal(status.gateway_info.version, '0.1.2');
    assert.deepEqual(status.connector_policy.allowed_images, ['registry.example.com/agents/']);
    assert.equal((await ok(`/openshell/${deviceId}/workspaces`)).workspaces[0].name, 'default');

    // The console creates a sandbox through the trusted admin path, although create_sandbox is not an agent tool here.
    const policy = {
      version: 1,
      network_policies: {
        pypi: {
          name: 'pypi',
          endpoints: [
            { host: 'pypi.org', port: 443, access: 'read-only', protocol: 'rest', enforcement: 'enforce' },
          ],
          binaries: [{ path: '/usr/bin/curl' }],
        },
      },
    };
    const created = await ok(`/openshell/${deviceId}/sandboxes`, {
      name: sandbox,
      image: 'registry.example.com/agents/worker:1.0',
      policy: JSON.stringify(policy),
      command: ['./worker'],
    });
    assert.equal(created.name, sandbox);
    assert.equal(created.managed, true);
    assert.equal(created.labels['openharness.device'], deviceId);
    const refused = await request(`/openshell/${deviceId}/sandboxes`, 'POST', {
      name: `${sandbox}-x`,
      image: 'docker.io/library/alpine:3',
    });
    assert.equal(refused.status, 403, JSON.stringify(refused.data));
    assert.match(refused.data.error, /not on the (connector|edge) allow-list/);
    const listed = await ok(`/openshell/${deviceId}/sandboxes`);
    assert.equal(listed.sandboxes.filter((s: any) => s.name === sandbox).length, 1);
    assert.equal(listed.sandboxes[0].phase, 'Ready');
    assert.equal(
      (await ok(`/openshell/${deviceId}/sandboxes/${sandbox}`)).policy.network_policies.pypi.name,
      'pypi',
    );

    // A denied request is a sandbox policy decision, visible in the exec result, the logs and the advisor's proposals.
    const allowed = await ok(`/openshell/${deviceId}/sandboxes/${sandbox}/exec`, {
      argv: ['curl', '-s', 'https://pypi.org/simple/'],
    });
    assert.equal(allowed.exit_code, 0, allowed.stderr);
    const denied = await ok(`/openshell/${deviceId}/sandboxes/${sandbox}/exec`, {
      argv: ['curl', 'https://api.github.com/repos'],
    });
    assert.equal(denied.exit_code, 7);
    assert.equal(denied.policy_denied, true);
    const logs = await ok(`/openshell/${deviceId}/sandboxes/${sandbox}/logs?since=10m&source=sandbox`);
    assert.match(logs.text, /policy_denied/);
    assert.match(logs.text, /dest=api\.github\.com:443/);
    assert.match(logs.text, /binary=\/usr\/bin\/curl/);
    const proposals = await ok(`/openshell/${deviceId}/sandboxes/${sandbox}/proposals?status=pending`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].endpoints, 'api.github.com:443');
    await ok(
      `/openshell/${deviceId}/sandboxes/${sandbox}/proposals/${proposals.proposals[0].id}/approve`,
      {},
    );
    assert.equal(
      (
        await ok(`/openshell/${deviceId}/sandboxes/${sandbox}/exec`, {
          argv: ['curl', 'https://api.github.com/repos'],
        })
      ).exit_code,
      0,
      'the approved rule hot-reloaded',
    );
    const basePolicy = await ok(`/openshell/${deviceId}/sandboxes/${sandbox}/policy`);
    assert.ok(
      basePolicy.policy.network_policies.api_github_com,
      'the approved endpoint is in the base policy',
    );
    assert.equal(
      (await ok(`/openshell/${deviceId}/sandboxes/${sandbox}/policy/revisions`)).revisions.length,
      2,
    );
    await ok(
      `/openshell/${deviceId}/sandboxes/${sandbox}/policy`,
      {
        policy: JSON.stringify({
          ...policy,
          network_policies: { ...policy.network_policies, ...basePolicy.policy.network_policies },
        }),
      },
      'PUT',
    );
    await ok(`/openshell/${deviceId}/sandboxes/${sandbox}/policy/rules`, {
      add_endpoints: ['api.openai.com:443:read-write:rest:enforce'],
      binaries: ['/usr/bin/python3'],
      rule_name: 'openai',
    });
    const revisions = (await ok(`/openshell/${deviceId}/sandboxes/${sandbox}/policy/revisions`)).revisions;
    assert.equal(revisions.length, 4);
    assert.equal(revisions.at(-1).status, 'loaded', 'the newest revision is the loaded one');
    assert.ok(
      revisions.every((r: any) => r.status === 'loaded' || r.status === 'superseded'),
      'earlier revisions are superseded, none failed',
    );
    // The stand-in treats a rule named reject_on_load as a revision the sandbox refuses to load.
    const rejectedPolicy = await request(`/openshell/${deviceId}/sandboxes/${sandbox}/policy`, 'PUT', {
      policy: JSON.stringify({
        version: 1,
        network_policies: { reject_on_load: { endpoints: [], binaries: [] } },
      }),
    });
    assert.equal(rejectedPolicy.status, 502, 'a revision the sandbox refuses is reported, not swallowed');
    assert.match(rejectedPolicy.data.error, /failed to load/);

    // A harness agent uses the machine's tools through the device gateway, like any machine.
    const provider = await ok('/providers', {
      name: `OpenShell model ${suffix}`,
      kind: 'openai-compatible',
      baseUrl: 'http://fixtures:9090/v1',
      model: 'test-chat',
    });
    const workflow = await ok('/workflows', {
      name: `Sandbox operator ${suffix}`,
      startAt: 'start',
      nodes: [
        { id: 'start', name: 'Start', type: 'start', next: 'operator' },
        {
          id: 'operator',
          name: 'Operator',
          type: 'agent',
          prompt: '{{input}}',
          next: 'finish',
          config: { name: 'Operator', providerId: provider.id, systemPrompt: 'Work inside sandboxes only.' },
        },
        { id: 'finish', name: 'Finish', type: 'finish', template: '{{last}}' },
      ],
    });
    const run = await waitRun(
      (
        await ok('/runs', {
          workflowId: workflow.id,
          input: `Please run uname in the sandbox ${sandbox}`,
          deviceId,
        })
      ).id,
    );
    assert.equal(run.status, 'succeeded', run.error);
    assert.equal(run.device?.platform, 'openshell');
    assert.match(run.output, /Linux/, 'the sandbox output travelled back through the gateway');
    const toolEvent = run.events.find((e: any) => e.type === 'tool_completed');
    assert.match(toolEvent.message, /exec_in_sandbox/);
    const deniedRun = await waitRun(
      (
        await ok('/runs', {
          workflowId: workflow.id,
          input: `Please fetch https://example.org/ from the sandbox ${sandbox}`,
          deviceId,
        })
      ).id,
    );
    assert.equal(deniedRun.status, 'succeeded', deniedRun.error);
    const deniedEvent = deniedRun.events.find((e: any) => e.type === 'tool_completed');
    // The trace keeps the tool result as text, so the JSON inside it arrives with escaped quotes.
    assert.match(
      String(deniedEvent.data?.result ?? ''),
      /policy_denied\\?": true/,
      'the trace records that the sandbox policy denied the request',
    );
    assert.match(String(deniedEvent.data?.result ?? ''), /example\.org/);
    const proposalsAfter = await ok(`/openshell/${deviceId}/sandboxes/${sandbox}/proposals?status=pending`);
    assert.ok(
      proposalsAfter.proposals.some((p: any) => p.endpoints === 'example.org:443'),
      'the denial produced a proposal the console can decide',
    );
    // An executor: the console enrolls a Linux machine and the edge launches a confined sandbox that runs the
    // connector with that machine's token. Here the OpenShell stand-in only records the launch, so the machine
    // stays offline; on a real host it dials in and turns online.
    const executorName = `exec-${suffix}`;
    const launched = await ok(`/openshell/${deviceId}/executors`, {
      name: executorName,
      allowed_hosts: ['pypi.org:443:read-only:rest:enforce'],
    });
    assert.equal(launched.machine.device_id, executorName);
    assert.equal(launched.machine.platform, 'linux');
    assert.equal(launched.sandbox.executor, executorName);
    assert.ok(launched.policy.network_policies.openharness, 'the executor policy admits the harness gateway');
    assert.equal(launched.policy.landlock.compatibility, 'hard_requirement');
    assert.ok(
      Object.keys(launched.policy.network_policies).some((k) => k.startsWith('allowed_pypi_org')),
      'extra destinations become rules',
    );
    assert.ok(
      (await ok('/devices')).machines.some(
        (m: any) => m.device_id === executorName && m.platform === 'linux',
      ),
      'the executor is a machine in the inventory',
    );
    assert.equal(
      (await ok(`/openshell/${deviceId}/sandboxes`)).sandboxes.find((s: any) => s.name === executorName)
        ?.executor,
      executorName,
    );
    assert.equal(
      (await request(`/openshell/${deviceId}/executors`, 'POST', { name: executorName })).status,
      409,
      'an executor name is a machine id and must be unique',
    );
    const refusedExecutor = await request(`/openshell/${deviceId}/executors`, 'POST', {
      name: `${executorName}-b`,
      image: 'docker.io/library/alpine:3',
    });
    assert.equal(refusedExecutor.status, 403, JSON.stringify(refusedExecutor.data));
    assert.ok(
      !(await ok('/devices')).machines.some((m: any) => m.device_id === `${executorName}-b`),
      'a refused launch leaves no phantom machine',
    );
    await ok(`/openshell/${deviceId}/executors/${executorName}`, undefined, 'DELETE');
    assert.ok(!(await ok('/devices')).machines.some((m: any) => m.device_id === executorName));
    assert.ok(
      !(await ok(`/openshell/${deviceId}/sandboxes`)).sandboxes.some((s: any) => s.name === executorName),
    );

    // Tenant isolation and roles: another workspace cannot see the machine; a member can read but not change.
    const outsider = {
      email: `openshell-outsider-${suffix}@openharness.test`,
      password: 'Integration-test-password-42',
    };
    await ok('/users', { ...outsider, name: 'Outsider', workspace: 'new', role: 'admin' });
    assert.equal((await requestAs(await login(outsider), `/openshell/${deviceId}/status`)).status, 404);
    const member = {
      email: `openshell-member-${suffix}@openharness.test`,
      password: 'Integration-test-password-42',
    };
    await ok('/users', { ...member, name: 'Member', workspace: 'current', role: 'member' });
    const memberCookie = await login(member);
    assert.equal((await requestAs(memberCookie, `/openshell/${deviceId}/sandboxes`)).status, 200);
    assert.equal(
      (
        await requestAs(memberCookie, `/openshell/${deviceId}/sandboxes/${sandbox}/exec`, 'POST', {
          argv: ['echo', 'x'],
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await requestAs(memberCookie, `/openshell/${deviceId}/sandboxes/${sandbox}/policy`, 'PUT', {
          policy: '{}',
        })
      ).status,
      403,
    );

    await ok(`/openshell/${deviceId}/sandboxes/${sandbox}/stop`, {});
    assert.equal(
      (await ok(`/openshell/${deviceId}/sandboxes`)).sandboxes.find((s: any) => s.name === sandbox).phase,
      'Stopped',
    );
    await ok(`/openshell/${deviceId}/sandboxes/${sandbox}`, undefined, 'DELETE');
    assert.ok(!(await ok(`/openshell/${deviceId}/sandboxes`)).sandboxes.some((s: any) => s.name === sandbox));
    await ok(`/workflows/${workflow.id}`, undefined, 'DELETE');
    assert.equal((await request(`/devices/${deviceId}`, 'DELETE')).status, 204);
    assert.equal((await request(`/openshell/${deviceId}/status`)).status, 404);
  },
);
