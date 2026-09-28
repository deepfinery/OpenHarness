import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { connectorConfigSchema } from '@openharness/connector-core';
import {
  OpenShellCli,
  createConnectorServer,
  openshellSettingsSchema,
  openshellToolNames,
} from '../src/index.js';
import { collectionItems, parseRuleListing } from '../src/openshell.js';

const exec = promisify(execFile);
const fakeCli = new URL('../../tests/fixtures/openshell-fake/openshell', import.meta.url).pathname;
let dir = '';
const env = () => ({
  ...process.env,
  OPENSHELL_FAKE_STATE: join(dir, 'state.json'),
  OPENSHELL_FAKE_LOG: join(dir, 'calls.log'),
});
const baseConfig = {
  gateway_url: 'wss://gateway.test/connect',
  device_id: 'openshell-box',
  platform: 'openshell',
  token: 'dv_0123456789abcdef',
  max_output_bytes: 4000,
};

async function connectedClient(settings: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  const parsed = {
    ...connectorConfigSchema.parse({ ...baseConfig, ...config }),
    token: 'dv_0123456789abcdef',
    hostname: 'unit',
  };
  const parsedSettings = openshellSettingsSchema.parse({ bin: fakeCli, ...settings });
  // The driver is built here so the fake CLI's state file can be pointed at this test's directory.
  const driver = new OpenShellCli({
    bin: parsedSettings.bin,
    workspace: parsedSettings.workspace,
    timeoutMs: parsedSettings.cli_timeout_seconds * 1000,
    maxOutputBytes: parsed.max_output_bytes,
    env: env(),
  });
  const built = await createConnectorServer(parsed, parsedSettings, driver);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await built.server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })) as {
      isError?: boolean;
      structuredContent?: Record<string, any>;
      content: { type: string; text: string }[];
    };
    return { ...result, data: result.structuredContent ?? {}, text: result.content[0]?.text ?? '' };
  };
  return { client, call, built, close: () => Promise.all([client.close(), built.server.close()]) };
}
const fake = (...args: string[]) => exec(fakeCli, args, { env: env() });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openshell-connector-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('parses CLI collections and the human-readable rule listing', () => {
  assert.deepEqual(collectionItems([{ a: 1 }], 'x'), [{ a: 1 }]);
  assert.deepEqual(collectionItems({ sandboxes: [{ a: 1 }], next_page_token: '' }, 'sandboxes'), [{ a: 1 }]);
  assert.deepEqual(collectionItems({ items: [{ a: 1 }] }, 'sandboxes'), [{ a: 1 }]);
  assert.deepEqual(collectionItems('nope', 'sandboxes'), []);
  const proposals = parseRuleListing(
    'Network rules for dev\n\n  Chunk: abc123\n  Status: \u001b[33mpending\u001b[0m\n  Rule: api_github_com\n  Binary: /usr/bin/curl\n  Confidence: 92%\n  Rationale: curl attempted api.github.com:443\n  Endpoints: api.github.com:443\n  Hits: 3 (first seen x, last seen y)\n\n  Chunk: def456\n  Status: approved\n',
  );
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0].id, 'abc123');
  assert.equal(proposals[0].status, 'pending');
  assert.equal(proposals[0].confidence, 92);
  assert.equal(proposals[0].endpoints, 'api.github.com:443');
  assert.equal(proposals[1].status, 'approved');
});

