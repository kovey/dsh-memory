/**
 * Recall engine (DESIGN §6): turn a query into the highest-value memory pack
 * that fits a token budget.
 *
 * Pure with respect to the session — it reads stores and returns a selection;
 * the caller decides how (and whether) to inject it.
 */
import type { MemoryConfig } from '../config.js'
import { fitBudget, estimateTokens, normalizeRelevance, rankRecords } from './rank.js'
import type { ScoredRecord } from './rank.js'
import { getRecord, rawSearch } from '../store/sqlite/records.js'
import type { StoreRegistry, ScopeStore } from '../store/store.js'
import type { Layer, MemoryRecord, MemoryScope } from '../store/types.js'
import type { AgentLike } from '../scope/resolver.js'
import { ScopeResolver } from '../scope/resolver.js'
import { blendRelevance, semanticRecall } from './semantic.js'
import type { EmbeddingProvider, QueryVectorCache } from './semantic.js'

export interface RecallDeps {
    config: MemoryConfig
    registry: StoreRegistry
    resolver: ScopeResolver
    /** Optional semantic recall (DESIGN §14.3). Absent = lexical only. */
    semantic?: { provider?: EmbeddingProvider | undefined; cache?: QueryVectorCache } | undefined
}

export interface RecallRequest {
    agent?: AgentLike | undefined
    terms: readonly string[]
    /** Original query text, used for the embedding request. */
    text?: string | undefined
    /** Cancellation for the bounded embedding call. */
    signal?: AbortSignal | undefined
    /** Records already surfaced in this session (idempotence, DESIGN §6). */
    exclude?: (recordId: string) => boolean
    budgetTokens?: number
    maxItems?: number
    minScore?: number
    layers?: readonly Layer[]
    /** Also search the global root when the session scope is a project. */
    includeGlobal?: boolean
}

export interface RecallHit {
    record: MemoryRecord
    scope: MemoryScope
    score: number
}

export interface RecallOutcome {
    hits: RecallHit[]
    /** Matching records that did not fit the budget / score floor. */
    dropped: number
    tokensUsed: number
    /** Records that matched the query before filtering. */
    considered: number
    scopes: MemoryScope[]
    /** Semantic pass bookkeeping (absent when semantic recall is off). */
    semantic?: { used: boolean; embedded: number; semanticOnly: number; reason?: string }
}

const HEADER = '相关记忆（dsh-memory 自动召回；confidence < 0.7 仅为提示，需自行验证）：'

