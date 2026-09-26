import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const enabled = process.env.TEST_LINUX_INSTALLER === 'true';
const project = process.env.TEST_COMPOSE_PROJECT ?? '';
const base = process.env.TEST_BASE_URL ?? 'http://localhost:18088';
const exec = promisify(execFile);
let cookie = '';
async function ok(path: string, data?: unknown) {
  const r = await fetch(base + '/api' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await r.json();
  assert.ok(r.ok, `${path}: ${r.status} ${JSON.stringify(result)}`);
  return result;
}
async function compose(...args: string[]) {
  assert.match(project, /^openharness-test-/, 'installer tests require an isolated Compose project');
  return exec(
    'docker',
    ['compose', '-p', project, '-f', 'compose.yaml', '-f', 'tests/compose.test.yaml', ...args],
    { timeout: 120000, maxBuffer: 2_000_000 },
  );
}
async function inInstaller(script: string) {
  return (await compose('exec', '-T', 'installer', 'node', '--input-type=module', '-e', script)).stdout;
}
async function online(deviceId: string) {
  for (let i = 0; i < 60; i++) {
    const device = (await ok('/devices')).machines.find((d: any) => d.device_id === deviceId);
    if (device?.online && device.tools?.length) return device;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Installed connector did not connect to the gateway');
}
before(async () => {
  if (!enabled) return;
  const credentials = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
  if ((await ok('/auth/status')).needsSetup) {
    const setupToken = (await readFile('.env', 'utf8'))
      .split('\n')
      .find((l) => l.startsWith('SETUP_TOKEN='))!
      .slice(12);
    await ok('/auth/setup', { ...credentials, name: 'Test administrator', setupToken });
  }
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
});
after(async () => {
  if (enabled) await compose('rm', '-sf', 'installer');
});

for (const scheme of ['ws', 'wss']) {
  test(
    `Ubuntu installer connects over ${scheme}, repairs permissions and restarts with a rotated token`,
    { skip: !enabled, timeout: 180000 },
    async () => {
      await compose('up', '--no-build', '--no-deps', '--force-recreate', '-d', 'installer');
      const deviceId = `install-${scheme}-${randomUUID().slice(0, 8)}`;
      const enrollment = await ok('/devices', {
        name: `Installer ${scheme}`,
        platform: 'linux',
        deviceId,
        allowedTools: ['run_command', 'system_info'],
      });
      const url = scheme === 'ws' ? 'ws://gateway:8090/connect' : 'wss://installer:9443/connect';
      async function install(token: string, gatewayUrl: string) {
        await compose(
          'exec',
          '-T',
          '-e',
          `GATEWAY_URL=${gatewayUrl}`,
          '-e',
          `DEVICE_ID=${deviceId}`,
          '-e',
          `DEVICE_TOKEN=${token}`,
          '-e',
          `GATEWAY_ALLOW_INSECURE=${gatewayUrl.startsWith('ws://')}`,
          'installer',
          'sh',
          '/app/connector-linux/install.sh',
        );
      }
      await install(enrollment.token, url);
      await online(deviceId);
      const state = JSON.parse(
        await inInstaller(
          String.raw`import fs from 'node:fs'; const root='/etc/openharness-connector'; const config=JSON.parse(fs.readFileSync(root+'/config.json','utf8')); const group=fs.readFileSync('/etc/group','utf8').split('\n').find(l=>l.startsWith('openharness-connector:')).split(':')[2]; console.log(JSON.stringify({config,group:Number(group),configGid:fs.statSync(root+'/config.json').gid,configUid:fs.statSync(root+'/config.json').uid,mode:fs.statSync(root+'/config.json').mode&511,tokenMode:fs.statSync(root+'/token').mode&511,unit:fs.readFileSync('/etc/systemd/system/openharness-connector.service','utf8')}));`,
        ),
      );
      assert.equal(state.config.allow_insecure, scheme === 'ws');
      assert.equal(state.config.gateway_url, url);
      assert.equal(state.mode, 0o640);
      assert.equal(state.configUid, 0);
      assert.equal(state.configGid, state.group);
      assert.equal(state.tokenMode, 0o600);
      assert.match(state.unit, /ExecStart="\/usr\/local\/bin\/node"/);
      // Reproduce the old ownership bug and retain a customized policy through reinstallation.
      await inInstaller(
        `import fs from 'node:fs'; const p='/etc/openharness-connector/config.json'; const c=JSON.parse(fs.readFileSync(p,'utf8')); c.allow_commands=['uname']; c.read_only=true; c.token='legacy-inline-token-is-obsolete'; fs.writeFileSync(p,JSON.stringify(c)); fs.chownSync(p,0,0);`,
      );
      const rotated = await ok(`/devices/${deviceId}/rotate-token`, {});
      assert.notEqual(rotated.token, enrollment.token);
      const updatedUrl = scheme === 'ws' ? 'wss://installer:9443/connect' : 'ws://gateway:8090/connect';
      await install(rotated.token, updatedUrl);
      await online(deviceId);
      const updated = JSON.parse(
        await inInstaller(
          `import fs from 'node:fs'; const p='/etc/openharness-connector/config.json'; console.log(JSON.stringify({config:JSON.parse(fs.readFileSync(p,'utf8')),gid:fs.statSync(p).gid,calls:fs.readFileSync('/run/installer-systemctl.log','utf8')}));`,
        ),
      );
      assert.equal(updated.gid, state.group);
      assert.equal(updated.config.gateway_url, updatedUrl);
      assert.equal(updated.config.allow_insecure, updatedUrl.startsWith('ws://'));
      assert.equal(updated.config.token, undefined);
      assert.deepEqual(updated.config.allow_commands, ['uname']);
      assert.equal(updated.config.read_only, true);
      assert.equal(updated.calls.match(/restart openharness-connector/g)?.length, 2);
      // Run a real, read-only command through the newly enrolled connector and gateway.
      const provider = await ok('/providers', {
        name: `Installer model ${scheme}`,
        kind: 'openai-compatible',
        baseUrl: 'http://fixtures:9090/v1',
        model: 'test-chat',
      });
      const agent = await ok('/agents', {
        name: 'Installed machine probe',
        providerId: provider.id,
        systemPrompt: 'Use the selected machine tools.',
      });
      const started = await ok('/runs', {
        agentId: agent.id,
        input: 'Please run uname on the machine',
        deviceId,
      });
      let result;
      for (let i = 0; i < 120; i++) {
        result = await ok(`/runs/${started.id}`);
        if (!['queued', 'running'].includes(result.status)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.equal(result.status, 'succeeded', result.error);
      assert.match(result.output, /Linux/);
    },
  );
}
