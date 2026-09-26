import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

test('installer updates enrollment, safely encodes URLs and preserves policy while rotating legacy tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'install-config-'));
  try {
    const source = join(dir, 'source.json');
    const output = join(dir, 'output.json');
    const example = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
    await writeFile(
      source,
      JSON.stringify({
        ...example,
        platform: 'windows',
        allow_commands: ['echo'],
        read_only: true,
        token: 'legacy-token-should-not-win',
      }),
    );
    const env = {
      ...process.env,
      GATEWAY_URL: 'ws://gateway.example/a"quoted"&two/connect',
      DEVICE_ID: 'new-machine',
      DEVICE_TOKEN: 'new-device-token-12345',
      GATEWAY_ALLOW_INSECURE: 'true',
    };
    await exec(
      process.execPath,
      [new URL('../install-config.mjs', import.meta.url).pathname, source, output, '/etc/test/token'],
      { env },
    );
    const config = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(config.gateway_url, env.GATEWAY_URL);
    assert.equal(config.device_id, env.DEVICE_ID);
    assert.equal(config.platform, 'linux');
    assert.equal(config.allow_insecure, true);
    assert.equal(config.token, undefined);
    assert.equal(config.token_file, '/etc/test/token');
    assert.deepEqual(config.allow_commands, ['echo']);
    assert.equal(config.read_only, true);
    const second = join(dir, 'second.json');
    await exec(
      process.execPath,
      [new URL('../install-config.mjs', import.meta.url).pathname, output, second, '/etc/test/token'],
      { env: { ...env, GATEWAY_URL: 'wss://gateway.example/connect', GATEWAY_ALLOW_INSECURE: 'false' } },
    );
    assert.equal(JSON.parse(await readFile(second, 'utf8')).allow_insecure, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
