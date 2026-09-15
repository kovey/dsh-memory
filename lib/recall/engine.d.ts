/**
 * Recall engine (DESIGN §6): turn a query into the highest-value memory pack
 * that fits a token budget.
 *
 * Pure with respect to the session — it reads stores and returns a selection;
 * the caller decides how (and whether) to inject it.
 */
import type { MemoryConfig } from '../config.js';
import type { StoreRegistry } from '../store/store.js';
import type { Layer, MemoryRecord, MemoryScope } from '../store/types.js';
import type { AgentLike } from '../scope/resolver.js';
import { ScopeResolver } from '../scope/resolver.js';
import type { EmbeddingProvider, QueryVectorCache } from './semantic.js';
export interface RecallDeps {
    config: MemoryConfig;
    registry: StoreRegistry;
    resolver: ScopeResolver;
    /** Optional semantic recall (DESIGN §14.3). Absent = lexical only. */
    semantic?: {
        provider?: EmbeddingProvider | undefined;
        cache?: QueryVectorCache;
    } | undefined;
}
export interface RecallRequest {
    agent?: AgentLike | undefined;
    terms: readonly string[];
    /** Original query text, used for the embedding request. */
    text?: string | undefined;
    /** Cancellation for the bounded embedding call. */
    signal?: AbortSignal | undefined;
    /** Records already surfaced in this session (idempotence, DESIGN §6). */
    exclude?: (recordId: string) => boolean;
    budgetTokens?: number;
    maxItems?: number;
    minScore?: number;
    layers?: readonly Layer[];
    /** Also search the global root when the session scope is a project. */
    includeGlobal?: boolean;
}
export interface RecallHit {
    record: MemoryRecord;
    scope: MemoryScope;
    score: number;
}
export interface RecallOutcome {
    hits: RecallHit[];
    /** Matching records that did not fit the budget / score floor. */
    dropped: number;
    tokensUsed: number;
    /** Records that matched the query before filtering. */
    considered: number;
    scopes: MemoryScope[];
    /** Semantic pass bookkeeping (absent when semantic recall is off). */
    semantic?: {
        used: boolean;
        embedded: number;
        semanticOnly: number;
        reason?: string;
    };
}
/** Retrieve and rank memory for one query (lexical, optionally blended). */
export declare function recall(deps: RecallDeps, request: RecallRequest): Promise<RecallOutcome>;
/** Render one hit as a compact, model-readable line pair. */
export declare function renderHit(hit: RecallHit, maxBodyChars?: number): string;
/** Render the whole pack injected into a step. */
export declare function renderRecallPack(hits: readonly RecallHit[], dropped?: number): string;
/** Estimated cost of one rendered pack (used by tests and budgets). */
export declare function packTokens(hits: readonly RecallHit[], dropped?: number): number;
//# sourceMappingURL=engine.d.ts.map