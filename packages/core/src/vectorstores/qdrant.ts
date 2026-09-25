import { deadline, type VectorStore } from './types.js';

/** Qdrant (https://qdrant.tech): one collection per knowledge base, cosine vector search with payload filters. */
export function qdrantStore(options: { url: string; apiKey?: string }): VectorStore {
  const call = async (path: string, method = 'GET', body?: unknown, signal?: AbortSignal) => {
    const r = await fetch(`${options.url.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(options.apiKey ? { 'api-key': options.apiKey } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: deadline(signal),
    });
    return r;
  };
  const fail = async (r: Response, what: string) => {
    const detail = ((await r.json().catch(() => ({}))) as { status?: { error?: string } }).status?.error;
    throw new Error(`${what} (${r.status}${detail ? `: ${detail.slice(0, 200)}` : ''})`);
  };
  const owned = (ownerId: string, documentId?: string) => ({
    must: [
      { key: 'ownerId', match: { value: ownerId } },
      ...(documentId ? [{ key: 'documentId', match: { value: documentId } }] : []),
    ],
  });
  return {
    kind: 'qdrant',
    capabilities: { hybrid: false },
    async health(signal) {
      const r = await call('/readyz', 'GET', undefined, signal);
      await r.body?.cancel();
      if (!r.ok) throw new Error(`Qdrant is not ready (${r.status})`);
    },
    async ensureCollection(name, dimensions, signal) {
      const existing = await call(`/collections/${name}`, 'GET', undefined, signal);
      if (existing.ok) {
        const info = (await existing.json()) as {
          result?: { config?: { params?: { vectors?: { size?: number } } } };
        };
        const size = info.result?.config?.params?.vectors?.size;
        if (size && size !== dimensions)
          throw new Error(
            `The index expects ${size}-dimensional vectors, but the embedding model returned ${dimensions}`,
          );
        return;
      }
      await existing.body?.cancel();
      if (existing.status !== 404) throw new Error(`Knowledge storage unavailable (${existing.status})`);
      const created = await call(
        `/collections/${name}`,
        'PUT',
        { vectors: { size: dimensions, distance: 'Cosine' } },
        signal,
      );
      // Two indexers can race when the first documents arrive together; a conflict means the other one won.
      if (!created.ok && created.status !== 409)
        await fail(created, 'Could not initialize knowledge storage');
      await created.body?.cancel();
      for (const field of ['ownerId', 'documentId']) {
        const index = await call(
          `/collections/${name}/index?wait=true`,
          'PUT',
          { field_name: field, field_schema: 'keyword' },
          signal,
        );
        await index.body?.cancel();
      }
    },
    async upsert(name, chunks, signal) {
      const r = await call(
        `/collections/${name}/points?wait=true`,
        'PUT',
        { points: chunks.map(({ id, vector, ...payload }) => ({ id, vector, payload })) },
        signal,
      );
      if (!r.ok)
        await fail(r, 'Vector indexing failed. Confirm the embedding model and its vector dimensions');
      await r.body?.cancel();
    },
    async deleteDocument(name, ownerId, documentId, signal) {
      const r = await call(
        `/collections/${name}/points/delete?wait=true`,
        'POST',
        { filter: owned(ownerId, documentId) },
        signal,
      );
      if (r.status === 404) return void (await r.body?.cancel());
      if (!r.ok) await fail(r, 'Could not delete document vectors');
      await r.body?.cancel();
    },
    async dropCollection(name, signal) {
      const r = await call(`/collections/${name}`, 'DELETE', undefined, signal);
      await r.body?.cancel();
      if (!r.ok && r.status !== 404) throw new Error(`Could not remove the knowledge index (${r.status})`);
    },
    async search(name, query, signal) {
      const r = await call(
        `/collections/${name}/points/query`,
        'POST',
        { query: query.vector, filter: owned(query.ownerId), limit: query.limit, with_payload: true },
        signal,
      );
      if (r.status === 404) return (await r.body?.cancel(), []);
      if (!r.ok) await fail(r, 'Knowledge search failed');
      const data = (await r.json()) as {
        result?: { points?: { score: number; payload?: Record<string, unknown> }[] };
      };
      return (data.result?.points ?? []).map((p) => ({
        documentId: String(p.payload?.documentId ?? ''),
        title: String(p.payload?.title ?? ''),
        content: String(p.payload?.content ?? ''),
        chunkIndex: Number(p.payload?.chunkIndex ?? 0),
        score: p.score,
      }));
    },
  };
}
