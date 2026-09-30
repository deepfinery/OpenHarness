import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { collection } from './db.js';
import { HttpError } from './security.js';
import { readStoredFile, removeFile, saveFile } from './storage.js';

export type ImageAttachment = {
  _id: string;
  ownerId: string;
  filename: string;
  storageKey: string;
  mimeType: 'image/jpeg';
  size: number;
  width: number;
  height: number;
  createdAt: Date;
};
export const imageAttachments = () => collection<ImageAttachment>('image_attachments');
export async function saveImage(ownerId: string, filename: string, buffer: Buffer) {
  if (!buffer.length || buffer.length > 10 * 1024 * 1024)
    throw new HttpError(400, 'Images must be between 1 byte and 10 MB');
  const total = await imageAttachments()
    .aggregate<{ bytes: number }>([
      { $match: { ownerId } },
      { $group: { _id: null, bytes: { $sum: '$size' } } },
    ])
    .next();
  if ((total?.bytes ?? 0) >= 1024 * 1024 * 1024)
    throw new HttpError(413, 'Workspace image storage limit reached (1 GB)');
  let output;
  try {
    const input = sharp(buffer, { limitInputPixels: 25000000, animated: false });
    const meta = await input.metadata();
    if (!['png', 'jpeg', 'webp'].includes(meta.format ?? '') || (meta.pages ?? 1) > 1)
      throw new Error('Unsupported image');
    // Decode before accepting; strip metadata and cap resolution/storage for every provider.
    output = await input
      .rotate()
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#fff' })
      .jpeg({ quality: 90 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new HttpError(400, 'Upload a valid PNG, JPEG or WebP image (up to 25 megapixels)');
  }
  const id = randomUUID();
  const doc: ImageAttachment = {
    _id: id,
    ownerId,
    filename: filename.replace(/[\r\n\0/\\]/g, '_').slice(0, 180),
    storageKey: `${ownerId}/${id}`,
    mimeType: 'image/jpeg',
    size: output.data.length,
    width: output.info.width,
    height: output.info.height,
    createdAt: new Date(),
  };
  await saveFile(doc.storageKey, output.data);
  try {
    await imageAttachments().insertOne(doc);
  } catch (e) {
    await removeFile(doc.storageKey);
    throw e;
  }
  return doc;
}
export async function ownedImage(ownerId: string, id: string) {
  const doc = await imageAttachments().findOne({ _id: id, ownerId });
  if (!doc) throw new HttpError(404, 'Image attachment unavailable');
  return doc;
}
export async function imageData(ownerId: string, id: string) {
  const doc = await ownedImage(ownerId, id);
  return { mimeType: doc.mimeType, data: (await readStoredFile(doc.storageKey)).toString('base64') };
}
