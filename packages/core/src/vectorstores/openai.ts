import { collection } from '../db.js';
import { deadline, type VectorStore } from './types.js';

/**
 * A client for the OpenAI-compatible Vector Stores API (/v1/vector_stores, /v1/files). It works with OpenAI, with
 * Llama Stack (which fronts FAISS, Chroma, Milvus, pgvector, Qdrant, Weaviate and others) and with managed services
 * that implement the same API. These servers chunk and embed text themselves, so this store receives whole
 * documents and is searched by text. The ids the server assigns are kept in MongoDB.
 */
type Link = { _id: string; remoteId: string; createdAt: Date };
type FileLink = { _id: string; collection: string; documentId: string; fileId: string; createdAt: Date };
const links = () => collection<Link>('vector_store_links');
const fileLinks = () => collection<FileLink>('vector_store_files');

export function openAIVectorStore(options: { url: string; apiKey?: string }): VectorStore {
  const base = options.url.replace(/\/$/, '');
  const auth: Record<string, string> = options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {};
  const call = (path: string, method = 'GET', body?: unknown, signal?: AbortSignal) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...auth,
        ...(body instanceof FormData || body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
      signal: deadline(signal, 60000),
    });
  const fail = async (r: Response, what: string): Promise<never> => {
    const detail = ((await r.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message;
    throw new Error(`${what} (${r.status}${detail ? `: ${detail.slice(0, 200)}` : ''})`);
  };
  const remote = async (name: string) => (await links().findOne({ _id: name }))?.remoteId;
  return {
    kind: 'openai',
    capabilities: { hybrid: false, embeds: true },
    async health(signal) {
      const r = await call('/vector_stores?limit=1', 'GET', undefined, signal);
      if (!r.ok) await fail(r, 'The vector store API is not reachable');
      await r.body?.cancel();
    },
    async ensureCollection(name, _dimensions, signal) {
      if (await remote(name)) return;
      const r = await call(
        '/vector_stores',
        'POST',
        { name, metadata: { openharness_collection: name } },
        signal,
      );
      if (!r.ok) await fail(r, 'Could not create the vector store');
      const created = (await r.json()) as { id: string };
      try {
        await links().insertOne({ _id: name, remoteId: created.id, createdAt: new Date() });
      } catch {
        // Another indexer linked the collection first; the extra store is removed again.
        await call(`/vector_stores/${created.id}`, 'DELETE', undefined, signal)
          .then((x) => x.body?.cancel())
          .catch(() => {});
      }
    },
    async upsert() {
      throw new Error('This vector store embeds documents itself; index whole documents instead');
    },
    async upsertDocument(name, document, signal) {
      const storeId = await remote(name);
      if (!storeId) throw new Error('The vector store for this knowledge base is missing');
      const form = new FormData();
      form.append('purpose', 'assistants');
      form.append(
        'file',
        new Blob([document.content], { type: 'text/plain' }),
        document.title.replace(/\.[^.]+$/, '') + '.txt',
      );
      const uploaded = await call('/files', 'POST', form, signal);
      if (!uploaded.ok) await fail(uploaded, 'Could not upload the document');
      const file = (await uploaded.json()) as { id: string };
      const attached = await call(
        `/vector_stores/${storeId}/files`,
        'POST',
        {
          file_id: file.id,
          attributes: { ownerId: document.ownerId, documentId: document.documentId, title: document.title },
        },
        signal,
      );
      if (!attached.ok) await fail(attached, 'Could not add the document to the vector store');
      await attached.body?.cancel();
      await fileLinks().updateOne(
        { _id: `${name}:${document.documentId}` },
        {
          $set: { collection: name, documentId: document.documentId, fileId: file.id, createdAt: new Date() },
        },
        { upsert: true },
      );
      // The server indexes asynchronously; the document is ready once its file is processed.
      for (let attempt = 0; attempt < 120; attempt++) {
        const status = await call(`/vector_stores/${storeId}/files/${file.id}`, 'GET', undefined, signal);
        if (!status.ok) await fail(status, 'Could not read the indexing status');
        const state = (await status.json()) as { status?: string; last_error?: { message?: string } | null };
        if (state.status === 'completed') return;
        if (state.status === 'failed' || state.status === 'cancelled')
          throw new Error(
            `The vector store could not index this document${state.last_error?.message ? `: ${state.last_error.message}` : ''}`,
          );
        await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 250 * (attempt + 1))));
      }
      throw new Error('The vector store is still indexing this document; try again later');
    },
    async deleteDocument(name, _ownerId, documentId, signal) {
      const link = await fileLinks().findOne({ _id: `${name}:${documentId}` });
      const storeId = await remote(name);
      if (!link || !storeId) return;
      for (const path of [`/vector_stores/${storeId}/files/${link.fileId}`, `/files/${link.fileId}`]) {
        const r = await call(path, 'DELETE', undefined, signal);
        if (!r.ok && r.status !== 404) await fail(r, 'Could not delete the document from the vector store');
        await r.body?.cancel();
      }
      await fileLinks().deleteOne({ _id: link._id });
    },
    async dropCollection(name, signal) {
      const storeId = await remote(name);
      if (storeId) {
        const r = await call(`/vector_stores/${storeId}`, 'DELETE', undefined, signal);
        await r.body?.cancel();
        if (!r.ok && r.status !== 404) throw new Error(`Could not remove the vector store (${r.status})`);
      }
      await links().deleteOne({ _id: name });
      await fileLinks().deleteMany({ collection: name });
    },
    async search(name, query, signal) {
      const storeId = await remote(name);
      if (!storeId) return [];
      const r = await call(
        `/vector_stores/${storeId}/search`,
        'POST',
        {
          query: query.text,
          max_num_results: Math.min(50, query.limit),
          filters: { type: 'eq', key: 'ownerId', value: query.ownerId },
        },
        signal,
      );
      if (!r.ok) await fail(r, 'Knowledge search failed');
      const data = (await r.json()) as {
        data?: {
          filename?: string;
          score?: number;
          attributes?: Record<string, unknown>;
          content?: { type: string; text?: string }[];
        }[];
      };
      return (data.data ?? [])
        .filter((hit) => hit.attributes?.ownerId === query.ownerId)
        .map((hit, index) => ({
          documentId: String(hit.attributes?.documentId ?? ''),
          title: String(hit.attributes?.title ?? hit.filename ?? ''),
          content: (hit.content ?? []).map((c) => c.text ?? '').join('\n'),
          chunkIndex: index,
          score: hit.score,
        }));
    },
  };
}
