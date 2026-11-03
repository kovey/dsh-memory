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
import type { DatabaseSync } from 'node:sqlite'
import type { MemoryConfig } from '../config.js'
import { log } from '../log.js'
import { getMeta, setMeta } from '../store/sqlite/db.js'
import { estimateTokens } from './rank.js'

const KEY_PREFIX = 'embed_spend:'

/** UTC day key — the same boundary `dailyDistillTokens` uses. */
export function spendDay(now: Date = new Date()): string {
    return new Date(now.getTime() - (now.getTime() % 86_400_000)).toISOString().slice(0, 10)
}

/** Tokens charged to one day (0 when nothing was spent). */
export function embeddingSpend(db: DatabaseSync, day: string = spendDay()): number {
    const raw = getMeta(db, `${KEY_PREFIX}${day}`)
    if (raw === undefined) return 0
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : 0
}

/** Add tokens to today's counter. Never throws; the counter is bookkeeping. */
export function chargeEmbedding(db: DatabaseSync, tokens: number, now: Date = new Date()): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return
    try {
        const day = spendDay(now)
        setMeta(db, `${KEY_PREFIX}${day}`, String(Math.round(embeddingSpend(db, day) + tokens)))
    } catch (error) {
        log('debug', 'memory: recording embedding spend failed:', error)
    }
}

/** True when today's embedding budget is used up. `maxTokensPerDay: 0` = no cap. */
export function embeddingBudgetExhausted(
    config: MemoryConfig,
    db: DatabaseSync,
    now: Date = new Date(),
): boolean {
    const cap = config.semantic.maxTokensPerDay
    if (cap <= 0) return false
    return embeddingSpend(db, spendDay(now)) >= cap
}

/** Estimated tokens for one batch of texts (what the endpoint will bill roughly). */
export function estimateEmbeddingTokens(texts: readonly string[]): number {
    let total = 0
    for (const text of texts) total += estimateTokens(text)
    return total
}

/** Month-to-date embedding spend (sum of the daily keys), for `memory_stats`. */
export function embeddingSpendMonth(db: DatabaseSync, now: Date = new Date()): number {
    const month = spendDay(now).slice(0, 7)
    let total = 0
    try {
        const rows = db.prepare('SELECT key, value FROM meta WHERE key LIKE ?').all(`${KEY_PREFIX}${month}-%`)
        for (const row of rows) {
            const value = Number(row['value'])
            if (Number.isFinite(value) && value > 0) total += value
        }
    } catch {
        // a missing meta table (or a malformed row) means "nothing recorded"
    }
    return total
}
