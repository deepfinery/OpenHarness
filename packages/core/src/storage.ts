import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { config } from './config.js';
export function filePath(key: string) {
  if (!/^[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(key)) throw new Error('Invalid storage key');
  const root = resolve(config.DATA_DIR, 'files');
  const result = resolve(root, key);
  if (!result.startsWith(`${root}/`)) throw new Error('Invalid storage path');
  return result;
}
export async function saveFile(key: string, content: Buffer) {
  const path = filePath(key);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { flag: 'wx', mode: 0o600 });
}
export const readStoredFile = (key: string) => readFile(filePath(key));
export async function removeFile(key: string) {
  await unlink(filePath(key)).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
  });
}
