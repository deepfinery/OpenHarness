import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Policy, PolicyError } from '../src/policy.js';

async function jail() {
  const root = await mkdtemp(join(tmpdir(), 'jail-'));
  const work = join(root, 'work');
  const outside = join(root, 'outside');
  await mkdir(join(work, 'sub'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'nope');
  await writeFile(join(work, 'ok.txt'), 'fine');
  await symlink(outside, join(work, 'escape'));
  await symlink(join(outside, 'secret.txt'), join(work, 'link.txt'));
  return { work, outside };
}
test('path jail follows symlinks and blocks every route out of the work directory', async () => {
  const { work, outside } = await jail();
  const policy = await Policy.create({
    workDir: work,
    allowCommands: ['ls', 'cat'],
    denyCommands: ['rm'],
    allowShell: false,
    maxOutputBytes: 100,
    commandTimeoutMs: 1000,
    readOnly: false,
  });
  assert.equal(await policy.resolvePath('ok.txt'), join(work, 'ok.txt'));
  assert.equal(
    await policy.resolvePath('sub/new/file.txt', { write: true }),
    join(work, 'sub', 'new', 'file.txt'),
  );
  await assert.rejects(policy.resolvePath('../outside/secret.txt'), PolicyError);
  await assert.rejects(policy.resolvePath(join(outside, 'secret.txt')), PolicyError);
  await assert.rejects(policy.resolvePath('escape/secret.txt'), PolicyError, 'symlinked directory');
  await assert.rejects(policy.resolvePath('link.txt'), PolicyError, 'symlinked file');
  await assert.rejects(
    policy.resolvePath('escape/new.txt', { write: true }),
    PolicyError,
    'write through symlink',
  );
  await assert.rejects(policy.resolvePath('a\0b'), PolicyError);
  assert.deepEqual(policy.checkCommand(['ls', '-la']), { program: 'ls', name: 'ls' });
  assert.deepEqual(policy.checkCommand(['/bin/cat', 'x']).name, 'cat');
  assert.throws(() => policy.checkCommand(['rm', '-rf', '/']), PolicyError);
  assert.throws(() => policy.checkCommand(['curl', 'x']), PolicyError);
  assert.throws(() => policy.checkCommand([]), PolicyError);
  assert.throws(() => policy.checkShell(), PolicyError);
  assert.equal(policy.timeoutMs(5000), 1000, 'requests cannot exceed the configured timeout');
  const capped = policy.capOutput('x'.repeat(150));
  assert.equal(capped.truncated, true);
  assert.match(capped.text, /truncated 50 bytes/);
  const ro = await Policy.create({
    workDir: work,
    allowCommands: ['*'],
    denyCommands: [],
    allowShell: false,
    maxOutputBytes: 10,
    commandTimeoutMs: 10,
    readOnly: true,
  });
  await assert.rejects(ro.resolvePath('ok.txt', { write: true }), PolicyError);
  assert.equal(await ro.resolvePath('ok.txt'), join(work, 'ok.txt'));
  assert.equal(ro.checkCommand(['anything']).name, 'anything', 'wildcard allows any program not denied');
});
