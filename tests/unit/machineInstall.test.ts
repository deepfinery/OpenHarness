import { test } from 'node:test';
import assert from 'node:assert/strict';
import { machineInstallSnippets } from '../../packages/core/src/machineInstall.js';
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
