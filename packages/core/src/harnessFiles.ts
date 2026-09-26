import { randomUUID, createHash } from 'node:crypto';
import { collection } from './db.js';
import { saveFile, readStoredFile, removeFile } from './storage.js';
import { HttpError } from './security.js';
export type HarnessFile = {
  _id: string;
  ownerId: string;
  harnessId: string;
  path: string;
  type: 'file' | 'directory';
  storageKey?: string;
  size: number;
  mimeType: string;
  modifiedAt: Date;
};
export function normalizeHarnessPath(raw: string, root = false) {
  if (
    raw.length > 500 ||
    raw.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(raw) ||
    raw.split('/').some((p) => p === '..' || p === '.') ||
    /%[0-9a-f]{2}/i.test(raw)
  )
    throw new HttpError(400, 'Invalid workspace path');
  const path = raw.replace(/^\/+|\/+$/g, '');
  if (!root && !path) throw new HttpError(400, 'File path is required');
  return path;
}
const key = (ownerId: string, harnessId: string, path: string) =>
  createHash('sha256')
    .update(JSON.stringify([ownerId, harnessId, path]))
    .digest('hex');
export const harnessFiles = () => collection<HarnessFile>('harness_files');
export function fileInfo(f: HarnessFile) {
  return {
    path: f.path,
    name: f.path.split('/').at(-1),
    type: f.type,
    size_bytes: f.size,
    mime_type: f.mimeType,
    modified_at: f.modifiedAt.toISOString(),
  };
}
export async function getHarnessFile(ownerId: string, harnessId: string, raw: string) {
  const path = normalizeHarnessPath(raw);
  const f = await harnessFiles().findOne({ _id: key(ownerId, harnessId, path), ownerId, harnessId });
  if (!f) throw new HttpError(404, 'File not found');
  return f;
}
export async function mkdirHarness(ownerId: string, harnessId: string, raw: string) {
  const path = normalizeHarnessPath(raw);
  let created = false;
  let last: HarnessFile | undefined;
  const segments = path.split('/');
  for (let i = 1; i <= segments.length; i++) {
    const part = segments.slice(0, i).join('/'),
      _id = key(ownerId, harnessId, part);
    const row: HarnessFile = {
      _id,
      ownerId,
      harnessId,
      path: part,
      type: 'directory',
      size: 0,
      mimeType: 'inode/directory',
      modifiedAt: new Date(),
    };
    try {
      const r = await harnessFiles().updateOne(
        { _id, ownerId, harnessId },
        { $setOnInsert: row },
        { upsert: true },
      );
      created = Boolean(r.upsertedCount);
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
    last = (await harnessFiles().findOne({ _id, ownerId, harnessId })) ?? undefined;
    if (last?.type !== 'directory') throw new HttpError(409, 'Parent path is a file');
  }
  return { file: fileInfo(last!), created };
}
export async function writeHarnessFile(
  ownerId: string,
  harnessId: string,
  raw: string,
  content: Buffer,
  overwrite = true,
  mimeType = 'text/plain',
) {
  const path = normalizeHarnessPath(raw);
  if (content.length > 10 * 1024 * 1024) throw new HttpError(413, 'File exceeds 10 MiB');
  const old = await harnessFiles().findOne({ _id: key(ownerId, harnessId, path), ownerId, harnessId });
  if (old && (!overwrite || old.type === 'directory')) throw new HttpError(409, 'Path already exists');
  const parent = path.split('/').slice(0, -1).join('/');
  if (parent) await mkdirHarness(ownerId, harnessId, parent);
  const storageKey = `${ownerId}/${randomUUID()}`;
  await saveFile(storageKey, content);
  const row: HarnessFile = {
    _id: key(ownerId, harnessId, path),
    ownerId,
    harnessId,
    path,
    type: 'file',
    storageKey,
    size: content.length,
    mimeType,
    modifiedAt: new Date(),
  };
  try {
    if (old) {
      const r = await harnessFiles().replaceOne(
        { _id: old._id, ownerId, harnessId, storageKey: old.storageKey },
        row,
      );
      if (!r.modifiedCount) throw new HttpError(409, 'File changed; retry');
    } else await harnessFiles().insertOne(row);
  } catch (e) {
    await removeFile(storageKey);
    if ((e as { code?: number }).code === 11000) throw new HttpError(409, 'File already exists');
    throw e;
  }
  if (old?.storageKey) await removeFile(old.storageKey);
  return { file: fileInfo(row), created: !old };
}
export async function readHarnessFile(f: HarnessFile) {
  if (f.type !== 'file' || !f.storageKey) throw new HttpError(409, 'Path is a directory');
  return readStoredFile(f.storageKey);
}
export async function deleteHarnessFile(ownerId: string, harnessId: string, raw: string, recursive = false) {
  const f = await getHarnessFile(ownerId, harnessId, raw);
  const children =
    f.type === 'directory'
      ? (await harnessFiles().find({ ownerId, harnessId }).toArray()).filter((x) =>
          x.path.startsWith(f.path + '/'),
        )
      : [];
  if (children.length && !recursive) throw new HttpError(409, 'Directory is not empty');
  for (const row of [...children, f]) {
    await harnessFiles().deleteOne({ _id: row._id, ownerId, harnessId });
    if (row.storageKey) await removeFile(row.storageKey);
  }
}
