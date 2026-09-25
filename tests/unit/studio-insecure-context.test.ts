import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The studio is often opened over plain HTTP on a LAN address, which is not a secure context. There
// crypto.randomUUID and crypto.subtle do not exist, and calling them breaks the editor (drops, new cards).
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)])),
  );
  return nested.flat().filter((f) => /\.(ts|tsx)$/.test(f));
}
test('studio code avoids APIs that exist only in secure contexts', async () => {
  const offenders: string[] = [];
  for (const file of await files('apps/studio/src')) {
    const source = await readFile(file, 'utf8');
    if (/crypto\.randomUUID\(|crypto\.subtle\./.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'Use crypto.getRandomValues instead');
});
