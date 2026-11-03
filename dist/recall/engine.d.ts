/**
 * Recall engine (DESIGN §6): turn a query into the highest-value memory pack
 * that fits a token budget.
 *
 * Pure with respect to the session — it reads stores and returns a selection;
 * the caller decides how (and whether) to inject it.
 */
import type { MemoryConfig } from '../config.js';
import type { FitResult, ScoredRecord } from './rank.js';
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
/**
 * Fit the pack with a hard two-tier quota (DESIGN §6.1).
 *
 * The default path is one score-ordered list, which lets a fresh project record
 * outrank an older global lesson by ~5.9× (freshness 0.2 over 120 days, times
 * the 0.85 global layer weight). When a quota is configured the pack is filled
 * in three passes instead:
 *
 *   1. `globalMinTokens` — a reserved slice for lessons from the global root,
 *      taken in score order but bounded by the slice (never by the whole pack);
 *   2. `projectMaxTokens` — a ceiling on what project records may take;
 *   3. the rest of the budget, all candidates competing by score.
 *
 * Passes are greedy and `minScore` applies to every one of them: a quota is a
 * ceiling/floor on *space*, not a licence to inject noise.
 */
export declare function fitBudgetQuoted(ranked: readonly ScoredRecord[], render: (item: ScoredRecord) => string, options: {
    budgetTokens: number;
    maxItems: number;
    minScore: number;
    skip?: (recordId: string) => boolean;
}, isGlobal: (item: ScoredRecord) => boolean, quota: {
    globalMinTokens: number;
    projectMaxTokens: number;
}): FitResult;
/** Render one hit as a compact, model-readable line pair. */
export declare function renderHit(hit: RecallHit, maxBodyChars?: number): string;
/** Render the whole pack injected into a step. */
export declare function renderRecallPack(hits: readonly RecallHit[], dropped?: number, maxBodyChars?: number): string;
/** Estimated cost of one rendered pack (used by tests and budgets). */
export declare function packTokens(hits: readonly RecallHit[], dropped?: number, maxBodyChars?: number): number;
//# sourceMappingURL=engine.d.ts.map