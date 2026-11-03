/**
 * Pack-shape and spend controls (DESIGN §6.1, §14.3).
 *
 * Three things now are configurable where they used to be hardcoded or absent:
 * how much of a lesson body reaches the model (`recall.maxBodyChars`), how the
 * pack is split between the project and global roots (`recall.quota`), and what
 * an embedding pass may spend per day (`semantic.maxTokensPerDay`, plus the
 * month-to-date line `memory_stats` reports).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../dist/config.js'
import { clearRepoCache } from '../dist/paths.js'
import { ScopeResolver } from '../dist/scope/resolver.js'
import { fitBudgetQuoted, packTokens, renderHit } from '../dist/recall/engine.js'
import type { RecallHit } from '../dist/recall/engine.js'
import { scoreRecord } from '../dist/recall/rank.js'
import type { ScoredRecord } from '../dist/recall/rank.js'
import {
    chargeEmbedding,
    embeddingBudgetExhausted,
    embeddingSpend,
    embeddingSpendMonth,
    estimateEmbeddingTokens,
} from '../dist/recall/embed-budget.js'
import { ensureEmbeddings } from '../dist/recall/semantic.js'
import type { EmbeddingProvider } from '../dist/recall/semantic.js'
import { loadSqliteModule } from '../dist/store/sqlite/db.js'
import { materialize, upsertRecord } from '../dist/store/sqlite/records.js'
import { StoreRegistry } from '../dist/store/store.js'
import type { MemoryScope } from '../dist/store/types.js'
import { statsTool } from '../dist/tools/stats.js'
import { fakeRepo, memoryFixture, useGlobalMemoryHome } from './helpers.ts'

interface Harness {
    resolved: ReturnType<typeof resolveConfig>
    registry: StoreRegistry
    resolver: ScopeResolver
    agent: { session: { id: string; header: { cwd: string } } }
    scope: MemoryScope
    store: NonNullable<ReturnType<StoreRegistry['open']>>
}

async function harness(
    t: { skip: (reason: string) => void },
    label: string,
    config: Record<string, unknown> = {},
): Promise<Harness> {
    clearRepoCache()
    const repo = fakeRepo(label)
    const globalHome = memoryFixture(`${label}-global`, {})
    useGlobalMemoryHome(globalHome.root)
    fs.mkdirSync(path.join(repo, '.dsh', 'memory', 'lessons'), { recursive: true })
    const resolved = resolveConfig(config)
    const registry = new StoreRegistry(resolved)
    const report = await registry.initialize(loadSqliteModule)
    if (!registry.available) {
        t.skip(`node:sqlite unavailable: ${report.probe.reason ?? 'unknown'}`)
        throw new Error('unreachable')
    }
    const resolver = new ScopeResolver(resolved)
    const agent = { session: { id: label, header: { cwd: repo } } }
    const scope = resolver.resolve({ agent })
    const store = registry.open(scope)
    assert.ok(store)
    return { resolved, registry, resolver, agent, scope, store }
}

function hit(record: ReturnType<typeof materialize>): RecallHit {
    return { record, scope: { kind: record.scopeKind, root: `/tmp/${record.id}` } as MemoryScope, score: 1 }
}

// ---- recall.maxBodyChars ----------------------------------------------------

test('the body cap is a setting: a longer cap carries more of the lesson', () => {
    const record = materialize({
        title: 'a long lesson',
        body: `触发场景：${'很长的正文'.repeat(120)}。正确做法：截断应当可配置。`,
        layer: 'project',
        scopeKind: 'project',
    })
    const sample = hit(record)
    const short = renderHit(sample, 120)
    const long = renderHit(sample, 900)
    assert.ok(long.length > short.length, 'a larger cap must keep more characters')
    assert.ok(packTokens([sample], 0, 120) < packTokens([sample], 0, 900))
    // default stays the historical 220
    assert.equal(renderHit(sample), renderHit(sample, 220))
    assert.equal(resolveConfig({}).recall.maxBodyChars, 220)
    assert.equal(resolveConfig({ recall: { maxBodyChars: 600 } }).recall.maxBodyChars, 600)
})

// ---- recall.quota -----------------------------------------------------------

function scored(
    title: string,
    layer: 'project' | 'global',
    body: string,
    updatedAt: string,
    now: Date,
): ScoredRecord {
    const record = materialize(
        { title, body, layer, scopeKind: layer, ...(layer === 'project' ? { repo: '/tmp/repo' } : {}) },
        updatedAt,
    )
    return scoreRecord(record, { relevance: new Map([[record.id, 1]]), now })
}

test('the default quota is off: the fit is one score-ordered list', () => {
    const resolved = resolveConfig({})
    assert.deepEqual(resolved.recall.quota, { globalMinTokens: 0, projectMaxTokens: 0 })
})

test('a global floor reserves space even when a fresh project record outranks it', () => {
    const now = new Date('2026-06-01T00:00:00.000Z')
    const fresh = scored('fresh project lesson', 'project', '触发场景：新的。正确做法：新的做法。', '2026-06-01T00:00:00.000Z', now)
    const old = scored('old global lesson', 'global', '触发场景：旧的。正确做法：旧的做法更有价值。', '2024-01-01T00:00:00.000Z', now)
    assert.ok(fresh.score > old.score, 'freshness must make the new record win on score')

    const render = (item: ScoredRecord): string => `${item.record.title}\n${item.record.body}`
    const isGlobal = (item: ScoredRecord): boolean => item.record.scopeKind === 'global'
    const ranked = [fresh, old]

    const plain = fitBudgetQuoted(ranked, render, { budgetTokens: 400, maxItems: 1, minScore: 0 }, isGlobal, {
        globalMinTokens: 0,
        projectMaxTokens: 0,
    })
    assert.equal(plain.selected[0]?.record.id, fresh.record.id)

    const quoted = fitBudgetQuoted(ranked, render, { budgetTokens: 400, maxItems: 1, minScore: 0 }, isGlobal, {
        globalMinTokens: 300,
        projectMaxTokens: 0,
    })
    assert.equal(quoted.selected[0]?.record.id, old.record.id, 'the floor must admit the global lesson')
})

test('the project ceiling applies to the filling pass too', () => {
    const now = new Date('2026-06-01T00:00:00.000Z')
    const p1 = scored('project one', 'project', 'x'.repeat(200), '2026-06-01T00:00:00.000Z', now)
    const p2 = scored('project two', 'project', 'x'.repeat(200), '2026-06-01T00:00:00.000Z', now)
    const g1 = scored('global one', 'global', 'x'.repeat(200), '2026-06-01T00:00:00.000Z', now)
    const ranked = [p1, p2, g1]
    const render = (item: ScoredRecord): string => item.record.body
    const isGlobal = (item: ScoredRecord): boolean => item.record.scopeKind === 'global'
    const cost = estimateEmbeddingTokens([render(p1)])

    const fitted = fitBudgetQuoted(ranked, render, { budgetTokens: 5_000, maxItems: 5, minScore: 0 }, isGlobal, {
        globalMinTokens: 0,
        projectMaxTokens: cost,
    })
    const projects = fitted.selected.filter((item) => item.record.scopeKind === 'project')
    assert.equal(projects.length, 1, 'only one project record fits the ceiling')
    assert.ok(fitted.selected.some((item) => item.record.scopeKind === 'global'))
})

test('the quota pair is clamped so it can never overspend the pack budget', () => {
    const resolved = resolveConfig({ recall: { budgetTokens: 600, quota: { globalMinTokens: 500, projectMaxTokens: 400 } } })
    assert.ok(resolved.recall.quota.globalMinTokens + resolved.recall.quota.projectMaxTokens <= 600)
    assert.equal(resolved.recall.quota.globalMinTokens, 500)
    assert.equal(resolved.recall.quota.projectMaxTokens, 100)
})

// ---- embedding budget -------------------------------------------------------

test('embedding spend is recorded per UTC day and the cap is a setting', async (t) => {
    const h = await harness(t, 'spend-budget', { semantic: { enabled: true, maxTokensPerDay: 400 } })
    assert.equal(embeddingSpend(h.store.db), 0)
    assert.equal(embeddingBudgetExhausted(h.resolved, h.store.db), false)

    chargeEmbedding(h.store.db, 250)
    assert.equal(embeddingSpend(h.store.db), 250)
    assert.equal(embeddingSpendMonth(h.store.db), 250)
    assert.equal(embeddingBudgetExhausted(h.resolved, h.store.db), false)

    chargeEmbedding(h.store.db, 200)
    assert.equal(embeddingBudgetExhausted(h.resolved, h.store.db), true)

    const unlimited = resolveConfig({ semantic: { enabled: true, maxTokensPerDay: 0 } })
    assert.equal(embeddingBudgetExhausted(unlimited, h.store.db), false, '0 disables the cap')
})

test('an embedding pass charges the tokens it sent', async (t) => {
    const h = await harness(t, 'spend-charge')
    upsertRecord(h.store.db, materialize({ title: 'charge me', body: '触发场景：x。正确做法：y。', layer: 'project', scopeKind: 'project', repo: h.scope.repo }))
    const provider: EmbeddingProvider = {
        id: 'fake',
        available: () => true,
        lastError: () => undefined,
        async embed(texts) {
            return texts.map(() => [0.1, 0.2, 0.3])
        },
    }
    const embedded = await ensureEmbeddings(h.store.db, provider, 'fake-model')
    assert.equal(embedded, 1)
    assert.ok(embeddingSpend(h.store.db) > 0, 'the pass must be accounted for')
})

// ---- memory_stats spend line ------------------------------------------------

test('memory_stats answers what this month cost, per store', async (t) => {
    const h = await harness(t, 'spend-stats', { semantic: { enabled: true, maxTokensPerDay: 1_000 } })
    const at = new Date().toISOString()
    h.store.db
        .prepare(
            'INSERT INTO distill (session_id, turn, model, prompt_hash, tokens_in, tokens_out, created_count, timed_out, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run('s1', 3, 'fake/model', 'hash', 100, 50, 1, 0, at)
    chargeEmbedding(h.store.db, 30)

    const tool = statsTool({ config: h.resolved, registry: h.registry, resolver: h.resolver })
    const output = String(await tool.execute({} as never, { agent: h.agent } as never))
    const month = at.slice(0, 7)
    assert.match(
        output,
        new RegExp(`spend ${month}: distillation 150 tok / 1 run\\(s\\) · embeddings 30 tok \\(cap 1000/day\\)`),
    )
})