test('the connector exposes OpenShell as MCP tools: status, sandboxes, exec with policy denials, proposals and policy revisions', async () => {
  const { client, call, built, close } = await connectedClient();
  try {
    assert.equal(built.version, '0.1.2');
    assert.deepEqual(built.warnings, []);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, [...openshellToolNames].sort());
    const status = await call('openshell_status');
    assert.equal(status.isError, undefined);
    assert.equal(status.data.status.status, 'connected');
    assert.equal(status.data.cli_version, '0.1.2');
    assert.equal(status.data.connector_policy.workspace, 'default');
    assert.equal((await call('list_workspaces')).data.workspaces[0].name, 'default');

    const created = await call('create_sandbox', {
      name: 'agent-one',
      image: 'registry.example.com/agents/worker:1.0',
      policy: JSON.stringify({
        version: 1,
        network_policies: {
          pypi: {
            name: 'pypi',
            endpoints: [{ host: 'pypi.org', port: 443 }],
            binaries: [{ path: '/usr/bin/curl' }],
          },
        },
      }),
      labels: { team: 'platform' },
      command: ['./worker', '--once'],
    });
    assert.equal(created.isError, undefined, created.text);
    assert.equal(created.data.name, 'agent-one');
    assert.equal(created.data.managed, true);
    assert.equal(
      created.data.labels['openharness.device'],
      'openshell-box',
      'created sandboxes carry the connector label',
    );
    assert.equal(created.data.labels.team, 'platform');
    const calls = (await readFile(join(dir, 'calls.log'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const createCall = calls.find((c: string[]) => c.includes('create'));
    assert.ok(
      createCall.includes('--detach') && createCall.includes('--no-auto-providers'),
      'create never attaches or prompts',
    );
    assert.ok(
      createCall[createCall.indexOf('--policy') + 1].endsWith('policy.json'),
      'JSON policies are handed over as .json',
    );
    assert.deepEqual(createCall.slice(createCall.indexOf('--') + 1), ['./worker', '--once']);

    const listed = await call('list_sandboxes');
    assert.equal(listed.data.sandboxes.length, 1);
    assert.equal(listed.data.sandboxes[0].phase, 'Ready');
    assert.equal(listed.data.sandboxes[0].managed, true);
    assert.equal(
      (await call('get_sandbox', { name: 'agent-one' })).data.policy.network_policies.pypi.name,
      'pypi',
    );

    const echo = await call('exec_in_sandbox', { name: 'agent-one', argv: ['echo', 'hello', 'sandbox'] });
    assert.equal(echo.data.exit_code, 0);
    assert.equal(echo.data.stdout.trim(), 'hello sandbox');
    assert.equal(echo.data.policy_denied, false);
    const execCall = calls.at(-1) ?? [];
    const execArgs = (await readFile(join(dir, 'calls.log'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((c: string[]) => c.includes('exec'));
    assert.ok(
      execArgs.includes('--no-tty') && execArgs.includes('--no-login-shell'),
      `exec runs non-interactively: ${execArgs}`,
    );
    void execCall;

    const allowed = await call('exec_in_sandbox', {
      name: 'agent-one',
      argv: ['curl', '-s', 'https://pypi.org/simple/'],
    });
    assert.equal(allowed.data.exit_code, 0, allowed.data.stderr);
    const denied = await call('exec_in_sandbox', {
      name: 'agent-one',
      argv: ['curl', 'https://api.github.com/repos'],
    });
    assert.equal(denied.data.exit_code, 7);
    assert.equal(denied.data.policy_denied, true, 'the denial is recognised as a policy decision');
    assert.match(denied.data.stderr, /policy_denied/);
    const fsDenied = await call('exec_in_sandbox', { name: 'agent-one', argv: ['touch', '/etc/passwd'] });
    assert.equal(fsDenied.data.policy_denied, true);
    const logs = await call('sandbox_logs', { name: 'agent-one', since: '10m', source: 'sandbox' });
    assert.match(logs.data.text, /policy_denied dest=api\.github\.com:443 binary=\/usr\/bin\/curl/);
    assert.match(logs.data.text, /policy_denied kind=filesystem/);

    const proposals = await call('list_rule_proposals', { name: 'agent-one', status: 'pending' });
    assert.equal(proposals.data.proposals.length, 1);
    const chunk = proposals.data.proposals[0];
    assert.equal(chunk.status, 'pending');
    assert.equal(chunk.endpoints, 'api.github.com:443');
    const approved = await call('approve_rule', { name: 'agent-one', chunk_id: chunk.id });
    assert.equal(approved.isError, undefined, approved.text);
    const retried = await call('exec_in_sandbox', {
      name: 'agent-one',
      argv: ['curl', 'https://api.github.com/repos'],
    });
    assert.equal(retried.data.exit_code, 0, 'the approved rule hot-reloaded');
    assert.equal(
      (await call('list_rule_proposals', { name: 'agent-one', status: 'pending' })).data.proposals.length,
      0,
    );

    const revisions = await call('list_policy_revisions', { name: 'agent-one' });
    assert.equal(revisions.data.revisions.length, 2, 'create plus the approved rule');
    const base = await call('get_policy', { name: 'agent-one' });
    assert.equal(base.data.status, 'effective');
    assert.ok(
      base.data.policy.network_policies.api_github_com,
      'the approved endpoint is in the base policy',
    );
    const full = await call('get_policy', { name: 'agent-one', view: 'full', rev: 1 });
    assert.equal(full.data.version, 1);
    assert.ok('provider_rules' in full.data.policy);

    const replaced = await call('set_policy', {
      name: 'agent-one',
      policy: JSON.stringify({ version: 1, network_policies: {} }),
    });
    assert.equal(replaced.isError, undefined, replaced.text);
    assert.match(replaced.data.output, /revision 3 loaded/);
    const yaml = await call('set_policy', {
      name: 'agent-one',
      policy:
        'version: 1\nnetwork_policies:\n  web:\n    endpoints:\n      - host: example.com\n        port: 443\n',
    });
    assert.equal(yaml.isError, undefined, yaml.text);
    const yamlCall = (await readFile(join(dir, 'calls.log'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((c: string[]) => c.includes('set'))
      .at(-1);
    assert.ok(
      yamlCall[yamlCall.indexOf('--policy') + 1].endsWith('policy.yaml'),
      'YAML text is handed over as .yaml',
    );
    assert.ok(yamlCall.includes('--wait'));
    const rejected = await call('set_policy', {
      name: 'agent-one',
      policy: JSON.stringify({ version: 1, reject_on_load: true }),
    });
    assert.equal(rejected.isError, true);
    assert.match(rejected.text, /failed to load/);
    const invalid = await call('set_policy', {
      name: 'agent-one',
      policy: JSON.stringify({ version: 1, invalid: true }),
    });
    assert.match(invalid.text, /validation failed/);

    const preview = await call('update_policy_rules', {
      name: 'agent-one',
      add_endpoints: ['api.openai.com:443:read-write:rest:enforce'],
      binaries: ['/usr/bin/python3'],
      rule_name: 'openai',
      dry_run: true,
    });
    assert.equal(preview.data.dry_run, true);
    assert.match(preview.data.output, /api\.openai\.com/);
    const before = (await call('list_policy_revisions', { name: 'agent-one' })).data.revisions.length;
    const updated = await call('update_policy_rules', {
      name: 'agent-one',
      add_endpoints: ['api.openai.com:443:read-write:rest:enforce'],
      binaries: ['/usr/bin/python3'],
      rule_name: 'openai',
    });
    assert.equal(updated.isError, undefined, updated.text);
    assert.equal(
      (await call('list_policy_revisions', { name: 'agent-one' })).data.revisions.length,
      before + 1,
    );
    assert.equal(
      (await call('get_policy', { name: 'agent-one' })).data.policy.network_policies.openai.binaries[0].path,
      '/usr/bin/python3',
    );
    assert.equal(
      (
        await call('exec_in_sandbox', {
          name: 'agent-one',
          argv: ['curl', 'https://api.openai.com/v1/models'],
        })
      ).data.exit_code,
      0,
    );

    const stopped = await call('stop_sandbox', { name: 'agent-one' });
    assert.equal(stopped.data.action, 'stop');
    assert.equal((await call('list_sandboxes')).data.sandboxes[0].phase, 'Stopped');
    assert.equal(
      (await call('exec_in_sandbox', { name: 'agent-one', argv: ['echo', 'x'] })).isError,
      true,
      'exec on a stopped sandbox is an error, not a crash',
    );
    await call('start_sandbox', { name: 'agent-one' });
    assert.equal(
      (await call('exec_in_sandbox', { name: 'agent-one', argv: ['echo', 'x'] })).data.exit_code,
      0,
    );

    // The same idempotency key replays the stored result instead of creating a second sandbox.
    const first = await call(
      'create_sandbox',
      { name: 'agent-two', image: 'registry.example.com/agents/worker:1.0' },
      { idempotencyKey: 'run:1:1' },
    );
    const replay = await call(
      'create_sandbox',
      { name: 'agent-two', image: 'registry.example.com/agents/worker:1.0' },
      { idempotencyKey: 'run:1:1' },
    );
    assert.equal(first.data.id, replay.data.id);
    const duplicate = await call('create_sandbox', {
      name: 'agent-two',
      image: 'registry.example.com/agents/worker:1.0',
    });
    assert.equal(duplicate.isError, true);
    assert.match(duplicate.text, /already exists/);

    const missing = await call('get_sandbox', { name: 'nope' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /not found/);
    assert.match((await call('get_global_policy')).text, /no global policy/);
    await fake(
      'policy',
      'set',
      '--global',
      '--yes',
      '--policy',
      await (async () => {
        const p = join(dir, 'global.json');
        await (
          await import('node:fs/promises')
        ).writeFile(p, JSON.stringify({ version: 1, network_policies: {} }));
        return p;
      })(),
    );
    assert.equal((await call('get_global_policy')).data.scope, 'global');
    assert.equal((await call('get_sandbox', { name: 'agent-one' })).data.policy_source, 'global');
    await fake('policy', 'delete', '--global', '--yes');

    const deleted = await call('delete_sandbox', { name: 'agent-two' });
    assert.equal(deleted.isError, undefined, deleted.text);
    assert.equal((await call('list_sandboxes')).data.sandboxes.length, 1);
    const audit = (await readFile(join(dir, 'calls.log'), 'utf8')).split('\n').filter(Boolean);
    assert.ok(
      audit.filter((line) => !line.includes('--global')).every((line) => JSON.parse(line).includes('never')),
      'colour is always off for machine parsing',
    );
  } finally {
    await close();
  }
});

test('the connector policy bounds what any caller may do, independent of the gateway', async () => {
  await fake('sandbox', 'create', '--name', 'operator-owned', '--from', 'nvcr.io/nvidia/base/ubuntu:24.04');
  const restricted = await connectedClient({
    allow_policy_changes: false,
    allowed_images: ['registry.example.com/agents/'],
    manage_all_sandboxes: false,
    max_sandboxes: 2,
    workspaces: ['team-ml'],
  });
  try {
    const { call } = restricted;
    assert.match(
      (await call('set_policy', { name: 'agent-one', policy: '{"version":1}' })).text,
      /policy changes are disabled/,
    );
    assert.match(
      (await call('approve_rule', { name: 'agent-one', chunk_id: 'x' })).text,
      /policy changes are disabled/,
    );
    assert.match(
      (await call('update_policy_rules', { name: 'agent-one', add_endpoints: ['a.b:443'] })).text,
      /policy changes are disabled/,
    );
    assert.match(
      (await call('create_sandbox', { name: 'evil', image: 'docker.io/library/alpine' })).text,
      /not on the connector allow-list/,
    );
    assert.match((await call('create_sandbox', { name: 'evil' })).text, /choose an image/);
    assert.match(
      (await call('delete_sandbox', { name: 'operator-owned' })).text,
      /not created by this connector/,
    );
    assert.match(
      (await call('exec_in_sandbox', { name: 'operator-owned', argv: ['echo', 'x'] })).text,
      /not created by this connector/,
    );
    assert.equal(
      (await call('list_sandboxes')).data.sandboxes.find((s: any) => s.name === 'operator-owned').managed,
      false,
    );
    assert.match((await call('list_sandboxes', { workspace: 'prod' })).text, /workspace is not allowed/);
    assert.match(
      (await call('list_sandboxes', { workspace: 'team-ml' })).text,
      /workspace "team-ml" not found/,
      'an allowed workspace reaches the CLI',
    );
    const ok = await call('create_sandbox', {
      name: 'agent-three',
      image: 'registry.example.com/agents/worker:2.0',
    });
    assert.equal(ok.isError, undefined, ok.text);
    assert.match(
      (await call('create_sandbox', { name: 'agent-four', image: 'registry.example.com/agents/worker:2.0' }))
        .text,
      /sandbox limit \(2\)/,
    );
    const dry = await call('update_policy_rules', {
      name: 'agent-three',
      add_endpoints: ['a.example:443'],
      dry_run: true,
    });
    assert.equal(dry.isError, undefined, 'a dry run changes nothing and stays allowed');
    const audit = await restricted.built.audit;
    void audit;
  } finally {
    await restricted.close();
  }
  const noLifecycle = await connectedClient({ allow_sandbox_lifecycle: false, allow_exec: false });
  try {
    assert.match(
      (await noLifecycle.call('delete_sandbox', { name: 'agent-one' })).text,
      /lifecycle changes are disabled/,
    );
    assert.match(
      (await noLifecycle.call('exec_in_sandbox', { name: 'agent-one', argv: ['echo'] })).text,
      /exec_in_sandbox is disabled/,
    );
    assert.equal(
      (await noLifecycle.call('get_policy', { name: 'agent-one' })).isError,
      undefined,
      'reads stay available',
    );
  } finally {
    await noLifecycle.close();
  }
});

test('a missing CLI is reported at startup and platform must be openshell', async () => {
  const config = { ...connectorConfigSchema.parse(baseConfig), token: 'x'.repeat(16), hostname: 'unit' };
  await assert.rejects(
    createConnectorServer(config, openshellSettingsSchema.parse({ bin: join(dir, 'does-not-exist') })),
    /was not found/,
  );
  await assert.rejects(
    createConnectorServer({ ...config, platform: 'linux' }, openshellSettingsSchema.parse({ bin: fakeCli })),
    /platform to "openshell"/,
  );
});
