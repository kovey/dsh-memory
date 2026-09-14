/**
 * Recall scoring (DESIGN §6).
 *
 * Pure functions only: ranking must be testable without a database, and the
 * same weights decide both automatic injection and `memory_search` ordering.
 *
 *   score = bm25_norm × (0.5 + 0.5·confidence) × freshness
 *           × layerWeight × recallBoost × usageBoost
 */
import type { MemoryRecord, Layer } from '../store/types.js'
import { LAYER_WEIGHT } from '../store/types.js'

export interface ScoreComponents {
    relevance: number
    confidence: number
    freshness: number
    layerWeight: number
    recallBoost: number
    usageBoost: number
    /** Lexical match against the title/tags (see {@link lexicalBoost}). */
    lexical: number
}

export interface ScoredRecord {
    record: MemoryRecord
    score: number
    components: ScoreComponents
}

export interface RankOptions {
    /** FTS5 bm25 values keyed by record id (raw, negative-is-better). */
    relevance?: Map<string, number>
    /** Query terms, used for the title/tag lexical boost. */
    queryTerms?: readonly string[]
    /** Weight per layer; defaults to LAYER_WEIGHT (DESIGN §6). */
    layerWeights?: Partial<Record<Layer, number>>
    now?: Date
    /** Half-life in days for the freshness factor. */
    freshnessHalfLifeDays?: number
}

/**
 * Normalize raw bm25 values into 0..1.
 *
 * SQLite's `bm25()` is negative and *more negative means a better match*, so
 * relevance grows with the magnitude: the best hit scores 1 and the worst 0.
 * A single hit (or a LIKE fallback where every raw value is 0) scores 1.
 */
export function normalizeRelevance(raw: Map<string, number>): Map<string, number> {
    if (raw.size === 0) return new Map()
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const value of raw.values()) {
        const magnitude = Math.abs(value)
        if (magnitude < min) min = magnitude
        if (magnitude > max) max = magnitude
    }
    const span = max - min
    const out = new Map<string, number>()
    for (const [id, value] of raw) {
        const magnitude = Math.abs(value)
        out.set(id, span <= Number.EPSILON ? 1 : (magnitude - min) / span)
    }
    return out
}

/** Exponential decay with a configurable half-life; never returns 0. */
export function freshness(updatedAt: string, now: Date, halfLifeDays = 120): number {
    const updated = Date.parse(updatedAt)
    if (!Number.isFinite(updated)) return 0.5
    const ageDays = Math.max(0, (now.getTime() - updated) / 86_400_000)
    return Math.max(0.2, Math.pow(0.5, ageDays / halfLifeDays))
}

/** Recall history: records that have paid off rank slightly higher. */
export function usageBoost(successAfterRecall: number, failAfterRecall: number): number {
    const total = successAfterRecall + failAfterRecall
    if (total === 0) return 1
    const ratio = (successAfterRecall - failAfterRecall) / total
    return Math.max(0.7, Math.min(1.3, 1 + 0.15 * ratio))
}

/** Frequency: repeated observations are more trustworthy, with diminishing returns. */
export function recallBoost(timesSeen: number): number {
    return 1 + 0.05 * Math.min(Math.max(timesSeen, 1), 10)
}

/**
 * Lexical boost for query terms appearing verbatim in the title or tags.
 *
 * FTS5 bm25 alone is a poor precision signal here: a long CJK body can outrank
 * a title match because its bigrams match several OR-ed clauses. A title or tag
 * hit is the strongest available evidence that the record is *about* the task,
 * so it is scored explicitly instead of hoping the column weights get it right.
 */
export function lexicalBoost(record: MemoryRecord, terms: readonly string[] | undefined): number {
    if (terms === undefined || terms.length === 0) return 1
    const title = record.title.toLowerCase()
    const tags = record.tags.join(' ').toLowerCase()
    let hits = 0
    for (const term of terms) {
        if (term.length < 2) continue
        if (title.includes(term) || tags.includes(term)) hits += 1
    }
    if (hits === 0) return 1
    return 1 + 0.35 * Math.min(hits, 3)
}

/** Score one record. `relevance` of 1 means "no query signal" (index listing). */
export function scoreRecord(record: MemoryRecord, options: RankOptions = {}): ScoredRecord {
    const now = options.now ?? new Date()
    const relevance = options.relevance?.get(record.id) ?? 1
    const confidence = 0.5 + 0.5 * clamp01(record.confidence)
    const fresh = freshness(record.updatedAt, now, options.freshnessHalfLifeDays ?? 120)
    const layerWeight = options.layerWeights?.[record.layer] ?? LAYER_WEIGHT[record.layer] ?? 1
    const frequency = recallBoost(record.timesSeen)
    const usage = usageBoost(record.successAfterRecall, record.failAfterRecall)
    const lexical = lexicalBoost(record, options.queryTerms)
    const score = relevance * confidence * fresh * layerWeight * frequency * usage * lexical
    return {
        record,
        score,
        components: {
            relevance,
            confidence,
            freshness: fresh,
            layerWeight,
            recallBoost: frequency,
            usageBoost: usage,
            lexical,
        },
    }
}

/** Rank a candidate set, highest score first. */
export function rankRecords(records: readonly MemoryRecord[], options: RankOptions = {}): ScoredRecord[] {
    return records
        .filter((record) => record.status !== 'archived' && record.supersededBy === undefined)
        .map((record) => scoreRecord(record, options))
        .sort((a, b) => b.score - a.score)
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0
    return Math.min(1, Math.max(0, value))
}

/** Rough token estimate (CJK ≈ 1 token/char, ASCII ≈ 1 token/4 chars). */
export function estimateTokens(text: string): number {
    let cjk = 0
    let other = 0
    for (const char of text) {
        if (/[\u3000-\u9fff\uff00-\uffef]/.test(char)) cjk += 1
        else other += 1
    }
    return cjk + Math.ceil(other / 4)
}

export interface FitOptions {
    budgetTokens: number
    maxItems: number
    minScore: number
}

export interface FitResult {
    selected: ScoredRecord[]
    dropped: number
    tokensUsed: number
}

/** Take the highest-scoring records that fit the token budget and score floor. */
export function fitBudget(ranked: readonly ScoredRecord[], render: (item: ScoredRecord) => string, options: FitOptions): FitResult {
    const selected: ScoredRecord[] = []
    let tokensUsed = 0
    let dropped = 0
    for (const item of ranked) {
        if (selected.length >= options.maxItems) {
            dropped += 1
            continue
        }
        if (item.score < options.minScore) {
            dropped += 1
            continue
        }
        const cost = estimateTokens(render(item))
        if (tokensUsed + cost > options.budgetTokens) {
            dropped += 1
            continue
        }
        selected.push(item)
        tokensUsed += cost
    }
    return { selected, dropped, tokensUsed }
}