/** Retrieve and rank memory for one query (lexical, optionally blended). */
export async function recall(deps: RecallDeps, request: RecallRequest): Promise<RecallOutcome> {
    const empty: RecallOutcome = { hits: [], dropped: 0, tokensUsed: 0, considered: 0, scopes: [] }
    if (request.terms.length === 0) return empty

    const stores = recallStores(deps, request)
    if (stores.length === 0) return empty

    const merged: { item: ScoredRecord; scope: MemoryScope }[] = []
    /** Records admitted by semantic similarity alone (their id set). */
    const semanticOnlyIds = new Set<string>()
    let considered = 0
    let semanticUsed = false
    let semanticEmbedded = 0
    let semanticOnly = 0
    let semanticReason: string | undefined

    for (const store of stores) {
        const hits = rawSearch(store.db, request.terms, store.fts5, {
            ...(request.layers !== undefined ? { layers: request.layers } : {}),
            status: ['active', 'pending'],
        })
        let relevance = normalizeRelevance(new Map(hits.map((hit) => [hit.id, hit.raw])))

        // Semantic half: only when enabled, and only when lexical recall is thin.
        if (deps.semantic !== undefined) {
            const outcome = await semanticRecall(
                { config: deps.config, registry: deps.registry, provider: deps.semantic.provider, cache: deps.semantic.cache },
                store,
                request.text ?? request.terms.join(' '),
                hits.length,
                { ...(request.signal !== undefined ? { signal: request.signal } : {}) },
            )
            semanticEmbedded += outcome.embedded
            if (outcome.used && outcome.scores.size > 0) {
                const blended = blendRelevance(
                    relevance,
                    outcome.scores,
                    deps.config.semantic.weight,
                    deps.config.semantic.minSimilarity,
                )
                // Semantic-only finds are the whole point (lexical missed them),
                // but unbounded they pad every pack: keep the best few.
                const cap = deps.config.semantic.maxAdditions
                let kept = 0
                const bounded = new Map<string, number>()
                const additions = blended.semanticOnly
                    .map((id) => ({ id, score: outcome.scores.get(id) ?? 0 }))
                    .sort((a, b) => b.score - a.score)
                    .slice(0, cap)
                    .map((entry) => entry.id)
                for (const [id, score] of blended.relevance) {
                    const semanticOnlyHit = blended.semanticOnly.includes(id)
                    if (semanticOnlyHit) {
                        if (!additions.includes(id)) continue
                        kept += 1
                    }
                    bounded.set(id, score)
                }
                relevance = bounded
                for (const id of additions) semanticOnlyIds.add(id)
                semanticUsed = true
                semanticOnly += kept
            } else if (outcome.reason !== undefined) {
                semanticReason = outcome.reason
            }
        }

        const records = [...relevance.keys()]
            .map((id) => getRecord(store.db, id))
            .filter((record): record is MemoryRecord => record !== undefined)
        considered += records.length
        for (const item of rankRecords(records, { relevance, queryTerms: request.terms })) {
            merged.push({ item, scope: store.scope })
        }
    }

    merged.sort((a, b) => b.item.score - a.item.score)
    // `minScore` is calibrated for lexical relevance (normalized bm25). A
    // semantic-only hit has already cleared `minSimilarity`, and scaling it by
    // `weight` would otherwise drop it below that lexical floor every time —
    // which is exactly how a "semantic recall found it" case turns into zero
    // injected records. Admit those by their own gate.
    const minScore = request.minScore ?? deps.config.recall.minScore
    const ranked = merged
        .map(({ item }) => item)
        .filter((item) => item.score >= minScore || semanticOnlyIds.has(item.record.id))
    const scopeOf = new Map(ranked.map((item, index) => [item.record.id, merged[index]?.scope]))
    const budgetTokens = Math.max(0, (request.budgetTokens ?? deps.config.recall.budgetTokens) - estimateTokens(HEADER))
    const fitted = fitBudget(ranked, (item) => renderHit({ record: item.record, scope: scopeOf.get(item.record.id) ?? stores[0]!.scope, score: item.score }), {
        budgetTokens,
        maxItems: request.maxItems ?? deps.config.recall.maxItems,
        minScore: 0,
    })

    let dropped = fitted.dropped
    const hits: RecallHit[] = []
    for (const item of fitted.selected) {
        if (request.exclude?.(item.record.id) === true) {
            dropped += 1
            continue
        }
        const scope = scopeOf.get(item.record.id) ?? stores[0]!.scope
        hits.push({ record: item.record, scope, score: item.score })
    }
    return {
        hits,
        dropped,
        tokensUsed: fitted.tokensUsed + estimateTokens(HEADER),
        considered,
        scopes: stores.map((s) => s.scope),
        ...(deps.semantic !== undefined
            ? {
                  semantic: {
                      used: semanticUsed,
                      embedded: semanticEmbedded,
                      semanticOnly,
                      // Only surface a reason when the pass contributed nothing:
                      // otherwise an empty secondary scope would mask the store
                      // that actually ran semantic recall.
                      ...(!semanticUsed && semanticReason !== undefined ? { reason: semanticReason } : {}),
                  },
              }
            : {}),
    }
}

/** Which roots a recall pass consults: project first, then global (DESIGN §3). */
function recallStores(deps: RecallDeps, request: RecallRequest): ScopeStore[] {
    const stores: ScopeStore[] = []
    const primary = deps.registry.open(deps.resolver.resolve({ agent: request.agent }))
    if (primary !== undefined) stores.push(primary)
    const includeGlobal = request.includeGlobal ?? primary?.scope.kind === 'project'
    if (includeGlobal) {
        const global = deps.registry.open(deps.resolver.globalScope())
        if (global !== undefined && !stores.some((store) => store.scope.root === global.scope.root)) stores.push(global)
    }
    return stores
}

/** Render one hit as a compact, model-readable line pair. */
export function renderHit(hit: RecallHit, maxBodyChars = 220): string {
    const record = hit.record
    const scope = hit.scope.kind === 'project' ? '项目' : '全局'
    const flags = [`${scope}`, `conf ${record.confidence.toFixed(2)}`, `seen ${record.timesSeen}`]
    const body = record.body.replace(/\s+/g, ' ').trim().slice(0, maxBodyChars)
    return `${record.title} [${flags.join(' · ')} · id ${record.id}]\n   ${body}`
}

/** Render the whole pack injected into a step. */
export function renderRecallPack(hits: readonly RecallHit[], dropped = 0): string {
    const lines = [HEADER]
    hits.forEach((hit, index) => lines.push(`${index + 1}. ${renderHit(hit)}`))
    if (dropped > 0) lines.push(`（另有 ${dropped} 条相关记忆未展开，可用 memory_search 检索）`)
    lines.push('以上为历史经验，可能与当前情况不符；以实际验证为准，冲突时以当前事实为准。')
    return lines.join('\n')
}

/** Estimated cost of one rendered pack (used by tests and budgets). */
export function packTokens(hits: readonly RecallHit[], dropped = 0): number {
    return estimateTokens(renderRecallPack(hits, dropped))
}
