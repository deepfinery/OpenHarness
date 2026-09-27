#!/usr/bin/env node
// Parse the enrollment file as data; never source credentials into a shell.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const [file, option, ...extra] = process.argv.slice(2);
if (process.getuid?.() !== 0 || !file || extra.length || (option && option !== '--host-access'))
  throw new Error('Usage: sudo node connector-linux/install-cluster-native.mjs cluster.env [--host-access]');
const env = {};
for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
  if (!line.trim() || line.startsWith('#')) continue;
  const match = /^(GATEWAY_URL|DEVICE_TOKEN|GATEWAY_ALLOW_INSECURE)=(.*)$/.exec(line);
  if (!match || Object.hasOwn(env, match[1]))
    throw new Error('Invalid or duplicate cluster environment setting');
  env[match[1]] = match[2];
}
if (!env.GATEWAY_URL || !env.DEVICE_TOKEN) throw new Error('Cluster URL and token are required');
const machine = readFileSync('/etc/machine-id');
if (!machine.toString().trim()) throw new Error('A unique /etc/machine-id is required');
env.DEVICE_ID = 'gpu-' + createHash('sha256').update(machine).digest('hex').slice(0, 24);
const dir = dirname(fileURLToPath(import.meta.url));
function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: environment });
  if (result.error || result.status !== 0) throw new Error(`Installation step failed: ${command}`);
}
// This installer owns only this drop-in. Returning to unprivileged mode removes it.
if (option !== '--host-access') {
  rmSync('/etc/systemd/system/openharness-connector.service.d/host-access.conf', { force: true });
}
run('sh', [join(dir, 'install.sh')], { ...process.env, ...env });
if (option === '--host-access') {
  // Explicit root host diagnostics. Remediation still requires node + gateway authorization.
  const dropin = '/etc/systemd/system/openharness-connector.service.d';
  mkdirSync(dropin, { recursive: true });
  mkdirSync('/var/lib/openharness-cluster', { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dropin, 'host-access.conf'),
    `[Service]\nUser=root\nGroup=root\nPrivateDevices=false\nProtectSystem=false\nProtectHome=false\nProtectKernelTunables=false\nProtectKernelModules=false\nProtectControlGroups=false\nNoNewPrivileges=false\nCapabilityBoundingSet=~\nEnvironment=HOST_ACCESS=true\nEnvironment=HOST_STATE_DIR=/var/lib/openharness-cluster\n`,
    { mode: 0o600 },
  );
  run('systemctl', ['daemon-reload']);
  run('systemctl', ['restart', 'openharness-connector']);
}
