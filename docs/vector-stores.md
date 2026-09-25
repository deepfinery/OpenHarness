# Vector stores

Knowledge bases keep their passages in a pluggable vector store. Core OpenHarness code does the chunking,
embedding and tenant scoping. A store driver only saves vectors with their payload and searches them, and every
query is filtered by workspace inside the store as well.

| Store    | Search                                    | Setup                                                                                                                                      |
| -------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Weaviate | Hybrid: BM25 keywords plus vectors        | Part of the default Compose stack.                                                                                                         |
| Qdrant   | Cosine vector search with payload filters | Run `docker compose --profile qdrant up -d` and set `QDRANT_URL=http://qdrant:6333`. For managed Qdrant, set its URL and `QDRANT_API_KEY`. |

`VECTOR_STORE` picks the store for new knowledge bases. The studio also offers a choice whenever more than one
store is configured. A base keeps its store for life. Bases created before stores became pluggable are on Weaviate.
A base that holds documents cannot move to another store, so remove its documents first. Deleting a base drops
its index.

The bundled Qdrant container runs with `QDRANT__TELEMETRY_DISABLED=true`, and Weaviate with
`DISABLE_TELEMETRY=true`, so neither sends usage data.

## Adding a driver

Implement `VectorStore` in `packages/core/src/vectorstores/types.ts`: `health`, `ensureCollection` (it receives the
embedding dimensions), `upsert`, `deleteDocument`, `dropCollection` and `search`. Register the driver in
`vectorstores/index.ts`, add its kind to `vectorStoreKinds`, and add a test like `tests/unit/vectorstores.test.ts`.
Then add the store to the test Compose overlay, so `tests/integration/vectorstores.test.ts` runs the full knowledge
flow on it.

Planned drivers are pgvector, OpenSearch or Elasticsearch, and a client for the OpenAI-compatible Vector Stores
API, which covers Llama Stack and managed services. See issue #18.
