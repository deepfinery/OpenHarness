import { deadline, type VectorStore, type VectorStoreKind } from './types.js';

type Options = { url: string; authorization?: string };
type Flavor = {
  kind: Extract<VectorStoreKind, 'opensearch' | 'elasticsearch'>;
  settings?: Record<string, unknown>;
  vectorMapping: (dimensions: number) => Record<string, unknown>;
  mappedDimensions: (mapping: Record<string, unknown>) => number | undefined;
  query: (q: { ownerId: string; vector: number[]; text: string; limit: number }) => Record<string, unknown>;
};
/** Index names must be lowercase in both engines. */
const indexName = (name: string) => name.toLowerCase();

/**
 * OpenSearch and Elasticsearch share their index, bulk, delete-by-query and health APIs; they differ in how a
 * vector field is mapped and queried. Search is hybrid: k-NN on the embedding plus BM25 on the passage text,
 * always filtered by ownerId.
 */
function searchEngineStore(options: Options, flavor: Flavor): VectorStore {
  const call = async (path: string, method = 'GET', body?: unknown, signal?: AbortSignal, ndjson = false) =>
    fetch(`${options.url.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        'Content-Type': ndjson ? 'application/x-ndjson' : 'application/json',
        ...(options.authorization ? { Authorization: options.authorization } : {}),
      },
      ...(body !== undefined ? { body: ndjson ? String(body) : JSON.stringify(body) } : {}),
      signal: deadline(signal),
    });
  const fail = async (r: Response, what: string) => {
    const detail = ((await r.json().catch(() => ({}))) as { error?: { reason?: string } | string }).error;
    const reason = typeof detail === 'string' ? detail : detail?.reason;
    throw new Error(`${what} (${r.status}${reason ? `: ${reason.slice(0, 200)}` : ''})`);
  };
  const owned = (ownerId: string, documentId?: string) => [
    { term: { ownerId } },
    ...(documentId ? [{ term: { documentId } }] : []),
  ];
  return {
    kind: flavor.kind,
    capabilities: { hybrid: true },
    async health(signal) {
      const r = await call('/_cluster/health', 'GET', undefined, signal);
      if (!r.ok) await fail(r, `${flavor.kind} is not reachable`);
      const health = (await r.json()) as { status?: string };
      if (health.status === 'red') throw new Error(`${flavor.kind} cluster health is red`);
    },
    async ensureCollection(name, dimensions, signal) {
      const index = indexName(name);
      const existing = await call(`/${index}/_mapping`, 'GET', undefined, signal);
      if (existing.ok) {
        const mapping = (
          (await existing.json()) as Record<string, { mappings?: { properties?: Record<string, unknown> } }>
        )[index]?.mappings?.properties?.embedding as Record<string, unknown> | undefined;
        const size = mapping ? flavor.mappedDimensions(mapping) : undefined;
        if (size && size !== dimensions)
          throw new Error(
            `The index expects ${size}-dimensional vectors, but the embedding model returned ${dimensions}`,
          );
        return;
      }
      await existing.body?.cancel();
      if (existing.status !== 404) throw new Error(`Knowledge storage unavailable (${existing.status})`);
      const created = await call(
        `/${index}`,
        'PUT',
        {
          ...(flavor.settings ? { settings: flavor.settings } : {}),
          mappings: {
            properties: {
              embedding: flavor.vectorMapping(dimensions),
              content: { type: 'text' },
              title: { type: 'text' },
              ownerId: { type: 'keyword' },
              documentId: { type: 'keyword' },
              chunkIndex: { type: 'integer' },
            },
          },
        },
        signal,
      );
      if (!created.ok) {
        // Two indexers can race when the first documents arrive together; an existing index means the other won.
        const body = (await created.json().catch(() => ({}))) as { error?: { type?: string } };
        if (body.error?.type !== 'resource_already_exists_exception')
          throw new Error(`Could not initialize knowledge storage (${created.status})`);
      } else await created.body?.cancel();
    },
    async upsert(name, chunks, signal) {
      const index = indexName(name);
      const lines = chunks
        .map(
          ({ id, vector, ...payload }) =>
            `${JSON.stringify({ index: { _index: index, _id: id } })}\n${JSON.stringify({ ...payload, embedding: vector })}`,
        )
        .join('\n');
      const r = await call('/_bulk?refresh=wait_for', 'POST', `${lines}\n`, signal, true);
      if (!r.ok) await fail(r, 'Vector indexing failed');
      const result = (await r.json()) as {
        errors?: boolean;
        items?: { index?: { error?: { reason?: string } } }[];
      };
      if (result.errors) {
        const reason = result.items?.find((i) => i.index?.error)?.index?.error?.reason;
        throw new Error(
          `Vector indexing failed. Confirm the embedding model and its vector dimensions.${reason ? ` (${reason.slice(0, 200)})` : ''}`,
        );
      }
    },
    async deleteDocument(name, ownerId, documentId, signal) {
      const r = await call(
        `/${indexName(name)}/_delete_by_query?refresh=true&conflicts=proceed`,
        'POST',
        { query: { bool: { filter: owned(ownerId, documentId) } } },
        signal,
      );
      if (r.status === 404) return void (await r.body?.cancel());
      if (!r.ok) await fail(r, 'Could not delete document vectors');
      await r.body?.cancel();
    },
    async dropCollection(name, signal) {
      const r = await call(`/${indexName(name)}`, 'DELETE', undefined, signal);
      await r.body?.cancel();
      if (!r.ok && r.status !== 404) throw new Error(`Could not remove the knowledge index (${r.status})`);
    },
    async search(name, query, signal) {
      const r = await call(
        `/${indexName(name)}/_search`,
        'POST',
        { size: query.limit, _source: { excludes: ['embedding'] }, ...flavor.query(query) },
        signal,
      );
      if (r.status === 404) return (await r.body?.cancel(), []);
      if (!r.ok) await fail(r, 'Knowledge search failed');
      const data = (await r.json()) as {
        hits?: { hits?: { _score: number; _source: Record<string, unknown> }[] };
      };
      return (data.hits?.hits ?? []).map((h) => ({
        documentId: String(h._source.documentId ?? ''),
        title: String(h._source.title ?? ''),
        content: String(h._source.content ?? ''),
        chunkIndex: Number(h._source.chunkIndex ?? 0),
        score: h._score,
      }));
    },
  };
}
/** OpenSearch (https://opensearch.org): knn_vector with the Lucene HNSW engine, k-NN and BM25 in one bool query. */
export const openSearchStore = (options: Options) =>
  searchEngineStore(options, {
    kind: 'opensearch',
    settings: { index: { knn: true } },
    vectorMapping: (dimension) => ({
      type: 'knn_vector',
      dimension,
      method: { name: 'hnsw', space_type: 'cosinesimil', engine: 'lucene' },
    }),
    mappedDimensions: (m) => Number(m.dimension) || undefined,
    query: ({ ownerId, vector, text, limit }) => ({
      query: {
        bool: {
          filter: [{ term: { ownerId } }],
          should: [{ knn: { embedding: { vector, k: limit } } }, { match: { content: text } }],
          minimum_should_match: 1,
        },
      },
    }),
  });
/** Elasticsearch (https://www.elastic.co): dense_vector with cosine similarity; the knn and query scores add up. */
export const elasticsearchStore = (options: Options) =>
  searchEngineStore(options, {
    kind: 'elasticsearch',
    vectorMapping: (dims) => ({ type: 'dense_vector', dims, index: true, similarity: 'cosine' }),
    mappedDimensions: (m) => Number(m.dims) || undefined,
    query: ({ ownerId, vector, text, limit }) => ({
      knn: {
        field: 'embedding',
        query_vector: vector,
        k: limit,
        num_candidates: Math.max(50, limit * 5),
        filter: { term: { ownerId } },
      },
      query: { bool: { filter: [{ term: { ownerId } }], should: [{ match: { content: text } }] } },
    }),
  });
