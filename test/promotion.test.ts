/**
 * Promotion of `pending` records by *use* (the missing half of DESIGN §7).
 *
 * Model-distilled candidates enter pending so unreviewed output is never treated
 * as fact — but with no way out the live store drifted to 55 pending of 94
 * records. Being recalled into turns that end well is the evidence that promotes.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { consolidate, promoteByUse, renderReport } from '../dist/learn/consolidate.js'
import { countRecords, getRecord, listRecords, materialize, upsertRecord } from '../dist/store/sqlite/records.js'
import fs from 'node:fs'
import path from 'node:path'
import { resolveConfig } from '../dist/config.js'
import { clearRepoCache } from '../dist/paths.js'
import { ScopeResolver } from '../dist/scope/resolver.js'
import { loadSqliteModule } from '../dist/store/sqlite/db.js'
import { StoreRegistry } from '../dist/store/store.js'
import { consolidateTool } from '../dist/tools/consolidate.js'
import { fakeRepo, lessonDoc, memoryFixture, useGlobalMemoryHome } from './helpers.ts'

/** Local harness: one project store seeded with a single lesson. */
async function harness(t: { skip: (reason: string) => void }) {
    clearRepoCache()
    const repo = fakeRepo('promotion-repo')
    useGlobalMemoryHome(memoryFixture('promotion-global', {}).root)
    const lessons = path.join(repo, '.dsh', 'memory', 'lessons')
    fs.mkdirSync(lessons, { recursive: true })
    fs.writeFileSync(
        path.join(lessons, 'seed-lesson.md'),
        lessonDoc({ title: 'seed lesson', body: '触发场景：x。正确做法：y。', confidence: 0.9 }),
    )
    const config = resolveConfig({})
    const registry = new StoreRegistry(config)
    const report = await registry.initialize(loadSqliteModule)
    if (!registry.available) {
        t.skip(`node:sqlite unavailable: ${report.probe.reason ?? 'unknown'}`)
        throw new Error('unreachable')
    }
    const resolver = new ScopeResolver(config)
    const agent = { session: { id: 'promotion', header: { cwd: repo } } }
    const scope = resolver.resolve({ agent })
    return { repo, config, registry, resolver, agent, scope }
}

test('a pending record that keeps being recalled into good turns is promoted', async (t) => {
    const h = await harness(t)
    const store = h.registry.open(h.resolver.resolve({ agent: h.agent }))
    assert.ok(store)
    const at = new Date().toISOString()
    const insert = (id: string, recalled: number, success: number, fail: number, status = 'pending') =>
        upsertRecord(store.db, {
            ...materialize({
                title: `candidate ${id}`,
                body: `触发场景：${id}。正确做法：按 ${id} 处理。`,
                layer: 'project',
                scopeKind: 'project',
                repo: h.repo,
                confidence: 0.7,
            }),
            id,
            status: status as 'pending',
            timesRecalled: recalled,
            successAfterRecall: success,
            failAfterRecall: fail,
            updatedAt: at,
        })

    insert('used-well', 3, 3, 0)
    insert('never-used', 0, 0, 0)
    insert('used-badly', 4, 1, 3)
    insert('barely-used', 2, 2, 0)
    insert('already-active', 5, 5, 0, 'active')

    const promoted = promoteByUse(store.db, { minRecalls: 3, minSuccessRatio: 0.5 })
    assert.deepEqual(promoted.map((record) => record.id), ['used-well'])
    assert.equal(getRecord(store.db, 'used-well')?.status, 'active')
    assert.equal(getRecord(store.db, 'never-used')?.status, 'pending', 'existence is not evidence')
    assert.equal(getRecord(store.db, 'used-badly')?.status, 'pending', 'a mostly-failing memory stays a candidate')
    assert.equal(getRecord(store.db, 'barely-used')?.status, 'pending', 'one recall short')
    assert.equal(getRecord(store.db, 'already-active')?.status, 'active')

    // idempotent: a second pass has nothing left to promote
    assert.deepEqual(promoteByUse(store.db, { minRecalls: 3, minSuccessRatio: 0.5 }), [])
})

test('consolidation performs the promotion and reports it', async (t) => {
    const h = await harness(t)
    const store = h.registry.open(h.resolver.resolve({ agent: h.agent }))
    assert.ok(store)
    upsertRecord(store.db, {
        ...materialize({
            title: 'proven candidate',
            body: '触发场景：x。正确做法：y。',
            layer: 'project',
            scopeKind: 'project',
            repo: h.repo,
            confidence: 0.7,
        }),
        id: 'proven-candidate',
        status: 'pending' as const,
        timesRecalled: 5,
        successAfterRecall: 4,
        failAfterRecall: 1,
    })

    const dry = consolidate(store.db, store.scope, store.fts5, { dryRun: true })
    assert.deepEqual(dry.promotedByUse, [], 'a dry run reports nothing as done')
    assert.equal(getRecord(store.db, 'proven-candidate')?.status, 'pending', 'and changes nothing')

    const report = consolidate(store.db, store.scope, store.fts5, { dryRun: false })
    assert.deepEqual(report.promotedByUse, ['proven-candidate'])
    assert.equal(getRecord(store.db, 'proven-candidate')?.status, 'active')
    assert.equal(countRecords(store.db).pending, 0)
    // the promoted record is a first-class memory now: it survives the export pass
    assert.equal(listRecords(store.db, { status: ['active'] }).some((r) => r.id === 'proven-candidate'), true)
})

