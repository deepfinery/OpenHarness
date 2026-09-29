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
  assert.match(
    restricted.docker,
    /connector-go\/Dockerfile/,
    'restricted machines run the Go connector image',
  );
  assert.match(restricted.docker, /--cap-drop ALL/);
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

test('OpenShell managed machines enroll like Linux machines, with a compose deployment and their own tool catalog', () => {
  const snippets = machineInstallSnippets(
    { device_id: 'openshell-1', platform: 'openshell' },
    'dv_test-token-123456',
    'wss://gateway.example.com:8443',
  );
  assert.match(snippets.openshell, /deploy\/openshell\/build-images\.sh/);
  assert.match(snippets.openshell, /OPENHARNESS_GATEWAY_URL=wss:\/\/gateway.example.com:8443\/connect/);
  assert.match(snippets.openshell, /OPENHARNESS_DEVICE_ID=openshell-1/);
  assert.match(snippets.openshell, /OPENHARNESS_TOKEN=dv_test-token-123456/);
  assert.match(snippets.openshell, /OPENHARNESS_CA_FILE=\/certs\/ca\.crt/, 'a wss gateway gets the CA hint');
  assert.match(snippets.openshell, /OPENSHELL_VERSION=0\.1\.2/);
  assert.match(snippets.openshell, /sh up\.sh/, 'the first start creates the OpenShell PKI');
  assert.ok(!snippets.openshell.includes('docker.sock'), 'the snippet never mounts the Docker socket itself');
  const plain = machineInstallSnippets(
    { device_id: 'openshell-1', platform: 'openshell' },
    'dv_test-token-123456',
    'ws://192.0.2.10:8090',
  );
  assert.match(plain.openshell, /OPENHARNESS_ALLOW_INSECURE=true/);
  assert.ok(!plain.openshell.includes('OPENHARNESS_CA_FILE'));
  // Linux machines run the Go connector image; privileged hosts keep the Node image with host access.
  const linuxContainer = machineInstallSnippets(
    { device_id: 'box-1' },
    'dv_test-token-123456',
    'wss://gateway.example.com:8443',
  );
  assert.match(linuxContainer.docker, /connector-go\/Dockerfile/);
  assert.match(linuxContainer.docker, /GATEWAY_CA_FILE/);
  assert.ok(!linuxContainer.docker.includes('--privileged'));
  assert.match(
    linuxContainer.docker,
    /Self-signed harness certificate\?/,
    'without a known CA the command carries a hint',
  );
  assert.match(
    machineInstallSnippets({ device_id: 'vm2', access_mode: 'host' }, '', 'wss://gpu.example.com').docker,
    /connector-linux\/Dockerfile/,
  );
  assert.ok(devicePlatforms.includes('openshell'));
  const names = deviceToolCatalog.openshell.map((t) => t.name);
  for (const tool of [
    'exec_in_sandbox',
    'get_policy',
    'set_policy',
    'approve_rule',
    'sandbox_logs',
    'launch_executor',
  ])
    assert.ok(names.includes(tool), `${tool} is offered in the allow-list`);
  assert.ok(
    deviceToolCatalog.openshell.find((t) => t.name === 'set_policy')?.risky,
    'policy changes are marked as acting',
  );
  assert.ok(deviceToolCatalog.openshell.find((t) => t.name === 'launch_executor')?.risky);
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

test('install commands embed the harness certificate authority so a copy-paste enrollment trusts the server', () => {
  const caPem = `-----BEGIN CERTIFICATE-----\n${'MIIBszCCAVmgAwIBAgIUQ'.repeat(3)}\nAAAA\n-----END CERTIFICATE-----`;
  const opts = { caPem: `${caPem}\n` };
  const host = machineInstallSnippets(
    { device_id: 'vm1', access_mode: 'host' },
    'dv_test-token-123456',
    'wss://harness.example.com:8443',
    opts,
  );
  assert.match(host.docker, /cat > ca\.crt <<'OPENHARNESS_CA'\n-----BEGIN CERTIFICATE-----/);
  assert.match(
    host.docker,
    /NODE_EXTRA_CA_CERTS=\/certs\/ca\.crt/,
    'the Node connector trusts the CA through Node',
  );
  assert.match(host.docker, /-v "\$PWD\/ca\.crt:\/certs\/ca\.crt:ro"/);
  assert.ok(!host.docker.includes('Self-signed harness certificate?'), 'no hint once the CA is embedded');
  const restricted = machineInstallSnippets(
    { device_id: 'vm1' },
    'dv_test-token-123456',
    'wss://harness.example.com:8443',
    opts,
  );
  assert.match(restricted.docker, /GATEWAY_CA_FILE=\/certs\/ca\.crt/, 'the Go connector gets the CA file');
  assert.match(restricted.docker, /-v "\$PWD\/ca\.crt:\/certs\/ca\.crt:ro"/);
  assert.match(
    restricted.linux,
    /GATEWAY_CA_FILE="\$PWD\/ca\.crt" sh connector-linux\/install\.sh/,
    'the systemd installer receives the CA',
  );
  assert.match(restricted.windows, /Import-Certificate -FilePath ca\.crt/);
  assert.match(restricted.chrome, /trust store/);
  const openshell = machineInstallSnippets(
    { device_id: 'os-1', platform: 'openshell' },
    'dv_test-token-123456',
    'wss://harness.example.com:8443',
    opts,
  );
  assert.match(openshell.openshell, /cat > certs\/ca\.crt <<'OPENHARNESS_CA'/);
  assert.match(openshell.openshell, /OPENHARNESS_CA_FILE=\/certs\/ca\.crt/);
  assert.ok(!openshell.openshell.includes('copy the server'), 'no copy instruction once the CA is embedded');
  // A plaintext gateway has no certificate to trust, and anything that is not a PEM certificate is ignored.
  const plain = machineInstallSnippets(
    { device_id: 'vm1', access_mode: 'host' },
    'dv_test-token-123456',
    'ws://192.0.2.1:8090',
    opts,
  );
  assert.ok(!plain.docker.includes('OPENHARNESS_CA'));
  const injected = machineInstallSnippets(
    { device_id: 'vm1' },
    'dv_test-token-123456',
    'wss://harness.example.com',
    {
      caPem: '-----BEGIN CERTIFICATE-----\nOPENHARNESS_CA\nrm -rf /\n-----END CERTIFICATE-----',
    },
  );
  assert.ok(!injected.docker.includes('rm -rf'), 'only base64 certificate bodies are embedded');
  assert.match(injected.docker, /Self-signed harness certificate\?/);
});
