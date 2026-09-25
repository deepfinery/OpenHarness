/**
 * Vector storage behind knowledge bases. Chunking, embedding and tenant scoping stay in core; a driver only stores
 * vectors with their payload and searches them. Every query is filtered by `ownerId` inside the store as well.
 */
export const vectorStoreKinds = ['weaviate', 'qdrant', 'opensearch', 'elasticsearch', 'openai'] as const;
export type VectorStoreKind = (typeof vectorStoreKinds)[number];
export type VectorPayload = {
  ownerId: string;
  documentId: string;
  chunkIndex: number;
  title: string;
  content: string;
};
export type VectorChunk = VectorPayload & { id: string; vector: number[] };
export type VectorQuery = { ownerId: string; vector: number[]; text: string; limit: number };
export type VectorHit = Omit<VectorPayload, 'ownerId'> & { score?: number };
export interface VectorStore {
  readonly kind: VectorStoreKind;
  /**
   * Hybrid stores also rank by keyword match; vector-only stores ignore `text`. Stores that `embed` chunk and embed
   * text themselves: they receive whole documents through `upsertDocument` and are searched by text alone.
   */
  readonly capabilities: { hybrid: boolean; embeds?: boolean };
  health(signal?: AbortSignal): Promise<void>;
  /** Creates the collection if needed. Stores that fix dimensions at creation use `dimensions`. */
  ensureCollection(name: string, dimensions: number, signal?: AbortSignal): Promise<void>;
  upsert(name: string, chunks: VectorChunk[], signal?: AbortSignal): Promise<void>;
  deleteDocument(name: string, ownerId: string, documentId: string, signal?: AbortSignal): Promise<void>;
  dropCollection(name: string, signal?: AbortSignal): Promise<void>;
  search(name: string, query: VectorQuery, signal?: AbortSignal): Promise<VectorHit[]>;
  /** For stores that embed: index one whole document. */
  upsertDocument?(
    name: string,
    document: { ownerId: string; documentId: string; title: string; content: string },
    signal?: AbortSignal,
  ): Promise<void>;
}
export const deadline = (signal?: AbortSignal, ms = 30000) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
