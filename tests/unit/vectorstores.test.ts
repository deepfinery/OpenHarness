import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.SETUP_TOKEN = 'unit-test-setup-token'.repeat(3);
const { qdrantStore } = await import('../../packages/core/src/vectorstores/qdrant.js');
const { weaviateStore } = await import('../../packages/core/src/vectorstores/weaviate.js');
const { configuredVectorStores, vectorStore } = await import('../../packages/core/src/vectorstores/index.js');

type Call = { url: string; method: string; body?: any; raw?: string; headers: Record<string, string> };
const parse = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
/** Replaces fetch with a scripted fake and records every request. */
function fakeFetch(respond: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const call = {
      url: String(input),
      method: init.method ?? 'GET',
      raw: init.body ? String(init.body) : undefined,
      body: init.body ? parse(String(init.body)) : undefined,
      headers: init.headers as Record<string, string>,
    };
    calls.push(call);
    const { status = 200, body = {} } = respond(call);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}
const chunk = {
  id: 'c1',
  vector: [0.1, 0.2],
  ownerId: 'o1',
  documentId: 'd1',
  chunkIndex: 0,
  title: 't',
  content: 'hello',
};

test('the Qdrant driver creates sized collections, filters by owner and maps hits', async () => {
  const fake = fakeFetch((c) => {
    if (c.method === 'GET' && c.url.endsWith('/collections/K1'))
      return { status: 404, body: { status: { error: 'Not found' } } };
    if (c.url.includes('/points/query'))
      return {
        body: {
          result: {
            points: [
              {
                score: 0.9,
                payload: { documentId: 'd1', title: 't', content: 'hello', chunkIndex: 0, ownerId: 'o1' },
              },
            ],
          },
        },
      };
    return { body: { result: true } };
  });
  try {
    const store = qdrantStore({ url: 'http://qdrant:6333/', apiKey: 'secret' });
    await store.ensureCollection('K1', 2);
    const create = fake.calls.find(
      (c) => c.method === 'PUT' && c.url === 'http://qdrant:6333/collections/K1',
    )!;
    assert.deepEqual(create.body, { vectors: { size: 2, distance: 'Cosine' } });
    assert.equal(create.headers['api-key'], 'secret');
    assert.deepEqual(
      fake.calls.filter((c) => c.url.includes('/index')).map((c) => c.body.field_name),
      ['ownerId', 'documentId'],
    );
    await store.upsert('K1', [chunk]);
    const upsert = fake.calls.at(-1)!;
    assert.deepEqual(upsert.body.points[0], {
      id: 'c1',
      vector: [0.1, 0.2],
      payload: { ownerId: 'o1', documentId: 'd1', chunkIndex: 0, title: 't', content: 'hello' },
    });
    await store.deleteDocument('K1', 'o1', 'd1');
    assert.deepEqual(fake.calls.at(-1)!.body.filter.must, [
      { key: 'ownerId', match: { value: 'o1' } },
      { key: 'documentId', match: { value: 'd1' } },
    ]);
    const hits = await store.search('K1', { ownerId: 'o1', vector: [0.1, 0.2], text: 'hello', limit: 8 });
    assert.deepEqual(fake.calls.at(-1)!.body.filter.must, [{ key: 'ownerId', match: { value: 'o1' } }]);
    assert.deepEqual(hits, [{ documentId: 'd1', title: 't', content: 'hello', chunkIndex: 0, score: 0.9 }]);
  } finally {
    fake.restore();
  }
});

test('the Qdrant driver refuses vectors of the wrong size for an existing collection', async () => {
  const fake = fakeFetch(() => ({ body: { result: { config: { params: { vectors: { size: 4 } } } } } }));
  try {
    await assert.rejects(qdrantStore({ url: 'http://q' }).ensureCollection('K', 8), /expects 4-dimensional/);
  } finally {
    fake.restore();
  }
});

