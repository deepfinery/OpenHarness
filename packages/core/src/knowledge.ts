import { createRequire } from 'node:module';
import mammoth from 'mammoth';
import { collection } from './db.js';
import { hash } from './security.js';
import { embed, ownedProvider } from './llm.js';
import { readStoredFile, removeFile } from './storage.js';
import { chunkText, sanitizeExtractedText } from './chunking.js';
import { storeFor } from './vectorstores/index.js';
import type { KnowledgeBase, KnowledgeDocument, Stored } from './schema.js';

const require = createRequire(import.meta.url);
const parsePdf = require('pdf-parse/lib/pdf-parse.js') as (b: Buffer) => Promise<{ text: string }>;
/** The collection (Weaviate class) name of a knowledge base; the same name is used by every store. */
export const knowledgeClass = (id: string) => `Knowledge_${id.replace(/-/g, '')}`;
function chunkId(documentId: string, index: number) {
  const h = hash(`${documentId}:${index}`).slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
}
export async function extractText(buffer: Buffer, filename: string) {
  const extension = filename.split('.').pop()?.toLowerCase();
  let text: string;
  if (extension === 'pdf') text = (await parsePdf(buffer)).text;
  else if (extension === 'docx') text = (await mammoth.extractRawText({ buffer })).value;
  else if (['txt', 'md', 'csv', 'json', 'yaml', 'yml'].includes(extension ?? ''))
    text = buffer.toString('utf8');
  else throw new Error('Supported files: TXT, Markdown, CSV, JSON, YAML, text PDF and DOCX');
  text = sanitizeExtractedText(text);
  if (!text) throw new Error('No searchable text found. Scanned files need OCR before upload.');
  if (text.length > 2000000)
    throw new Error('Extracted text exceeds 2 million characters. Split this document before upload.');
  return text;
}
export async function indexDocument(doc: KnowledgeDocument, signal: AbortSignal) {
  const kb = await collection<Stored<KnowledgeBase>>('knowledge').findOne({
    _id: doc.knowledgeBaseId,
    ownerId: doc.ownerId,
  });
  if (!kb) throw new Error('Knowledge base no longer exists');
  const store = storeFor(kb);
  const name = knowledgeClass(kb._id);
  const provider = await ownedProvider(doc.ownerId, kb.providerId);
  const text = await extractText(await readStoredFile(doc.storageKey), doc.filename);
  const chunks = chunkText(text);
  if (!chunks.length) throw new Error('No useful text found in this document');
  let ready = false;
  for (let index = 0; index < chunks.length; index += 10) {
    signal.throwIfAborted();
    const batch = [];
    for (const [offset, content] of chunks.slice(index, index + 10).entries()) {
      const vector = await embed(provider, content, signal);
      // Stores that fix vector dimensions at creation learn them from the first embedding.
      if (!ready) {
        await store.ensureCollection(name, vector.length, signal);
        await store.deleteDocument(name, doc.ownerId, doc._id, signal);
        ready = true;
      }
      batch.push({
        id: chunkId(doc._id, index + offset),
        vector,
        ownerId: doc.ownerId,
        documentId: doc._id,
        chunkIndex: index + offset,
        title: doc.filename,
        content,
      });
    }
    await store.upsert(name, batch, signal);
  }
  return chunks.length;
}
export async function deleteDocument(doc: KnowledgeDocument) {
  const kb = await collection<Stored<KnowledgeBase>>('knowledge').findOne({
    _id: doc.knowledgeBaseId,
    ownerId: doc.ownerId,
  });
  await storeFor(kb ?? {}).deleteDocument(knowledgeClass(doc.knowledgeBaseId), doc.ownerId, doc._id);
  await removeFile(doc.storageKey);
  await collection<KnowledgeDocument>('documents').deleteOne({
    _id: doc._id,
    ownerId: doc.ownerId,
    status: 'deleting',
  });
}
/** Removes a deleted knowledge base's index. Best effort: a missing index is fine. */
export async function dropKnowledgeIndex(kb: { _id: string; vectorStore?: KnowledgeBase['vectorStore'] }) {
  await storeFor(kb).dropCollection(knowledgeClass(kb._id));
}
export type KnowledgeChunk = { documentId: string; title: string; content: string; chunkIndex: number };
export async function searchKnowledge(
  ownerId: string,
  knowledgeBaseId: string,
  query: string,
  signal?: AbortSignal,
): Promise<KnowledgeChunk[]> {
  const kb = await collection<Stored<KnowledgeBase>>('knowledge').findOne({ _id: knowledgeBaseId, ownerId });
  if (!kb) throw new Error('Knowledge base not found');
  const ready = await collection<KnowledgeDocument>('documents')
    .find({ knowledgeBaseId, ownerId, status: 'ready' }, { projection: { _id: 1 } })
    .toArray();
  if (!ready.length) return [];
  const vector = await embed(await ownedProvider(ownerId, kb.providerId), query, signal);
  const hits = await storeFor(kb).search(
    knowledgeClass(kb._id),
    { ownerId, vector, text: query, limit: 8 },
    signal,
  );
  const allowed = new Set(ready.map((d) => d._id));
  return hits
    .filter((c) => allowed.has(c.documentId))
    .slice(0, 6)
    .map(({ documentId, title, content, chunkIndex }) => ({ documentId, title, content, chunkIndex }));
}
