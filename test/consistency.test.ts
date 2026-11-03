/**
 * Text-view consistency (DESIGN §5.3.1).
 *
 * The database is what writes land in; the git-tracked text view is its
 * synchronous export. When an export fails the store is ahead, and a rebuild —
 * which reads the text view as the recovery source — would delete records that
 * never reached disk. These tests pin the three pieces that make that window
 * visible and non-destructive: the export watermark, the `memory_stats`
 * warning, and the rebuild guard (with its `force` escape hatch).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../dist/config.js'
import { clearRepoCache } from '../dist/paths.js'
import { ScopeResolver } from '../dist/scope/resolver.js'
import { loadSqliteModule } from '../dist/store/sqlite/db.js'
import { getRecord, materialize, upsertRecord } from '../dist/store/sqlite/records.js'
import { StoreRegistry } from '../dist/store/store.js'
import { exportAll } from '../dist/store/export.js'
import { rebuildScope } from '../dist/store/rebuild.js'
import { exportLag, readWatermark } from '../dist/store/watermark.js'
import { statsTool } from '../dist/tools/stats.js'
import type { MemoryScope } from '../dist/store/types.js'
import { fakeRepo, lessonDoc, memoryFixture, useGlobalMemoryHome } from './helpers.ts'

interface Harness {
    repo: string
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
    lessons: Record<string, string> = {},
): Promise<Harness> {
    clearRepoCache()
    const repo = fakeRepo(label)
    const globalHome = memoryFixture(`${label}-global`, {})
    useGlobalMemoryHome(globalHome.root)
    const lessonsDir = path.join(repo, '.dsh', 'memory', 'lessons')
    fs.mkdirSync(lessonsDir, { recursive: true })
    for (const [name, body] of Object.entries(lessons)) fs.writeFileSync(path.join(lessonsDir, name), body)

    const resolved = resolveConfig({})
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
    assert.ok(store, 'store must open')
    return { repo, resolved, registry, resolver, agent, scope, store }
}

/** A record inserted straight into the database — no export follows. */
function insert(db: Parameters<typeof upsertRecord>[0], scope: MemoryScope, title: string, updatedAt: string): string {
    const base = materialize(
        {
            title,
            body: '触发场景：写库之后导出失败。正确做法：先导出再重建。',
            layer: 'project',
            scopeKind: 'project',
            repo: scope.repo,
            confidence: 0.9,
        },
        updatedAt,
    )
    upsertRecord(db, base)
    return base.id
}

async function statsOutput(h: Harness): Promise<string> {
    const tool = statsTool({ config: h.resolved, registry: h.registry, resolver: h.resolver })
    return String(await tool.execute({} as never, { agent: h.agent } as never))
}

test('a bootstrap from the text view seeds the watermark: nothing is reported as lagging', async (t) => {
    const h = await harness(t, 'consistency-bootstrap', {
        'seeded.md': lessonDoc({ title: 'seeded lesson', body: '触发场景：克隆之后首次打开。正确做法：bootstrap 导入即一致。' }),
    })
    const watermark = readWatermark(h.store.db)
    assert.ok(watermark, 'a database filled from disk is in sync by construction and must be marked')
    assert.equal(watermark.records, 1)
    assert.equal(exportLag(h.store.db).kind, 'fresh')
    assert.match(await statsOutput(h), /text view: up to date/)
})

test('a record written after the last export is reported and survives a rebuild', async (t) => {
    const h = await harness(t, 'consistency-lagging', {
        'seeded.md': lessonDoc({ title: 'seeded lesson', body: '触发场景：克隆之后首次打开。正确做法：bootstrap 导入即一致。' }),
    })
    // Far future: whatever the wall clock says, this write is newer than the mark.
    const id = insert(h.store.db, h.scope, 'never exported lesson', '2099-01-01T00:00:00.000Z')

    const lag = exportLag(h.store.db)
    assert.equal(lag.kind, 'lagging')
    assert.match(await statsOutput(h), /text view may lag: \d+ record\(s\) written after the last successful export/)

    const rebuilt = rebuildScope(h.store.db, h.scope, h.store.fts5)
    assert.equal(rebuilt.removed, 0, 'a record the text view cannot restore must not be deleted')
    assert.deepEqual(rebuilt.keptUnexported, [id])
    assert.ok(getRecord(h.store.db, id), 'the unexported record is still there')
    // The mark cannot have advanced: the gap is still real.
    assert.equal(exportLag(h.store.db).kind, 'lagging')
})

test('force deletes the unexported record', async (t) => {
    const h = await harness(t, 'consistency-force', {
        'seeded.md': lessonDoc({ title: 'seeded lesson', body: '触发场景：克隆之后首次打开。正确做法：bootstrap 导入即一致。' }),
    })
    const id = insert(h.store.db, h.scope, 'never exported lesson', '2099-01-01T00:00:00.000Z')

    const rebuilt = rebuildScope(h.store.db, h.scope, h.store.fts5, { force: true })
    assert.equal(rebuilt.removed, 1)
    assert.deepEqual(rebuilt.keptUnexported, [])
    assert.equal(getRecord(h.store.db, id), undefined)
})

test('a record older than the watermark is still pruned: the guard is narrow', async (t) => {
    const h = await harness(t, 'consistency-prune', {})
    const id = insert(h.store.db, h.scope, 'manually deleted lesson', '2020-01-01T00:00:00.000Z')
    const exported = exportAll(h.store.db, h.scope)
    assert.deepEqual(exported.errors, [])
    assert.equal(exportLag(h.store.db).kind, 'fresh')

    // A human deleted the file; the database row predates the export, so it is
    // not part of an unexported window and pruning it is correct.
    fs.rmSync(path.join(h.scope.root, 'lessons', `${id}.md`))
    const rebuilt = rebuildScope(h.store.db, h.scope, h.store.fts5)
    assert.equal(rebuilt.removed, 1)
    assert.deepEqual(rebuilt.keptUnexported, [])
    assert.equal(getRecord(h.store.db, id), undefined)
})
