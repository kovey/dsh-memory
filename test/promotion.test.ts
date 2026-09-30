/**
 * Promotion of `pending` records by *use* (the missing half of DESIGN §7).
 *
 * Model-distilled candidates enter pending so unreviewed output is never treated
 * as fact — but with no way out the live store drifted to 55 pending of 94
 * records. Being recalled into turns that end well is the evidence that promotes.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { consolidate, promoteByUse } from '../dist/learn/consolidate.js'
import { countRecords, getRecord, listRecords, materialize, upsertRecord } from '../dist/store/sqlite/records.js'
import fs from 'node:fs'
import path from 'node:path'
import { resolveConfig } from '../dist/config.js'
import { clearRepoCache } from '../dist/paths.js'
import { ScopeResolver } from '../dist/scope/resolver.js'
import { loadSqliteModule } from '../dist/store/sqlite/db.js'
import { StoreRegistry } from '../dist/store/store.js'
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
