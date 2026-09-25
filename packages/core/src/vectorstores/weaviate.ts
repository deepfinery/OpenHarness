import { deadline, type VectorStore } from './types.js';

/** Weaviate (https://weaviate.io): one class per knowledge base, hybrid BM25 + vector search. */
export function weaviateStore(options: { url: string; apiKey?: string }): VectorStore {
  const call = (path: string, method = 'GET', body?: unknown, signal?: AbortSignal) =>
    fetch(`${options.url.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: deadline(signal),
    });
  return {
    kind: 'weaviate',
    capabilities: { hybrid: true },
    async health(signal) {
      const r = await call('/v1/.well-known/ready', 'GET', undefined, signal);
      await r.body?.cancel();
      if (!r.ok) throw new Error(`Weaviate is not ready (${r.status})`);
    },
    async ensureCollection(name, _dimensions, signal) {
      const existing = await call(`/v1/schema/${name}`, 'GET', undefined, signal);
      await existing.body?.cancel();
      if (existing.ok) return;
      if (existing.status !== 404) throw new Error(`Knowledge storage unavailable (${existing.status})`);
      const r = await call(
        '/v1/schema',
        'POST',
        {
          class: name,
          vectorizer: 'none',
          properties: [
            { name: 'content', dataType: ['text'] },
            { name: 'title', dataType: ['text'] },
            { name: 'ownerId', dataType: ['text'], tokenization: 'field' },
            { name: 'documentId', dataType: ['text'], tokenization: 'field' },
            { name: 'chunkIndex', dataType: ['int'] },
          ],
        },
        signal,
      );
      await r.body?.cancel();
      if (!r.ok) {
        // Two indexers can race when the first documents arrive together.
        const check = await call(`/v1/schema/${name}`, 'GET', undefined, signal);
        await check.body?.cancel();
        if (!check.ok) throw new Error(`Could not initialize knowledge storage (${r.status})`);
      }
    },
    async upsert(name, chunks, signal) {
      const r = await call(
        '/v1/batch/objects',
        'POST',
        {
          objects: chunks.map(({ id, vector, ...properties }) => ({ class: name, id, properties, vector })),
        },
        signal,
      );
      if (!r.ok) throw new Error(`Knowledge indexing failed (${r.status})`);
      const result = (await r.json()) as Array<{ result?: { errors?: unknown } }>;
      if (!Array.isArray(result) || result.some((item) => item.result?.errors))
        throw new Error('Vector indexing failed. Confirm the embedding model and its vector dimensions.');
    },
    async deleteDocument(name, ownerId, documentId, signal) {
      const r = await call(
        '/v1/batch/objects',
        'DELETE',
        {
          match: {
            class: name,
            where: {
              operator: 'And',
              operands: [
                { path: ['documentId'], operator: 'Equal', valueText: documentId },
                { path: ['ownerId'], operator: 'Equal', valueText: ownerId },
              ],
            },
          },
          output: 'minimal',
        },
        signal,
      );
      if (r.status === 404) return void (await r.body?.cancel());
      if (!r.ok) throw new Error(`Could not delete document vectors (${r.status})`);
      const result = (await r.json()) as { results?: { failed?: number } };
      if (result.results?.failed) throw new Error('Some document vectors could not be deleted');
    },
    async dropCollection(name, signal) {
      const r = await call(`/v1/schema/${name}`, 'DELETE', undefined, signal);
      await r.body?.cancel();
      if (!r.ok && r.status !== 404) throw new Error(`Could not remove the knowledge index (${r.status})`);
    },
    async search(name, query, signal) {
      const text = `{ Get { ${name}(limit: ${query.limit}, hybrid: {query: ${JSON.stringify(query.text)}, vector: ${JSON.stringify(query.vector)}, alpha: 0.6}, where: {operator: Equal, path: ["ownerId"], valueText: ${JSON.stringify(query.ownerId)}}) {documentId title content chunkIndex} } }`;
      const r = await call('/v1/graphql', 'POST', { query: text }, signal);
      if (!r.ok) throw new Error(`Knowledge search failed (${r.status})`);
      const data = (await r.json()) as {
        errors?: unknown[];
        data?: {
          Get?: Record<string, { documentId: string; title: string; content: string; chunkIndex: number }[]>;
        };
      };
      if (data.errors?.length)
        throw new Error('Knowledge search failed; check the embedding model and index');
      return data.data?.Get?.[name] ?? [];
    },
  };
}
