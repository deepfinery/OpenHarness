import { config } from '../config.js';
import { qdrantStore } from './qdrant.js';
import { vectorStoreKinds, type VectorStore, type VectorStoreKind } from './types.js';
import { weaviateStore } from './weaviate.js';

export * from './types.js';

/** Stores this deployment can reach. Weaviate is always part of the default stack; others need their URL. */
export function configuredVectorStores(): VectorStoreKind[] {
  return vectorStoreKinds.filter(
    (kind) => kind === 'weaviate' || (kind === 'qdrant' && Boolean(config.QDRANT_URL)),
  );
}
const cache = new Map<VectorStoreKind, VectorStore>();
export function vectorStore(kind: VectorStoreKind = config.VECTOR_STORE): VectorStore {
  if (!configuredVectorStores().includes(kind))
    throw new Error(`The ${kind} vector store is not configured on this deployment`);
  let store = cache.get(kind);
  if (!store) {
    store =
      kind === 'qdrant'
        ? qdrantStore({ url: config.QDRANT_URL, apiKey: config.QDRANT_API_KEY })
        : weaviateStore({ url: config.WEAVIATE_URL, apiKey: config.WEAVIATE_API_KEY });
    cache.set(kind, store);
  }
  return store;
}
/** The store a knowledge base uses; bases created before stores were pluggable are on Weaviate. */
export const storeFor = (kb: { vectorStore?: VectorStoreKind }) => vectorStore(kb.vectorStore ?? 'weaviate');
