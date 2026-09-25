import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
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
/** Replaces an existing file atomically: readers see either the old or the new content, never a partial write. */
export async function replaceFile(key: string, content: Buffer) {
  const path = filePath(key);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temp, content, { flag: 'wx', mode: 0o600 });
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}
export const readStoredFile = (key: string) => readFile(filePath(key));
export async function removeFile(key: string) {
  await unlink(filePath(key)).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
  });
}
