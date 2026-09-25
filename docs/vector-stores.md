# Vector stores

Knowledge bases keep their passages in a pluggable vector store. Core OpenHarness code does the chunking,
embedding and tenant scoping. A driver only saves vectors with their payload and searches them, and every query is
filtered by workspace inside the store as well.

| Store                           | Search                                                     | Setup                                                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Weaviate                        | Hybrid: BM25 plus vectors.                                 | Part of the default Compose stack.                                                                                                                                 |
| Qdrant                          | Cosine vector search with payload filters.                 | `docker compose --profile qdrant up -d` and `QDRANT_URL=http://qdrant:6333`, or a managed Qdrant with `QDRANT_API_KEY`.                                            |
| OpenSearch                      | Hybrid: `knn_vector` (Lucene HNSW) plus BM25 in one query. | `--profile opensearch` and `OPENSEARCH_URL=http://opensearch:9200`, or Amazon OpenSearch Service or any cluster, with `OPENSEARCH_USERNAME`/`OPENSEARCH_PASSWORD`. |
| Elasticsearch                   | Hybrid: `dense_vector` k-NN plus BM25; the scores add up.  | `--profile elasticsearch` and `ELASTICSEARCH_URL=http://elasticsearch:9200`, or Elastic Cloud or any cluster, with `ELASTICSEARCH_API_KEY`.                        |
| OpenAI-compatible Vector Stores | The server chunks, embeds and ranks.                       | `OPENAI_VECTOR_STORES_URL` and `OPENAI_VECTOR_STORES_API_KEY`: OpenAI, Llama Stack, or a managed service with the same API.                                        |

The **OpenAI-compatible Vector Stores API** (`/v1/vector_stores`, `/v1/files`) is the open interface for anything
the other drivers don't cover. Through [Llama Stack](https://llamastack.github.io/docs/api-openai), for example, it
reaches FAISS, Chroma, Milvus, pgvector, Qdrant and Weaviate. These servers embed text themselves:

- the driver uploads each document whole and waits until the server has processed it;
- search sends only the query text;
- knowledge bases on this store need no embedding model;
- the ids the server assigns are kept in MongoDB, in `vector_store_links` and `vector_store_files`.

`VECTOR_STORE` picks the store for new knowledge bases. The studio also offers a choice whenever more than one
store is configured. A base keeps its store for life. Bases created before stores became pluggable are on Weaviate.
A base that holds documents cannot move to another store, so remove its documents first. Deleting a base drops
its index.

The bundled OpenSearch and Elasticsearch services are single nodes for evaluation. They run without security, on
the Compose network only. For production, point the URL at a secured or managed cluster. The bundled Qdrant runs
with `QDRANT__TELEMETRY_DISABLED=true` and Weaviate with `DISABLE_TELEMETRY=true`.

## Adding a driver

Implement `VectorStore` in `packages/core/src/vectorstores/types.ts`: `health`, `ensureCollection` (it receives the
embedding dimensions), `upsert`, `deleteDocument`, `dropCollection` and `search`. A store that embeds text itself
sets `capabilities.embeds` and implements `upsertDocument` instead of `upsert`.

Register the driver in `vectorstores/index.ts`, add its kind to `vectorStoreKinds`, and add a unit test like the
ones in `tests/unit/vectorstores.test.ts`. Then add the store to the test Compose overlay, so
`tests/integration/vectorstores.test.ts` runs the full knowledge flow on it.
