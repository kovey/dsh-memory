/**
 * Recall scoring (DESIGN §6).
 *
 * Pure functions only: ranking must be testable without a database, and the
 * same weights decide both automatic injection and `memory_search` ordering.
 *
 *   score = bm25_norm × (0.5 + 0.5·confidence) × freshness
 *           × layerWeight × recallBoost × usageBoost
 */
import type { MemoryRecord, Layer } from '../store/types.js';
export interface ScoreComponents {
    relevance: number;
    confidence: number;
    freshness: number;
    layerWeight: number;
    recallBoost: number;
    usageBoost: number;
    /** Lexical match against the title/tags (see {@link lexicalBoost}). */
    lexical: number;
}
export interface ScoredRecord {
    record: MemoryRecord;
    score: number;
    components: ScoreComponents;
}
export interface RankOptions {
    /** FTS5 bm25 values keyed by record id (raw, negative-is-better). */
    relevance?: Map<string, number>;
    /** Query terms, used for the title/tag lexical boost. */
    queryTerms?: readonly string[];
    /** Weight per layer; defaults to LAYER_WEIGHT (DESIGN §6). */
    layerWeights?: Partial<Record<Layer, number>>;
    now?: Date;
    /** Half-life in days for the freshness factor. */
    freshnessHalfLifeDays?: number;
}
/**
 * Normalize raw bm25 values into 0..1.
 *
 * SQLite's `bm25()` is negative and *more negative means a better match*, so
 * relevance grows with the magnitude: the best hit scores 1.
 *
 * Scaling is by the strongest hit, not min-max: with min-max the weakest of two
 * genuine matches would score exactly 0, and the score floor would then drop a
 * record that really did match. A single hit (or a LIKE fallback, where every
 * raw value is 0) scores 1.
 */
export declare const MIN_RELEVANCE = 0.15;
export declare function normalizeRelevance(raw: Map<string, number>): Map<string, number>;
/** Exponential decay with a configurable half-life; never returns 0. */
export declare function freshness(updatedAt: string, now: Date, halfLifeDays?: number): number;
/** Recall history: records that have paid off rank slightly higher. */
export declare function usageBoost(successAfterRecall: number, failAfterRecall: number): number;
/**
 * Frequency: repeated observations are more trustworthy, with diminishing
 * returns. DESIGN §6 budgets one 0.05 coefficient across the two history
 * factors, so each takes half — the maximum combined boost is unchanged.
 */
export declare function frequencyBoost(timesSeen: number): number;
/**
 * History: a record that has actually been recalled (and survived) is worth more
 * than one that merely exists. This is the factor DESIGN §6 calls
 * `times_recalled` — it used to be fed `times_seen`, so the recall history that
 * the usage table records never influenced ranking at all.
 */
export declare function recallBoost(timesRecalled: number): number;
/**
 * Lexical boost for query terms appearing verbatim in the title or tags.
 *
 * FTS5 bm25 alone is a poor precision signal here: a long CJK body can outrank
 * a title match because its bigrams match several OR-ed clauses. A title or tag
 * hit is the strongest available evidence that the record is *about* the task,
 * so it is scored explicitly instead of hoping the column weights get it right.
 */
export declare function lexicalBoost(record: MemoryRecord, terms: readonly string[] | undefined): number;
/** Score one record. `relevance` of 1 means "no query signal" (index listing). */
export declare function scoreRecord(record: MemoryRecord, options?: RankOptions): ScoredRecord;
/** Rank a candidate set, highest score first. */
export declare function rankRecords(records: readonly MemoryRecord[], options?: RankOptions): ScoredRecord[];
/** Rough token estimate (CJK ≈ 1 token/char, ASCII ≈ 1 token/4 chars). */
export declare function estimateTokens(text: string): number;
export interface FitOptions {
    /**
     * Skip an item *before* it consumes a slot. Applying the exclusion after the
     * pick meant records already injected this session filled every slot, so a
     * follow-up turn on the same topic received an empty pack even though fresh
     * matches existed.
     */
    skip?: (recordId: string) => boolean;
    budgetTokens: number;
    maxItems: number;
    minScore: number;
}
export interface FitResult {
    selected: ScoredRecord[];
    dropped: number;
    tokensUsed: number;
}
/** Take the highest-scoring records that fit the token budget and score floor. */
export declare function fitBudget(ranked: readonly ScoredRecord[], render: (item: ScoredRecord) => string, options: FitOptions): FitResult;
//# sourceMappingURL=rank.d.ts.map