/**
 * Optional semantic recall (DESIGN §14.3 claim, now implemented).
 *
 * Design constraints that shape this module:
 *   - **Off by default.** Embeddings are the only feature that can spend money
 *     outside the bounded distillation path, so `semantic.enabled` is false
 *     until a human turns it on.
 *   - **Never block the step.** The provider call is bounded by
 *     `semantic.timeoutMs`, and only happens when lexical recall came back thin
 *     (`minLexicalHits`). Any failure degrades to lexical silently — a broken
 *     endpoint must not cost a turn.
 *   - **Pay once per lesson.** Vectors are cached in SQLite keyed by the content
 *     hash, so an unchanged record is never re-embedded and a changed one is.
 *   - **Blend, do not replace.** The result feeds the existing `relevance` input
 *     of the ranker, so confidence/freshness/layer weights still apply.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryConfig } from '../config.js';
import type { MemoryRecord } from '../store/types.js';
import type { StoreRegistry, ScopeStore } from '../store/store.js';
export interface EmbeddingProvider {
    id: string;
    /** Whether the provider is usable at all (configuration + credentials). */
    available(): boolean;
    /** Embed a batch; resolves to `undefined` on any failure (degrade to lexical). */
    embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][] | undefined>;
    /** Last error, for `memory_stats`. */
    lastError(): string | undefined;
}
export interface RemoteProviderOptions {
    baseUrl: string;
    model: string;
    apiKey?: string | undefined;
    timeoutMs: number;
    /**
     * Wall-clock budget for one `embed()` run, across all batches. Without it a
     * multi-batch backfill could hold the step for batches × timeoutMs.
     */
    budgetMs?: number;
    /** Batches larger than this are split. */
    batchSize?: number;
    /** Injected for tests. */
    fetchImpl?: typeof fetch;
}
/** Minimal OpenAI-compatible `/embeddings` client. */
export declare function createRemoteProvider(options: RemoteProviderOptions): EmbeddingProvider;
/** Build the configured provider, or `undefined` when semantic recall is off. */
export declare function createEmbeddingProvider(config: MemoryConfig): EmbeddingProvider | undefined;
export declare function toBlob(vector: readonly number[]): Uint8Array;
export declare function fromBlob(blob: Uint8Array): Float32Array;
/** Content hash of the parts that get embedded. */
export declare function recordHash(record: MemoryRecord): string;
export interface StoredVector {
    recordId: string;
    vector: Float32Array;
}
/**
 * Load vectors for `model`, skipping any whose stored dimension does not match
 * the query vector's.
 *
 * The dimension is stored but was never read: if the endpoint behind the same
 * model name started returning different vectors, `cosine` would quietly compare
 * prefixes and rank by garbage instead of failing. Mismatched rows are also
 * re-embedded (see `pendingRecords`).
 */
export declare function loadVectors(db: DatabaseSync, model: string, dimension?: number): Map<string, Float32Array>;
export declare function saveVectors(db: DatabaseSync, model: string, entries: readonly {
    recordId: string;
    vector: readonly number[];
    hash: string;
}[], at?: string): void;
/** Records eligible for recall in one scope. */
export declare function searchableRecords(db: DatabaseSync): number;
/** Records whose vector is missing or stale (content changed since indexing). */
export declare function pendingRecords(db: DatabaseSync, model: string, limit: number): MemoryRecord[];
export interface IndexStats {
    indexed: number;
    pending: number;
    model: string;
}
export declare function indexStats(db: DatabaseSync, model: string): IndexStats;
/** Drop vectors of records that no longer exist. */
export declare function pruneVectors(db: DatabaseSync, model: string): number;
/** Text fed to the embedding model for one record. */
export declare function embeddingText(record: MemoryRecord): string;
export interface EnsureOptions {
    signal?: AbortSignal;
    /** Cap for this pass; `-1` means "everything pending". */
    limit?: number;
}
/**
 * Bring the semantic index up to date, incrementally. Returns how many records
 * were embedded; failures are reported through the provider's `lastError`.
 */
export declare function ensureEmbeddings(db: DatabaseSync, provider: EmbeddingProvider, model: string, options?: EnsureOptions): Promise<number>;
export declare function cosine(a: Float32Array, b: Float32Array): number;
/** Cosine similarity in 0..1 (negative similarity is clamped to 0). */
export declare function similarityScores(vectors: Map<string, Float32Array>, query: Float32Array): Map<string, number>;
/** Small LRU so a repeated query never costs a second call. */
export declare class QueryVectorCache {
    private readonly entries;
    get(key: string): Float32Array | undefined;
    set(key: string, vector: Float32Array): void;
    get size(): number;
}
export interface SemanticDeps {
    config: MemoryConfig;
    registry: StoreRegistry;
    provider?: EmbeddingProvider | undefined;
    cache?: QueryVectorCache;
}
export interface SemanticOutcome {
    /** Similarity per record id, 0..1. */
    scores: Map<string, number>;
    /** Records the semantic pass surfaced that lexical search did not return. */
    extraIds: string[];
    embedded: number;
    used: boolean;
    reason?: string;
}
/**
 * Run the semantic half of a recall pass. Returns empty scores when disabled,
 * when lexical recall was already rich enough, or when the provider failed.
 */
export declare function semanticRecall(deps: SemanticDeps, store: ScopeStore, query: string, lexicalHitCount: number, options?: {
    signal?: AbortSignal;
}): Promise<SemanticOutcome>;
/**
 * Blend lexical relevance with semantic similarity.
 *
 * `weight` 0 keeps pure lexical ranking; 1 would ignore it. Records found by
 * only one side still receive that side's contribution, which is what lets a
 * semantically related lesson surface without keyword overlap.
 */
export declare function blendRelevance(lexical: Map<string, number>, semantic: Map<string, number>, weight: number, minSimilarity: number): {
    relevance: Map<string, number>;
    semanticOnly: string[];
};
//# sourceMappingURL=semantic.d.ts.map