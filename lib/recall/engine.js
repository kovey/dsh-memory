import { fitBudget, estimateTokens, normalizeRelevance, rankRecords } from './rank.js';
import { getRecord, rawSearch } from '../store/sqlite/records.js';
import { ScopeResolver } from '../scope/resolver.js';
import { blendRelevance, semanticRecall } from './semantic.js';
const HEADER = '相关记忆（dsh-memory 自动召回；confidence < 0.7 仅为提示，需自行验证）：';
/** Retrieve and rank memory for one query (lexical, optionally blended). */
export async function recall(deps, request) {
    const empty = { hits: [], dropped: 0, tokensUsed: 0, considered: 0, scopes: [] };
    if (request.terms.length === 0)
        return empty;
    const stores = recallStores(deps, request);
    if (stores.length === 0)
        return empty;
    const merged = [];
    /** Records admitted by semantic similarity alone (their id set). */
    const semanticOnlyIds = new Set();
    /** Semantic-only candidates across every root, capped once per query. */
    const semanticCandidates = [];
    let considered = 0;
    let semanticUsed = false;
    let semanticEmbedded = 0;
    let semanticOnly = 0;
    let semanticReason;
    for (const store of stores) {
        const hits = rawSearch(store.db, request.terms, store.fts5, {
            ...(request.layers !== undefined ? { layers: request.layers } : {}),
            status: ['active', 'pending'],
        });
        let relevance = normalizeRelevance(new Map(hits.map((hit) => [hit.id, hit.raw])));
        // Semantic half: only when enabled, and only when lexical recall is thin.
        if (deps.semantic !== undefined) {
            const outcome = await semanticRecall({ config: deps.config, registry: deps.registry, provider: deps.semantic.provider, cache: deps.semantic.cache }, store, request.text ?? request.terms.join(' '), hits.length, { ...(request.signal !== undefined ? { signal: request.signal } : {}) });
            semanticEmbedded += outcome.embedded;
            if (outcome.used && outcome.scores.size > 0) {
                const blended = blendRelevance(relevance, outcome.scores, deps.config.semantic.weight, deps.config.semantic.minSimilarity);
                // Semantic-only finds are the whole point (lexical missed them).
                // The cap is applied once per *query* after every root has been
                // consulted — applying it per store gave a project+global session
                // twice the configured additions.
                for (const id of blended.semanticOnly) {
                    semanticCandidates.push({ id, score: outcome.scores.get(id) ?? 0 });
                }
                for (const [id, score] of blended.relevance)
                    relevance.set(id, score);
                semanticUsed = true;
            }
            else if (outcome.reason !== undefined) {
                semanticReason = outcome.reason;
            }
        }
        const records = [...relevance.keys()]
            .map((id) => getRecord(store.db, id))
            .filter((record) => record !== undefined);
        considered += records.length;
        for (const item of rankRecords(records, { relevance, queryTerms: request.terms })) {
            merged.push({ item, scope: store.scope });
        }
    }
    // Cap the semantic-only additions once per query, and drop the rest from the
    // candidate set entirely: leaving them in would keep them eligible whenever
    // the caller lowered `minScore`, i.e. the cap would not actually cap.
    const rejectedSemantic = new Set();
    if (semanticCandidates.length > 0) {
        const cap = Math.max(0, deps.config.semantic.maxAdditions);
        const admitted = [...semanticCandidates].sort((a, b) => b.score - a.score).slice(0, cap);
        for (const candidate of admitted)
            semanticOnlyIds.add(candidate.id);
        for (const candidate of semanticCandidates) {
            if (!semanticOnlyIds.has(candidate.id))
                rejectedSemantic.add(candidate.id);
        }
        semanticOnly = semanticOnlyIds.size;
    }
    merged.sort((a, b) => b.item.score - a.item.score);
    // Scope lookup keyed by the scored-item *identity*, not by record id: the
    // same slug can exist in two roots (a project and the global store), and an
    // id-keyed map silently relabels one of them — which then writes its recall
    // bookkeeping into the wrong database.
    const scopeByItem = new Map(merged.map(({ item, scope }) => [item, scope]));
    // `minScore` is calibrated for lexical relevance (normalized bm25). A
    // semantic-only hit has already cleared `minSimilarity`, and scaling it by
    // `weight` would otherwise drop it below that lexical floor every time —
    // which is exactly how a "semantic recall found it" case turns into zero
    // injected records. Admit those by their own gate.
    const minScore = request.minScore ?? deps.config.recall.minScore;
    const ranked = merged
        .map(({ item }) => item)
        .filter((item) => !rejectedSemantic.has(item.record.id))
        .filter((item) => item.score >= minScore || semanticOnlyIds.has(item.record.id));
    const budgetTokens = Math.max(0, (request.budgetTokens ?? deps.config.recall.budgetTokens) - estimateTokens(HEADER));
    const scopeOf = (item) => scopeByItem.get(item) ?? stores[0].scope;
    const fitted = fitBudget(ranked, (item) => renderHit({ record: item.record, scope: scopeOf(item), score: item.score }), {
        budgetTokens,
        maxItems: request.maxItems ?? deps.config.recall.maxItems,
        minScore: 0,
        ...(request.exclude !== undefined ? { skip: request.exclude } : {}),
    });
    let dropped = fitted.dropped;
    const hits = [];
    for (const item of fitted.selected) {
        if (request.exclude?.(item.record.id) === true) {
            dropped += 1;
            continue;
        }
        hits.push({ record: item.record, scope: scopeOf(item), score: item.score });
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
    };
}
/** Which roots a recall pass consults: project first, then global (DESIGN §3). */
function recallStores(deps, request) {
    const stores = [];
    const primary = deps.registry.open(deps.resolver.resolve({ agent: request.agent }));
    if (primary !== undefined)
        stores.push(primary);
    const includeGlobal = request.includeGlobal ?? primary?.scope.kind === 'project';
    if (includeGlobal) {
        const global = deps.registry.open(deps.resolver.globalScope());
        if (global !== undefined && !stores.some((store) => store.scope.root === global.scope.root))
            stores.push(global);
    }
    return stores;
}
/** Render one hit as a compact, model-readable line pair. */
export function renderHit(hit, maxBodyChars = 220) {
    const record = hit.record;
    const scope = hit.scope.kind === 'project' ? '项目' : '全局';
    const flags = [`${scope}`, `conf ${record.confidence.toFixed(2)}`, `seen ${record.timesSeen}`];
    const body = record.body.replace(/\s+/g, ' ').trim().slice(0, maxBodyChars);
    return `${record.title} [${flags.join(' · ')} · id ${record.id}]\n   ${body}`;
}
/** Render the whole pack injected into a step. */
export function renderRecallPack(hits, dropped = 0) {
    const lines = [HEADER];
    hits.forEach((hit, index) => lines.push(`${index + 1}. ${renderHit(hit)}`));
    if (dropped > 0)
        lines.push(`（另有 ${dropped} 条相关记忆未展开，可用 memory_search 检索）`);
    lines.push('以上为历史经验，可能与当前情况不符；以实际验证为准，冲突时以当前事实为准。');
    return lines.join('\n');
}
/** Estimated cost of one rendered pack (used by tests and budgets). */
export function packTokens(hits, dropped = 0) {
    return estimateTokens(renderRecallPack(hits, dropped));
}
//# sourceMappingURL=engine.js.map