// ---- the configured thresholds must reach the real call path ------------------

/** A candidate that clears the *default* floors (3 recalls, ratio 0.5). */
function seedProvenCandidate(
    store: { db: Parameters<typeof upsertRecord>[0] },
    repo: string,
    overrides: Partial<{ timesRecalled: number; successAfterRecall: number; failAfterRecall: number }> = {},
): void {
    upsertRecord(store.db, {
        ...materialize({
            title: 'proven candidate',
            body: '触发场景：x。正确做法：y。',
            layer: 'project',
            scopeKind: 'project',
            repo,
            confidence: 0.7,
        }),
        id: 'proven-candidate',
        status: 'pending' as const,
        timesRecalled: overrides.timesRecalled ?? 5,
        successAfterRecall: overrides.successAfterRecall ?? 4,
        failAfterRecall: overrides.failAfterRecall ?? 1,
    })
}

test('learn.promoteAfterRecalls / promoteMinSuccessRatio actually reach the promotion call', async (t) => {
    // Both call sites used to omit the two options, so the hard-coded defaults in
    // `promoteByUse` won forever: setting the knobs to 99 / 0.99 promoted anyway.
    const h = await harness(t)
    const store = h.registry.open(h.resolver.resolve({ agent: h.agent }))
    assert.ok(store)
    seedProvenCandidate(store, h.repo)

    const strictConfig = resolveConfig({ learn: { promoteAfterRecalls: 99, promoteMinSuccessRatio: 0.99 } })
    const tool = consolidateTool({
        config: strictConfig,
        registry: h.registry,
        resolver: new ScopeResolver(strictConfig),
    })
    const output = String(await tool.execute({ dryRun: false } as never, { agent: h.agent } as never))
    assert.equal(getRecord(store.db, 'proven-candidate')?.status, 'pending', 'the configured floor is what the pass uses')
    assert.doesNotMatch(output, /promoted by use/)

    // ...and the same record is promoted once the configured floor is met, so the
    // test cannot pass by simply never promoting anything.
    const generous = resolveConfig({ learn: { promoteAfterRecalls: 3, promoteMinSuccessRatio: 0.5 } })
    const generousTool = consolidateTool({
        config: generous,
        registry: h.registry,
        resolver: new ScopeResolver(generous),
    })
    const promoted = String(await generousTool.execute({ dryRun: false } as never, { agent: h.agent } as never))
    assert.equal(getRecord(store.db, 'proven-candidate')?.status, 'active')
    assert.match(promoted, /promoted by use/)
})

test('the consolidation report renders promotedByUse (DESIGN §14 promise)', async (t) => {
    const h = await harness(t)
    const store = h.registry.open(h.resolver.resolve({ agent: h.agent }))
    assert.ok(store)
    seedProvenCandidate(store, h.repo)

    const dry = renderReport(consolidate(store.db, store.scope, store.fts5, { dryRun: true }))
    assert.doesNotMatch(dry, /promoted by use/, 'a dry run promoted nothing, so there is no line')

    const applied = consolidate(store.db, store.scope, store.fts5, { dryRun: false })
    assert.deepEqual(applied.promotedByUse, ['proven-candidate'])
    const rendered = renderReport(applied)
    assert.match(rendered, /promoted by use: 1/, 'the report must show a count')
    assert.match(rendered, /proven-candidate/, 'and which records moved')
})

test('negative counters in a hand-written lesson cannot promote a record', async (t) => {
    // `success_after_recall: -5` (a hand-edited or corrupt frontmatter) made the
    // ratio -5 / -5 = 1, i.e. a perfect candidate. Counters are counts: a
    // negative value is normalized to 0 and then fails the `success > 0` rule.
    const h = await harness(t)
    const store = h.registry.open(h.resolver.resolve({ agent: h.agent }))
    assert.ok(store)
    seedProvenCandidate(store, h.repo, { timesRecalled: 5, successAfterRecall: -5, failAfterRecall: 0 })

    assert.deepEqual(promoteByUse(store.db, { minRecalls: 3, minSuccessRatio: 0.5 }), [])
    assert.equal(getRecord(store.db, 'proven-candidate')?.status, 'pending')

    // a real count on the same record still promotes it
    upsertRecord(store.db, { ...getRecord(store.db, 'proven-candidate')!, successAfterRecall: 3, failAfterRecall: 1 })
    assert.deepEqual(promoteByUse(store.db, { minRecalls: 3, minSuccessRatio: 0.5 }).map((record) => record.id), [
        'proven-candidate',
    ])
})
