/**
 * Quality-workflow tests (DESIGN §8): decay, archiving, contradiction handling,
 * promotion proposals and the consolidation report.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { applyConflicts, detectConflicts, directivePolarity, pickWinner } from '../lib/learn/conflicts.js'
import { consolidate, openProposals, promotionCandidates, recordProposals, resolveProposal } from '../lib/learn/consolidate.js'
import { applyDecay, consolidationDue, lastConsolidateAt, markConsolidated, planDecay } from '../lib/learn/decay.js'
import { clearRepoCache } from '../lib/paths.js'
import { ScopeResolver } from '../lib/scope/resolver.js'
import { getMeta, setMeta } from '../lib/store/sqlite/db.js'
import { loadSqliteModule } from '../lib/store/sqlite/db.js'
import { countRecords, getRecord, listRecords, materialize, upsertRecord } from '../lib/store/sqlite/records.js'
import { StoreRegistry } from '../lib/store/store.js'
import { forgetTool } from '../lib/tools/consolidate.js'
import type { MemoryRecord } from '../lib/store/types.js'
import { fakeRepo, memoryFixture, useGlobalMemoryHome } from './helpers.ts'

function record(overrides: Partial<MemoryRecord> & { id: string; title: string; body: string }): MemoryRecord {
    const base = materialize({
        title: overrides.title,
        body: overrides.body,
        layer: 'project',
        scopeKind: 'project',
        confidence: overrides.confidence ?? 0.8,
    })
    return { ...base, ...overrides, evidence: overrides.evidence ?? base.evidence }
}

async function harness(t: { skip: (reason: string) => void }, config: Record<string, unknown> = {}) {
    clearRepoCache()
    const repo = fakeRepo('m3-repo')
    const globalHome = memoryFixture('m3-global', {})
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
    const agent = { session: { id: 'm3', header: { cwd: repo } } }
    const scope = resolver.resolve({ agent })
    const store = registry.open(scope)
    assert.ok(store)
    return { repo, resolved, registry, resolver, agent, scope, store, deps: { config: resolved, registry, resolver } }
}

// ---- decay ------------------------------------------------------------------

test('the first decay run initializes its marker without touching confidence', async (t) => {
    const h = await harness(t)
    const created = record({ id: 'keep', title: 'keep me', body: '触发场景：任何时候。正确做法：保留。', confidence: 0.8 })
    upsertRecord(h.store.db, created)

    const plan = planDecay(h.store.db)
    assert.equal(plan.factor, 1)
    assert.equal(plan.elapsedDays, 0)
    const outcome = applyDecay(h.store.db, plan)
    assert.equal(outcome.decayed, 0)
    assert.equal(getRecord(h.store.db, 'keep')?.confidence, 0.8)
    assert.ok(getMeta(h.store.db, 'last_decay_at') !== undefined)
})

test('expired and stale-pending records are archived, survivors decay', async (t) => {
    const h = await harness(t)
    const now = new Date('2026-09-14T00:00:00.000Z')
    upsertRecord(h.store.db, record({ id: 'expired', title: 'expired lesson', body: '触发场景：旧版本。正确做法：升级。', expiresAt: '2026-01-01' }))
    upsertRecord(
        h.store.db,
        record({
            id: 'stale',
            title: 'stale hypothesis',
            body: '触发场景：也许。正确做法：待验证。',
            confidence: 0.4,
            status: 'pending',
            updatedAt: '2026-05-01T00:00:00.000Z',
        }),
    )
    upsertRecord(h.store.db, record({ id: 'keeper', title: 'keeper', body: '触发场景：每次。正确做法：照做。', confidence: 0.9 }))

    // pretend the last decay ran a full half-life ago
    setMeta(h.store.db, 'last_decay_at', '2026-03-18T00:00:00.000Z')
    const plan = planDecay(h.store.db, now)
    assert.equal(plan.skipped, false)
    assert.ok(Math.abs(plan.factor - 0.5) < 0.05, `expected ~0.5, got ${plan.factor}`)

    const outcome = applyDecay(h.store.db, plan, { now })
    assert.deepEqual(outcome.archivedIds.sort(), ['expired', 'stale'])
    assert.equal(getRecord(h.store.db, 'expired')?.status, 'archived')
    assert.equal(getRecord(h.store.db, 'stale')?.status, 'archived')
    const keeper = getRecord(h.store.db, 'keeper')
    assert.ok(keeper)
    assert.ok(Math.abs(keeper.confidence - 0.45) < 0.03, `keeper should halve, got ${keeper.confidence}`)
})

test('decay is interval-gated so repeated runs cannot compound', async (t) => {
    const h = await harness(t)
    upsertRecord(h.store.db, record({ id: 'a', title: 'a lesson', body: '触发场景：x。正确做法：y。', confidence: 0.9 }))
    setMeta(h.store.db, 'last_decay_at', new Date().toISOString())
    const plan = planDecay(h.store.db)
    assert.equal(plan.skipped, true)
    assert.equal(plan.factor, 1)
    const outcome = applyDecay(h.store.db, plan)
    assert.equal(outcome.decayed, 0)
    assert.equal(getRecord(h.store.db, 'a')?.confidence, 0.9)
})

test('dry-run decay reports without changing anything', async (t) => {
    const h = await harness(t)
    upsertRecord(h.store.db, record({ id: 'expired', title: 'gone', body: '触发场景：x。正确做法：y。', expiresAt: '2026-01-01' }))
    const outcome = applyDecay(h.store.db, planDecay(h.store.db), { dryRun: true })
    assert.equal(outcome.archived, 1)
    assert.equal(getRecord(h.store.db, 'expired')?.status, 'active')
})

test('consolidation cadence follows days and task counts', async (t) => {
    const h = await harness(t)
    assert.equal(consolidationDue(h.store.db, { everyDays: 7, everyNTasks: 5 }).due, true, 'first run')
    markConsolidated(h.store.db, new Date())
    assert.equal(consolidationDue(h.store.db, { everyDays: 7, everyNTasks: 5 }).due, false)
    markConsolidated(h.store.db, new Date(Date.now() - 8 * 86_400_000))
    assert.equal(consolidationDue(h.store.db, { everyDays: 7, everyNTasks: 5 }).due, true)
    assert.ok(lastConsolidateAt(h.store.db) !== undefined)
})

// ---- conflicts --------------------------------------------------------------

test('opposite directives about the same object are a conflict; unrelated ones are not', async (t) => {
    const h = await harness(t)
    const positive = record({
        id: 'use-ci',
        title: 'pnpm 安装参数',
        body: '必须执行 CI=true pnpm install 安装依赖。',
        confidence: 0.8,
        updatedAt: '2026-08-01T00:00:00.000Z',
    })
    const negative = record({
        id: 'no-ci',
        title: 'pnpm 安装参数',
        body: '不要执行 CI=true pnpm install 安装依赖，禁止跳过校验。',
        confidence: 0.9,
        updatedAt: '2026-09-01T00:00:00.000Z',
    })
    const unrelated = record({ id: 'other', title: 'unrelated topic', body: '必须给数据库加索引。', confidence: 0.9 })
    for (const item of [positive, negative, unrelated]) upsertRecord(h.store.db, item)

    assert.equal(directivePolarity(positive.body), 1)
    assert.equal(directivePolarity(negative.body), -1)
    assert.equal(directivePolarity('今天天气不错'), 0)

    const candidates = detectConflicts(listRecords(h.store.db))
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0]?.winner.id, 'no-ci', 'newer + more confident wins')
    assert.equal(candidates[0]?.loser.id, 'use-ci')
    assert.equal(pickWinner(positive, negative).id, 'no-ci')
})

test('conflicts are recorded without resolving unless asked', async (t) => {
    const h = await harness(t)
    const a = record({ id: 'a', title: 'same topic', body: '必须使用 X 方式处理。', updatedAt: '2026-08-01T00:00:00.000Z' })
    const b = record({ id: 'b', title: 'same topic', body: '不要使用 X 方式处理 X，禁止这样。', confidence: 0.95, updatedAt: '2026-09-01T00:00:00.000Z' })
    upsertRecord(h.store.db, a)
    upsertRecord(h.store.db, b)

    const candidates = detectConflicts(listRecords(h.store.db))
    const recorded = applyConflicts(h.store.db, candidates, { resolve: false })
    assert.equal(recorded[0]?.recorded, true)
    assert.equal(recorded[0]?.resolved, false)
    assert.equal(getRecord(h.store.db, 'a')?.status, 'active', 'loser stays active until resolution is requested')
    const rows = h.store.db.prepare('SELECT winner_id, loser_id FROM conflicts').all()
    assert.equal(rows.length, 1)

    // idempotent: a second pass does not duplicate the conflict row
    applyConflicts(h.store.db, detectConflicts(listRecords(h.store.db)), { resolve: true })
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM conflicts').get()?.['n'], 1)
    const loser = getRecord(h.store.db, 'a')
    assert.equal(loser?.status, 'archived')
    assert.equal(loser?.supersededBy, 'b')
})

// ---- proposals --------------------------------------------------------------

test('repeatedly verified lessons become promotion proposals, never automatic skills', async (t) => {
    const h = await harness(t)
    upsertRecord(h.store.db, record({ id: 'stable', title: 'stable lesson', body: '触发场景：每次部署。正确做法：先 fetch 再推送。', confidence: 0.95, timesSeen: 4 }))
    upsertRecord(h.store.db, record({ id: 'fresh', title: 'fresh lesson', body: '触发场景：刚发生。正确做法：观察。', confidence: 0.95, timesSeen: 1 }))

    const candidates = promotionCandidates(h.store.db)
    assert.deepEqual(candidates.map((item) => item.id), ['stable'])
    assert.equal(recordProposals(h.store.db, [{ kind: 'promote-skill', recordId: 'stable', title: 'stable lesson', rationale: 'seen 4×' }]), 1)
    assert.equal(recordProposals(h.store.db, [{ kind: 'promote-skill', recordId: 'stable', title: 'stable lesson', rationale: 'seen 4×' }]), 0, 'idempotent')
    const open = openProposals(h.store.db)
    assert.equal(open.length, 1)
    assert.equal(resolveProposal(h.store.db, 'stable', 'accepted'), 1)
    assert.equal(openProposals(h.store.db).length, 0)
})

// ---- consolidation ----------------------------------------------------------

test('consolidate() is a dry run unless asked to apply', async (t) => {
    const h = await harness(t)
    upsertRecord(h.store.db, record({ id: 'expired', title: 'expired', body: '触发场景：x。正确做法：y。', expiresAt: '2026-01-01' }))
    upsertRecord(h.store.db, record({ id: 'stable', title: 'stable lesson', body: '触发场景：每次部署。正确做法：先 fetch 再推送。', confidence: 0.95, timesSeen: 4 }))

    const dry = consolidate(h.store.db, h.scope, h.store.fts5, { dryRun: true })
    assert.equal(dry.dryRun, true)
    assert.equal(dry.archived, 1)
    assert.equal(dry.proposals.length, 1)
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM consolidate_runs').get()?.['n'], 0)
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM proposals').get()?.['n'], 0)
    assert.equal(getRecord(h.store.db, 'expired')?.status, 'active')
    assert.deepEqual(dry.errors, [])

    const applied = consolidate(h.store.db, h.scope, h.store.fts5, { dryRun: false })
    assert.equal(applied.archived, 1)
    assert.equal(getRecord(h.store.db, 'expired')?.status, 'archived')
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM proposals').get()?.['n'], 1)
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM consolidate_runs').get()?.['n'], 1)
    assert.ok(lastConsolidateAt(h.store.db) !== undefined)
})

test('archiving moves the lesson file instead of deleting it', async (t) => {
    const h = await harness(t)
    upsertRecord(h.store.db, record({ id: 'expired', title: 'expired lesson', body: '触发场景：x。正确做法：y。', expiresAt: '2026-01-01' }))
    h.registry.exportScope(h.scope)
    assert.ok(fs.existsSync(path.join(h.scope.root, 'lessons', 'expired.md')))

    consolidate(h.store.db, h.scope, h.store.fts5, { dryRun: false })
    assert.equal(fs.existsSync(path.join(h.scope.root, 'lessons', 'expired.md')), false)
    assert.ok(fs.existsSync(path.join(h.scope.root, 'archive', 'lessons', 'expired.md')), 'archived file must survive')

    // and the text view keeps the record out of the active set
    const index = fs.readFileSync(path.join(h.scope.root, 'MEMORY.md'), 'utf8')
    assert.doesNotMatch(index, /expired lesson/)
})

test('memory_forget retires a record and keeps its file archived', async (t) => {
    const h = await harness(t)
    upsertRecord(h.store.db, record({ id: 'wrong', title: 'wrong lesson', body: '触发场景：x。正确做法：y。' }))
    h.registry.exportScope(h.scope)
    const tool = forgetTool(h.deps)
    const output = await tool.execute({ id: 'wrong', reason: 'turned out wrong' } as never, { agent: h.agent } as never)
    assert.match(String(output), /retired: wrong/)
    assert.equal(getRecord(h.store.db, 'wrong')?.status, 'archived')
    assert.ok(fs.existsSync(path.join(h.scope.root, 'archive', 'lessons', 'wrong.md')))

    const missing = await tool.execute({ id: 'nope' } as never, { agent: h.agent } as never)
    assert.match(String(missing), /not found/)
})

test('project consolidation never touches the global store', async (t) => {
    const h = await harness(t)
    const globalStore = h.registry.open(h.resolver.globalScope())
    assert.ok(globalStore)
    upsertRecord(globalStore.db, {
        ...record({ id: 'global-lesson', title: 'global lesson', body: '触发场景：x。正确做法：y。', expiresAt: '2026-01-01' }),
        layer: 'global',
        scopeKind: 'global',
        repo: undefined,
    })

    consolidate(h.store.db, h.scope, h.store.fts5, { dryRun: false })
    assert.equal(getRecord(globalStore.db, 'global-lesson')?.status, 'active', 'global store untouched')
    assert.equal(countRecords(h.store.db).total, 0)
})

test('a promotion candidate gets a reviewable skill draft', async (t) => {
    // DESIGN §3: the L3 → L4 step is human-approved. The plugin therefore leaves
    // a ready-to-move SKILL.md inside the memory root instead of writing into
    // ~/.dsh/skills, so accepting a proposal is a copy rather than an authoring
    // exercise.
    const h = await harness(t)
    upsertRecord(
        h.store.db,
        record({
            id: 'stable-lesson',
            title: 'stable lesson',
            body: '触发场景：无 TTY 下 pnpm install 中止。正确做法：设置 CI=true 后重试安装命令。',
            confidence: 0.95,
            timesSeen: 4,
        }),
    )
    const report = consolidate(h.store.db, h.scope, h.store.fts5, { dryRun: false })
    assert.equal(report.proposals.length, 1)
    assert.equal(report.proposals[0]?.kind, 'promote-skill')
    assert.equal(report.skillDrafts.length, 1, 'a draft is written for each proposal')

    const draft = fs.readFileSync(report.skillDrafts[0] as string, 'utf8')
    assert.match(draft, /^---\nname: mem-stable-lesson\n/m, 'host-compatible frontmatter')
    assert.match(draft, /description: /)
    assert.match(draft, /CI=true 后重试/, 'the lesson body travels with the draft')
    assert.match(draft, /provenance: id=stable-lesson .*seen=4/)
    assert.ok(report.skillDrafts[0]?.startsWith(h.scope.root), 'the draft stays inside the memory root')

    // a dry run writes nothing at all
    const proposals = path.join(h.scope.root, 'proposals')
    fs.rmSync(proposals, { recursive: true, force: true })
    const dry = consolidate(h.store.db, h.scope, h.store.fts5, { dryRun: true })
    assert.equal(dry.skillDrafts.length, 0)
    assert.equal(fs.existsSync(proposals), false)

    // the next real pass rewrites it, and a draft whose proposal is gone is pruned
    const again = consolidate(h.store.db, h.scope, h.store.fts5, { dryRun: false })
    assert.ok(again.skillDrafts.length >= 1)
    assert.ok(fs.existsSync(path.join(proposals, 'stable-lesson.SKILL.md')))
    fs.writeFileSync(path.join(proposals, 'stale.SKILL.md'), 'old')
    consolidate(h.store.db, h.scope, h.store.fts5, { dryRun: false })
    assert.equal(
        fs.existsSync(path.join(proposals, 'stale.SKILL.md')),
        false,
        'drafts without an open proposal are pruned',
    )
})