test('the Weaviate driver sends hybrid queries scoped to the owner', async () => {
  const fake = fakeFetch((c) =>
    c.url.endsWith('/v1/graphql')
      ? {
          body: {
            data: { Get: { K1: [{ documentId: 'd1', title: 't', content: 'hello', chunkIndex: 0 }] } },
          },
        }
      : { body: [{ result: {} }] },
  );
  try {
    const store = weaviateStore({ url: 'http://weaviate:8080', apiKey: 'k' });
    await store.upsert('K1', [chunk]);
    assert.deepEqual(fake.calls[0].body.objects[0], {
      class: 'K1',
      id: 'c1',
      vector: [0.1, 0.2],
      properties: { ownerId: 'o1', documentId: 'd1', chunkIndex: 0, title: 't', content: 'hello' },
    });
    const hits = await store.search('K1', { ownerId: 'o1', vector: [1], text: 'hi "there"', limit: 5 });
    const query = fake.calls.at(-1)!.body.query as string;
    assert.match(query, /hybrid: \{query: "hi \\"there\\""/);
    assert.match(query, /valueText: "o1"/);
    assert.match(query, /limit: 5/);
    assert.equal(hits[0].content, 'hello');
    assert.equal(fake.calls[0].headers.Authorization, 'Bearer k');
  } finally {
    fake.restore();
  }
});

test('only configured stores can be used', () => {
  assert.deepEqual(configuredVectorStores(), ['weaviate']);
  assert.throws(() => vectorStore('qdrant'), /not configured/);
  assert.equal(vectorStore('weaviate').kind, 'weaviate');
});

const { openSearchStore, elasticsearchStore } =
  await import('../../packages/core/src/vectorstores/searchEngine.js');
test('the OpenSearch driver maps knn vectors, bulk-indexes chunks and runs hybrid owner-scoped queries', async () => {
  const fake = fakeFetch((c) => {
    if (c.method === 'GET' && c.url.endsWith('/_mapping')) return { status: 404, body: {} };
    if (c.url.includes('/_bulk')) return { body: { errors: false, items: [] } };
    if (c.url.endsWith('/_search'))
      return {
        body: {
          hits: {
            hits: [{ _score: 2, _source: { documentId: 'd1', title: 't', content: 'hello', chunkIndex: 0 } }],
          },
        },
      };
    return { body: { acknowledged: true } };
  });
  try {
    const store = openSearchStore({ url: 'http://os:9200', authorization: 'Basic abc' });
    await store.ensureCollection('Knowledge_ABC', 3);
    const create = fake.calls.find((c) => c.method === 'PUT')!;
    assert.equal(create.url, 'http://os:9200/knowledge_abc', 'index names are lowercased');
    assert.deepEqual(create.body.settings, { index: { knn: true } });
    assert.equal(create.body.mappings.properties.embedding.type, 'knn_vector');
    assert.equal(create.body.mappings.properties.embedding.dimension, 3);
    assert.equal(create.body.mappings.properties.ownerId.type, 'keyword');
    await store.upsert('Knowledge_ABC', [chunk]);
    const bulk = fake.calls.find((c) => c.url.includes('/_bulk'))!;
    assert.equal(bulk.headers['Content-Type'], 'application/x-ndjson');
    const [action, source] = bulk
      .raw!.trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.deepEqual(action, { index: { _index: 'knowledge_abc', _id: 'c1' } });
    assert.deepEqual(source.embedding, [0.1, 0.2]);
    assert.equal(source.ownerId, 'o1');
    const hits = await store.search('Knowledge_ABC', { ownerId: 'o1', vector: [1], text: 'hi', limit: 4 });
    const search = fake.calls.at(-1)!.body;
    assert.deepEqual(search.query.bool.filter, [{ term: { ownerId: 'o1' } }]);
    assert.deepEqual(search.query.bool.should[0], { knn: { embedding: { vector: [1], k: 4 } } });
    assert.equal(hits[0].score, 2);
    assert.equal(fake.calls[0].headers.Authorization, 'Basic abc');
  } finally {
    fake.restore();
  }
});
test('the Elasticsearch driver uses dense_vector with a filtered knn section beside the keyword query', async () => {
  const fake = fakeFetch((c) =>
    c.method === 'GET' && c.url.endsWith('/_mapping')
      ? {
          body: {
            knowledge_x: { mappings: { properties: { embedding: { type: 'dense_vector', dims: 8 } } } },
          },
        }
      : { body: { hits: { hits: [] } } },
  );
  try {
    const store = elasticsearchStore({ url: 'http://es:9200', authorization: 'ApiKey k' });
    await assert.rejects(store.ensureCollection('Knowledge_X', 4), /expects 8-dimensional/);
    await store.search('Knowledge_X', { ownerId: 'o1', vector: [1, 2], text: 'hi', limit: 5 });
    const body = fake.calls.at(-1)!.body;
    assert.equal(body.knn.field, 'embedding');
    assert.deepEqual(body.knn.filter, { term: { ownerId: 'o1' } });
    assert.equal(body.knn.num_candidates, 50);
    assert.deepEqual(body.query.bool.should, [{ match: { content: 'hi' } }]);
    assert.equal(fake.calls[0].headers.Authorization, 'ApiKey k');
  } finally {
    fake.restore();
  }
});
