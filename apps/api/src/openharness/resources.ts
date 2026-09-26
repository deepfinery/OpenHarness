import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { collection } from '../../../../packages/core/src/db.js';
import { requireAccess } from './access.js';
import { notFound, OhError } from './errors.js';

/** Shared resources require a workspace credential; target-scoped keys cannot enumerate them. */
export function workspace(req: Request) {
  return requireAccess(req, 'manage').tenantId;
}
export type RecordData = {
  _id: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  [key: string]: any;
};
export function repository(name: string) {
  const records = () => collection<RecordData>(name);
  return {
    records,
    async get(ownerId: string, id: string) {
      const row = await records().findOne({ _id: id, ownerId });
      if (!row) throw notFound(name);
      return row;
    },
    async create(ownerId: string, data: object) {
      const row = { ...data, _id: randomUUID(), ownerId, createdAt: new Date(), updatedAt: new Date() };
      await records().insertOne(row);
      return row as RecordData;
    },
    async update(row: RecordData, data: object) {
      const result = await records().findOneAndUpdate(
        { _id: row._id, ownerId: row.ownerId, updatedAt: row.updatedAt },
        { $set: { ...data, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
      if (!result) throw new OhError(409, 'CONFLICT', 'Resource changed; reload and try again');
      return result;
    },
    async remove(row: RecordData) {
      await records().deleteOne({ _id: row._id, ownerId: row.ownerId });
    },
  };
}
export function safePath(value: unknown, root = false): string {
  const raw = z
    .string()
    .max(500)
    .parse(Array.isArray(value) ? value.join('/') : value);
  if (
    raw.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(raw) ||
    raw.split('/').some((p) => p === '..' || p === '.') ||
    /%[0-9a-f]{2}/i.test(raw)
  )
    throw new OhError(400, 'VALIDATION_ERROR', 'Use a relative workspace path without traversal');
  const path = raw.replace(/^\/+|\/+$/g, '');
  if ((!path && !root) || path.split('/').some((p) => p === '__proto__' || p === 'constructor'))
    throw new OhError(400, 'VALIDATION_ERROR', 'Invalid workspace path');
  return path;
}
export async function multipart(req: Request, res: Response, maxBytes = 10 * 1024 * 1024) {
  let total = 0;
  const storage: multer.StorageEngine = {
    _handleFile(_req, file, done) {
      const chunks: Buffer[] = [];
      let size = 0,
        finished = false;
      const finish = (error: Error | null) => {
        if (finished) return;
        finished = true;
        done(error, error ? undefined : { buffer: Buffer.concat(chunks), size });
        chunks.length = 0;
      };
      file.stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        size += chunk.length;
        if (total > maxBytes) finish(new OhError(413, 'VALIDATION_ERROR', 'Upload exceeds total size limit'));
        else if (!finished) chunks.push(chunk);
      });
      file.stream.on('error', finish);
      file.stream.on('end', () => finish(null));
    },
    _removeFile(_req, file, done) {
      delete (file as Partial<Express.Multer.File>).buffer;
      done(null);
    },
  };
  const upload = multer({
    storage,
    preservePath: true,
    limits: { fileSize: maxBytes, files: 100, fields: 20, fieldSize: 100000, parts: 120 },
  }).any();
  await new Promise<void>((resolve, reject) => upload(req, res, (e) => (e ? reject(e) : resolve())));
  const files = (req.files ?? []) as Express.Multer.File[];
  if (files.reduce((n, f) => n + f.size, 0) > maxBytes)
    throw new OhError(413, 'VALIDATION_ERROR', 'Upload exceeds total size limit');
  return files;
}
