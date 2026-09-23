import { createRequire } from 'node:module';
import mammoth from 'mammoth';
import { config } from './config.js';
import { collection } from './db.js';
import { hash } from './security.js';
import { embed, ownedProvider } from './llm.js';
import { readStoredFile, removeFile } from './storage.js';
import { chunkText, sanitizeExtractedText } from './chunking.js';
import type { KnowledgeBase, KnowledgeDocument, Stored } from './schema.js';

const require = createRequire(import.meta.url);
const parsePdf = require('pdf-parse/lib/pdf-parse.js') as (b: Buffer) => Promise<{ text: string }>;
export const knowledgeClass = (id: string) => `Knowledge_${id.replace(/-/g, '')}`;
async function weaviate(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
  const r = await fetch(`${config.WEAVIATE_URL.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(config.WEAVIATE_API_KEY ? { Authorization: `Bearer ${config.WEAVIATE_API_KEY}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  });
  return r;
}
async function ensureClass(id: string) {
  const name = knowledgeClass(id);
  const existing = await weaviate(`/v1/schema/${name}`);
  if (existing.ok) {
    await existing.body?.cancel();
    return;
  }
  if (existing.status !== 404) throw new Error(`Knowledge storage unavailable (${existing.status})`);
  const r = await weaviate('/v1/schema', 'POST', {
    class: name,
    vectorizer: 'none',
    properties: [
      { name: 'content', dataType: ['text'] },
      { name: 'title', dataType: ['text'] },
      { name: 'ownerId', dataType: ['text'], tokenization: 'field' },
      { name: 'documentId', dataType: ['text'], tokenization: 'field' },
      { name: 'chunkIndex', dataType: ['int'] },
    ],
  });
  if (!r.ok) {
    // Two indexers can race when the first documents arrive together.
    const check = await weaviate(`/v1/schema/${name}`);
    if (!check.ok) throw new Error(`Could not initialize knowledge storage (${r.status})`);
  }
}
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
  const provider = await ownedProvider(doc.ownerId, kb.providerId);
  const text = await extractText(await readStoredFile(doc.storageKey), doc.filename);
  const chunks = chunkText(text);
  if (!chunks.length) throw new Error('No useful text found in this document');
  await ensureClass(kb._id);
  await deleteChunks(doc);
  for (let index = 0; index < chunks.length; index += 10) {
    signal.throwIfAborted();
    const batch = [];
    for (const [offset, content] of chunks.slice(index, index + 10).entries()) {
      const vector = await embed(provider, content, signal);
      batch.push({
        class: knowledgeClass(kb._id),
        id: chunkId(doc._id, index + offset),
        properties: {
          ownerId: doc.ownerId,
          documentId: doc._id,
          chunkIndex: index + offset,
          title: doc.filename,
          content,
        },
        vector,
      });
    }
    const r = await weaviate('/v1/batch/objects', 'POST', { objects: batch }, signal);
    if (!r.ok) throw new Error(`Knowledge indexing failed (${r.status})`);
    const result = (await r.json()) as Array<{ result?: { errors?: unknown } }>;
    if (!Array.isArray(result) || result.some((item) => item.result?.errors))
      throw new Error('Vector indexing failed. Confirm the embedding model and its vector dimensions.');
  }
  return chunks.length;
}
async function deleteChunks(doc: KnowledgeDocument) {
  const response = await weaviate('/v1/batch/objects', 'DELETE', {
    match: {
      class: knowledgeClass(doc.knowledgeBaseId),
      where: {
        operator: 'And',
        operands: [
          { path: ['documentId'], operator: 'Equal', valueText: doc._id },
          { path: ['ownerId'], operator: 'Equal', valueText: doc.ownerId },
        ],
      },
    },
    output: 'minimal',
  });
  if (response.status === 404) return;
  if (!response.ok) throw new Error(`Could not delete document vectors (${response.status})`);
  const result = (await response.json()) as { results?: { failed?: number } };
  if (result.results?.failed) throw new Error('Some document vectors could not be deleted');
}
export async function deleteDocument(doc: KnowledgeDocument) {
  await deleteChunks(doc);
  await removeFile(doc.storageKey);
  await collection<KnowledgeDocument>('documents').deleteOne({
    _id: doc._id,
    ownerId: doc.ownerId,
    status: 'deleting',
  });
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
  const queryText = `{ Get { ${knowledgeClass(kb._id)}(limit: 8, hybrid: {query: ${JSON.stringify(query)}, vector: ${JSON.stringify(vector)}, alpha: 0.6}, where: {operator: Equal, path: ["ownerId"], valueText: ${JSON.stringify(ownerId)}}) {documentId title content chunkIndex} } }`;
  const r = await weaviate('/v1/graphql', 'POST', { query: queryText }, signal);
  if (!r.ok) throw new Error(`Knowledge search failed (${r.status})`);
  const data = (await r.json()) as { errors?: unknown[]; data?: { Get?: Record<string, KnowledgeChunk[]> } };
  if (data.errors?.length) throw new Error('Knowledge search failed; check the embedding model and index');
  const allowed = new Set(ready.map((d) => d._id));
  return (data.data?.Get?.[knowledgeClass(kb._id)] ?? [])
    .filter((c) => allowed.has(c.documentId))
    .slice(0, 6);
}
