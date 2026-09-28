import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { machineInstallSnippets } from '../../packages/core/src/machineInstall.js';
import { devicePlatforms } from '../../packages/core/src/schema.js';
import { makeStarter } from '../../packages/core/src/starters.js';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { deviceToolCatalog } = await import('../../packages/core/src/devices.js');
test('machine container instructions explicitly separate restricted and root host installations', () => {
  const restricted = machineInstallSnippets(
    { device_id: 'vm2' },
    'dv_test-token-123456',
    'ws://192.0.2.1:8090',
  );
  assert.match(restricted.docker, /git clone/);
  assert.match(restricted.docker, /GATEWAY_URL=ws:\/\/192.0.2.1:8090\/connect/);
  assert.match(restricted.docker, /MACHINE_ACCESS_MODE=restricted/);
  assert.ok(!restricted.docker.includes('--privileged'));
  const privileged = machineInstallSnippets(
    { device_id: 'vm2', access_mode: 'host' },
    '',
    'wss://gpu.example.com',
  );
  assert.match(privileged.docker, /--privileged --pid=host --user 0/);
  assert.match(privileged.docker, /HOST_ACCESS=true -e MACHINE_ACCESS_MODE=host/);
  assert.match(privileged.docker, /GATEWAY_ALLOW_INSECURE=false/);
  assert.match(privileged.docker, /REPLACE_WITH_SAVED_DEVICE_TOKEN/);
  assert.ok(!privileged.docker.includes('docker.sock'));
  assert.throws(() => machineInstallSnippets({ device_id: 'vm2' }, "dv_foo'; exit", 'ws://server'));
});

test('OpenShell managed machines enroll like Linux machines, with their own installer and tool catalog', () => {
  const snippets = machineInstallSnippets(
    { device_id: 'openshell-1', platform: 'openshell' },
    'dv_test-token-123456',
    'wss://gateway.example.com',
  );
  assert.match(snippets.openshell, /connector-openshell\/install\.sh/);
  assert.match(snippets.openshell, /GATEWAY_URL='wss:\/\/gateway.example.com\/connect'/);
  assert.match(snippets.openshell, /DEVICE_ID='openshell-1'/);
  assert.match(snippets.openshell, /OpenShell 0\.1\.2/);
  assert.match(snippets['openshell-docker'], /connector-openshell\/Dockerfile/);
  assert.match(snippets['openshell-docker'], /--network host/);
  assert.match(snippets['openshell-docker'], /\.config\/openshell:\/home\/node\/\.config\/openshell:ro/);
  assert.ok(
    !snippets['openshell-docker'].includes('docker.sock'),
    'the connector never gets the Docker socket',
  );
  assert.ok(devicePlatforms.includes('openshell'));
  const names = deviceToolCatalog.openshell.map((t) => t.name);
  for (const tool of ['exec_in_sandbox', 'get_policy', 'set_policy', 'approve_rule', 'sandbox_logs'])
    assert.ok(names.includes(tool), `${tool} is offered in the allow-list`);
  assert.ok(
    deviceToolCatalog.openshell.find((t) => t.name === 'set_policy')?.risky,
    'policy changes are marked as acting',
  );
  assert.ok(!deviceToolCatalog.openshell.find((t) => t.name === 'get_policy')?.risky);
  const providerId = randomUUID();
  const connectionId = randomUUID();
  const starter = makeStarter({
    kind: 'machine',
    providerId,
    machine: { connectionId, name: 'Lab OpenShell', tools: names, platform: 'openshell' },
  });
  const operator = starter.nodes.find((n) => n.id === 'operator')!;
  assert.equal(operator.name, 'OpenShell operator');
  assert.match(operator.config!.systemPrompt, /exec_in_sandbox/);
  assert.match(operator.config!.systemPrompt, /never try to work around a denial/);
  const linux = makeStarter({
    kind: 'machine',
    providerId,
    machine: { connectionId, name: 'Box', tools: ['run_command'] },
  });
  assert.equal(linux.nodes.find((n) => n.id === 'operator')!.name, 'Machine operator');
});
