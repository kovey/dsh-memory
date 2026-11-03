/**
 * Embedding spend guard (DESIGN §2 "不偷偷花钱", §14.3).
 *
 * Semantic recall is the only opt-in path that pays a third party per call, and
 * unlike distillation it had no ceiling and no accounting: a host that turned it
 * on could spend on every query and `memory_stats` would show nothing. This
 * module adds the same two things distillation has — a daily cap and a record of
 * what was spent — without a schema change: the counters live under
 * `meta['embed_spend:<UTC day>']`.
 *
 * Token counts are *estimates* of the text sent to the endpoint (the same
 * `estimateTokens` the recall budget uses). The API's own `usage.total_tokens`
 * is not assumed: not every OpenAI-compatible endpoint returns it, and a guard
 * that silently reads zero is worse than an estimate.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryConfig } from '../config.js';
/** UTC day key — the same boundary `dailyDistillTokens` uses. */
export declare function spendDay(now?: Date): string;
/** Tokens charged to one day (0 when nothing was spent). */
export declare function embeddingSpend(db: DatabaseSync, day?: string): number;
/** Add tokens to today's counter. Never throws; the counter is bookkeeping. */
export declare function chargeEmbedding(db: DatabaseSync, tokens: number, now?: Date): void;
/** True when today's embedding budget is used up. `maxTokensPerDay: 0` = no cap. */
export declare function embeddingBudgetExhausted(config: MemoryConfig, db: DatabaseSync, now?: Date): boolean;
/** Estimated tokens for one batch of texts (what the endpoint will bill roughly). */
export declare function estimateEmbeddingTokens(texts: readonly string[]): number;
/** Month-to-date embedding spend (sum of the daily keys), for `memory_stats`. */
export declare function embeddingSpendMonth(db: DatabaseSync, now?: Date): number;
//# sourceMappingURL=embed-budget.d.ts.map