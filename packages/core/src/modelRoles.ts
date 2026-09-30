import { createHash } from 'node:crypto';
import { collection } from './db.js';
import { HttpError } from './security.js';
import { ownedProvider, type ProviderRecord } from './llm.js';

export const modelType = (p: { modelType?: string }) => p.modelType ?? 'llm';
export async function requireModel(ownerId: string, id: string, role: 'chat' | 'vision' | 'embedding') {
  const p = await ownedProvider(ownerId, id);
  const type = modelType(p);
  if (
    role === 'chat'
      ? type === 'embedding'
      : role === 'vision'
        ? type !== 'vision'
        : type !== 'embedding' && !(!p.modelType && p.embeddingModel)
  )
    throw new HttpError(400, `Select a ${role === 'chat' ? 'LLM or vision' : role} model for this resource`);
  return p;
}
/** Deterministic IDs make startup retries and concurrent API/runner migrations idempotent. */
export function embeddingCopyId(id: string) {
  const h = createHash('sha256')
    .update('embedding-provider:' + id)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export async function migrateModelRoles(ownerId?: string) {
  const providers = collection<ProviderRecord>('providers');
  for (const p of await providers
    .find({ modelType: { $exists: false }, ...(ownerId ? { ownerId } : {}) })
    .toArray()) {
    if (p.embeddingModel && p.kind !== 'anthropic') {
      const id = embeddingCopyId(p._id);
      const { _id, embeddingModel, ...rest } = p;
      await providers.updateOne(
        { _id: id, ownerId: p.ownerId },
        {
          $setOnInsert: {
            ...rest,
            _id: id,
            name: `${p.name.slice(0, 85)} · Embedding`,
            modelType: 'embedding',
            legacyEmbeddingSourceId: p._id,
            model: embeddingModel,
            embeddingModel: '',
          },
        },
        { upsert: true },
      );
      await collection('knowledge').updateMany(
        { ownerId: p.ownerId, providerId: p._id },
        { $set: { providerId: id } },
      );
    }
    await providers.updateOne(
      { _id: p._id, modelType: { $exists: false } },
      { $set: { modelType: 'llm', embeddingModel: '' } },
    );
  }
}
