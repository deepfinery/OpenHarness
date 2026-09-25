import { config } from '../config.js';
import { openAIVectorStore } from './openai.js';
import { qdrantStore } from './qdrant.js';
import { elasticsearchStore, openSearchStore } from './searchEngine.js';
import { vectorStoreKinds, type VectorStore, type VectorStoreKind } from './types.js';
import { weaviateStore } from './weaviate.js';

export * from './types.js';

/** Stores this deployment can reach. Weaviate is always part of the default stack; others need their URL. */
const configured: Record<VectorStoreKind, () => boolean> = {
  weaviate: () => true,
  qdrant: () => Boolean(config.QDRANT_URL),
  opensearch: () => Boolean(config.OPENSEARCH_URL),
  elasticsearch: () => Boolean(config.ELASTICSEARCH_URL),
  openai: () => Boolean(config.OPENAI_VECTOR_STORES_URL),
};
export function configuredVectorStores(): VectorStoreKind[] {
  return vectorStoreKinds.filter((kind) => configured[kind]());
}
function create(kind: VectorStoreKind): VectorStore {
  switch (kind) {
    case 'qdrant':
      return qdrantStore({ url: config.QDRANT_URL, apiKey: config.QDRANT_API_KEY });
    case 'opensearch':
      return openSearchStore({
        url: config.OPENSEARCH_URL,
        ...(config.OPENSEARCH_USERNAME
          ? {
              authorization: `Basic ${Buffer.from(`${config.OPENSEARCH_USERNAME}:${config.OPENSEARCH_PASSWORD}`).toString('base64')}`,
            }
          : {}),
      });
    case 'elasticsearch':
      return elasticsearchStore({
        url: config.ELASTICSEARCH_URL,
        ...(config.ELASTICSEARCH_API_KEY ? { authorization: `ApiKey ${config.ELASTICSEARCH_API_KEY}` } : {}),
      });
    case 'openai':
      return openAIVectorStore({
        url: config.OPENAI_VECTOR_STORES_URL,
        apiKey: config.OPENAI_VECTOR_STORES_API_KEY,
      });
    default:
      return weaviateStore({ url: config.WEAVIATE_URL, apiKey: config.WEAVIATE_API_KEY });
  }
}
const cache = new Map<VectorStoreKind, VectorStore>();
export function vectorStore(kind: VectorStoreKind = config.VECTOR_STORE): VectorStore {
  if (!configuredVectorStores().includes(kind))
    throw new Error(`The ${kind} vector store is not configured on this deployment`);
  let store = cache.get(kind);
  if (!store) {
    store = create(kind);
    cache.set(kind, store);
  }
  return store;
}
/** Whether a store embeds text itself, so its knowledge bases need no embedding model. */
export const storeEmbeds = (kind: VectorStoreKind) => kind === 'openai';
/** The store a knowledge base uses; bases created before stores were pluggable are on Weaviate. */
export const storeFor = (kb: { vectorStore?: VectorStoreKind }) => vectorStore(kb.vectorStore ?? 'weaviate');
