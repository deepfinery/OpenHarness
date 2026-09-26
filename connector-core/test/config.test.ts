import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConnectorConfig } from '../src/config.js';

test('missing config preserves ENOENT as its cause', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'config-missing-'));
  try {
    await assert.rejects(loadConnectorConfig({ path: join(dir, 'absent.json'), env: {} }), (error: any) => {
      assert.match(error.message, /config file not found/);
      assert.equal(error.cause.code, 'ENOENT');
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'permission errors identify EACCES instead of claiming the file is absent',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'config-denied-'));
    const path = join(dir, 'config.json');
    try {
      await chmod(dir, 0o755);
      await writeFile(path, '{}', { mode: 0o000 });
      const script = `import { loadConnectorConfig } from ${JSON.stringify(new URL('../src/config.ts', import.meta.url).href)};
      try { await loadConnectorConfig({path: process.env.CONFIG_TEST_PATH, env:{}}); process.exitCode=1; }
      catch(error) { console.log(JSON.stringify({message:error.message, code:error.cause?.code})); }`;
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        {
          env: { ...process.env, CONFIG_TEST_PATH: path, TSX_DISABLE_CACHE: '1' },
          ...(process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {}),
        },
      );
      const error = JSON.parse(stdout);
      assert.equal(error.code, 'EACCES');
      assert.match(error.message, /cannot read config file.*EACCES/);
      assert.doesNotMatch(error.message, /not found/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
