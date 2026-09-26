import { randomUUID } from 'node:crypto';
import { collection } from './db.js';
import { saveFile, readStoredFile, removeFile } from './storage.js';
import type { Run } from './schema.js';
export type Artifact = {
  _id: string;
  ownerId: string;
  runId: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
  createdAt: Date;
};
const MAX_BYTES = 5 * 1024 * 1024;
export const artifactView = (a: Artifact) => ({
  id: a._id,
  name: a.name,
  mime_type: a.mimeType,
  size_bytes: a.size,
});
export async function recordArtifact(
  ownerId: string,
  runId: string,
  name: string,
  mimeType: string,
  bytes: Buffer,
) {
  if (bytes.length > MAX_BYTES) return;
  const _id = randomUUID();
  const artifact: Artifact = {
    _id,
    ownerId,
    runId,
    name:
      name
        .split(/[\\/]/)
        .at(-1)!
        .replace(/[\x00-\x1f\x7f";]/g, '_')
        .slice(0, 200) || 'artifact',
    mimeType: /^[\w.+-]+\/[\w.+-]+$/.test(mimeType) ? mimeType : 'application/octet-stream',
    size: bytes.length,
    storageKey: `${ownerId}/${_id}`,
    createdAt: new Date(),
  };
  // Reserve one slot atomically, including parallel writers in the same workflow.
  const reserved = await collection<Run>('runs').updateOne(
    { _id: runId, ownerId, $expr: { $lt: [{ $size: { $ifNull: ['$artifactIds', []] } }, 50] } },
    { $addToSet: { artifactIds: _id } },
  );
  if (!reserved.modifiedCount) return;
  try {
    await saveFile(artifact.storageKey, bytes);
    await collection<Artifact>('artifacts').insertOne(artifact);
  } catch (error) {
    await removeFile(artifact.storageKey).catch(() => {});
    await collection<Run>('runs')
      .updateOne({ _id: runId, ownerId }, { $pull: { artifactIds: _id } })
      .catch(() => {});
    throw error;
  }
  return artifact;
}
export async function listArtifacts(ownerId: string, runId: string) {
  return (
    await collection<Artifact>('artifacts').find({ ownerId, runId }).sort({ createdAt: 1 }).toArray()
  ).map(artifactView);
}
export async function artifactContent(ownerId: string, runId: string, id: string) {
  const artifact = await collection<Artifact>('artifacts').findOne({ _id: id, ownerId, runId });
  return artifact ? { artifact, bytes: await readStoredFile(artifact.storageKey) } : undefined;
}
/** Only embedded MCP resources are files. Never dereference model/tool supplied URLs or server paths. */
export async function recordToolArtifacts(ownerId: string, runId: string, result: unknown) {
  const r = result as {
    isError?: boolean;
    content?: {
      type: string;
      resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
    }[];
  };
  if (r?.isError || !Array.isArray(r?.content)) return;
  for (const block of r.content.slice(0, 50)) {
    if (block.type !== 'resource' || !block.resource) continue;
    const resource = block.resource;
    const content =
      typeof resource.text === 'string'
        ? Buffer.from(resource.text)
        : typeof resource.blob === 'string' && resource.blob.length <= MAX_BYTES * 1.4
          ? Buffer.from(resource.blob, 'base64')
          : undefined;
    if (content)
      await recordArtifact(
        ownerId,
        runId,
        resource.uri ?? 'resource',
        resource.mimeType ?? (resource.text ? 'text/plain' : 'application/octet-stream'),
        content,
      );
  }
}
/** Capture verified machine file bytes, including explicit partial/append labels, without reading host paths. */
export async function recordMachineFile(
  ownerId: string,
  runId: string,
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
) {
  if (!['read_file', 'write_file'].includes(tool)) return;
  const r = result as { isError?: boolean; content?: { type?: string; text?: string }[] };
  if (r?.isError || !Array.isArray(r.content)) return;
  for (const block of r.content) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    let value;
    try {
      value = JSON.parse(block.text);
    } catch {
      continue;
    }
    if (tool === 'read_file' && typeof value.path === 'string' && typeof value.content === 'string')
      await recordArtifact(
        ownerId,
        runId,
        value.path + (value.truncated ? '.partial.txt' : ''),
        'text/plain',
        Buffer.from(value.content),
      );
    if (
      tool === 'write_file' &&
      typeof value.path === 'string' &&
      typeof args.content === 'string' &&
      value.bytes === Buffer.byteLength(args.content)
    )
      await recordArtifact(
        ownerId,
        runId,
        value.path + (value.mode === 'append' ? '.append.txt' : ''),
        'text/plain',
        Buffer.from(args.content),
      );
  }
}
