/**
 * Pinned records (DESIGN §6, §8; schema v6).
 *
 * A pin is the one lifecycle flag a human sets: the record stops decaying,
 * never archives itself, and keeps a freshness floor when ranking. It must also
 * survive the text view (a rebuild from git files has to restore it) and stay
 * rare — the per-layer cap is what keeps "pin everything" from switching the
 * quality workflow off.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../dist/config.js'
import { applyDecay, planDecay } from '../dist/learn/decay.js'
import { clearRepoCache } from '../dist/paths.js'
import { PINNED_FRESHNESS_FLOOR, scoreRecord } from '../dist/recall/rank.js'
import { ScopeResolver } from '../dist/scope/resolver.js'
import { exportAll } from '../dist/store/export.js'
import { rebuildScope } from '../dist/store/rebuild.js'
import { CORE_TABLES_SQL } from '../dist/store/sqlite/schema.js'
import { getMeta, loadSqliteModule, openDatabase, setMeta } from '../dist/store/sqlite/db.js'
import { getRecord, materialize, upsertRecord } from '../dist/store/sqlite/records.js'
import { StoreRegistry } from '../dist/store/store.js'
import type { MemoryScope } from '../dist/store/types.js'
import { MAX_PINNED_PER_LAYER, saveTool } from '../dist/tools/save.js'
import { statsTool } from '../dist/tools/stats.js'
import { tempDir, fakeRepo, memoryFixture, useGlobalMemoryHome } from './helpers.ts'

interface Harness {
    resolved: ReturnType<typeof resolveConfig>
    registry: StoreRegistry
    resolver: ScopeResolver
    agent: { session: { id: string; header: { cwd: string } } }
    scope: MemoryScope
    store: NonNullable<ReturnType<StoreRegistry['open']>>
}

async function harness(t: { skip: (reason: string) => void }, label: string): Promise<Harness> {
    clearRepoCache()
    const repo = fakeRepo(label)
    const globalHome = memoryFixture(`${label}-global`, {})
    useGlobalMemoryHome(globalHome.root)
    fs.mkdirSync(path.join(repo, '.dsh', 'memory', 'lessons'), { recursive: true })
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
    assert.ok(store)
    return { resolved, registry, resolver, agent, scope, store }
}

function addRecord(h: Harness, title: string, options: { pinned?: boolean; updatedAt?: string; layer?: 'project' | 'global'; confidence?: number } = {}): string {
    const record = materialize(
        {
            title,
            body: '触发场景：手工钉住的教训。正确做法：保留它，别让它被衰减掉。',
            layer: options.layer ?? 'project',
            scopeKind: options.layer === 'global' ? 'global' : 'project',
            repo: options.layer === 'global' ? undefined : h.scope.repo,
            confidence: options.confidence ?? 0.5,
            ...(options.pinned === true ? { pinned: true } : {}),
        },
        options.updatedAt ?? new Date().toISOString(),
    )
    upsertRecord(h.store.db, record)
    return record.id
}

test('schema v5 databases gain the pinned column without losing rows', async (t) => {
    const mod = await loadSqliteModule()
    if (mod === undefined) {
        t.skip('node:sqlite unavailable')
        return
    }
    const file = path.join(tempDir('pinned-migrate'), 'memory.db')
    const db = new mod.DatabaseSync(file)
    db.exec(CORE_TABLES_SQL)
    db.exec(
        `INSERT INTO records (id, layer, scope_kind, title, body, tags, confidence, status, created_at, updated_at, cjk)
         VALUES ('old-row', 'project', 'project', 'old row', 'body', '[]', 0.8, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '')`,
    )
    db.exec('ALTER TABLE records DROP COLUMN pinned')
    setMeta(db, 'schema_version', '5')
    db.close()

    const reopened = openDatabase(mod, { file, journalMode: 'wal', busyTimeoutMs: 1_000, fts5: true })
    assert.equal(getMeta(reopened, 'schema_version'), '6')
    const row = reopened.prepare("SELECT pinned FROM records WHERE id = 'old-row'").get()
    assert.equal(row?.['pinned'], 0, 'existing rows default to unpinned')
    reopened.close()
})

test('pinning a record gives it a freshness floor, not a free pass', async (t) => {
    const h = await harness(t, 'pinned-rank')
    const old = '2024-01-01T00:00:00.000Z'
    const plain = materialize({ title: 'old plain', body: 'x', layer: 'project', scopeKind: 'project' }, old)
    const pinned = materialize({ title: 'old pinned', body: 'x', layer: 'project', scopeKind: 'project', pinned: true }, old)
    const now = new Date('2026-06-01T00:00:00.000Z')
    const relevance = new Map([
        [plain.id, 1],
        [pinned.id, 1],
    ])
    const a = scoreRecord(plain, { relevance, now })
    const b = scoreRecord(pinned, { relevance, now })
    assert.equal(a.components.freshness, 0.2, 'an unpinned record keeps decaying to the floor')
    assert.equal(b.components.freshness, PINNED_FRESHNESS_FLOOR)
    assert.ok(b.score > a.score)
    // …but the pin does not opt out of the threshold gate or the budget.
    assert.ok(scoreRecord(pinned, { relevance: new Map([[pinned.id, 0.1]]), now }).score < b.score)
    assert.ok(h.store)
})

test('a pinned record is exempt from decay and archival, and the pin survives a rebuild', async (t) => {
    const h = await harness(t, 'pinned-decay')
    const pinnedId = addRecord(h, 'pinned old lesson', { pinned: true, updatedAt: '2025-01-01T00:00:00.000Z' })
    // Same shape as the pinned one, but unpinned: stale pending records are archived.
    const staleId = addRecord(h, 'plain old lesson', { updatedAt: '2025-01-01T00:00:00.000Z' })
    // A fresh unpinned record only decays (it is not stale enough to archive).
    const freshId = addRecord(h, 'plain fresh lesson', { confidence: 0.8 })
    // 60 days since the last run: decay is due, and stale pending records qualify.
    setMeta(h.store.db, 'last_decay_at', new Date(Date.now() - 60 * 86_400_000).toISOString())

    const plan = planDecay(h.store.db)
    assert.ok(plan.factor < 1)
    assert.ok(!plan.archive.some((item) => item.record.id === pinnedId), 'a pinned record must never be archived automatically')
    assert.ok(plan.archive.some((item) => item.record.id === staleId), 'an unpinned stale record is still archived')

    applyDecay(h.store.db, plan)
    assert.equal(getRecord(h.store.db, pinnedId)?.confidence, 0.5, 'pinned confidence is untouched')
    assert.equal(getRecord(h.store.db, pinnedId)?.status, 'pending', 'a pinned record keeps its status too')
    assert.ok((getRecord(h.store.db, freshId)?.confidence ?? 1) < 0.8, 'unpinned records still decay')

    exportAll(h.store.db, h.scope)
    const file = path.join(h.scope.root, 'lessons', `${pinnedId}.md`)
    assert.match(fs.readFileSync(file, 'utf8'), /^pinned: true$/m)
    const rebuilt = rebuildScope(h.store.db, h.scope, h.store.fts5, { force: true })
    assert.ok(rebuilt.errors.length === 0)
    assert.equal(getRecord(h.store.db, pinnedId)?.pinned, true, 'a rebuild from the text view restores the pin')
})

test('memory_save pins and unpins, and refuses past the per-layer cap', async (t) => {
    const h = await harness(t, 'pinned-save')
    const tool = saveTool({ config: h.resolved, registry: h.registry, resolver: h.resolver })
    const drafted = String(
        await tool.execute(
            { title: 'curated lesson', body: '触发场景：需要长期保留。正确做法：pin 住。', confidence: 0.9, pin: true } as never,
            { agent: h.agent } as never,
        ),
    )
    assert.match(drafted, /pinned: true/)
    const record = getRecord(h.store.db, 'curated-lesson')
    assert.equal(record?.pinned, true, 'the saved record is pinned')

    const stats = String(
        await statsTool({ config: h.resolved, registry: h.registry, resolver: h.resolver }).execute(
            {} as never,
            { agent: h.agent } as never,
        ),
    )
    assert.match(stats, /pinned 1/)

    const unpinned = String(
        await tool.execute(
            { title: 'curated lesson', body: '触发场景：需要长期保留。正确做法：pin 住。', pin: false } as never,
            { agent: h.agent } as never,
        ),
    )
    assert.match(unpinned, /pinned: false/)
    assert.equal(getRecord(h.store.db, 'curated-lesson')?.pinned, false)
    assert.doesNotMatch(
        fs.readFileSync(path.join(h.scope.root, 'lessons', 'curated-lesson.md'), 'utf8'),
        /^pinned:/m,
    )

    // Fill the layer to the cap, then try one more.
    for (let index = 0; index < MAX_PINNED_PER_LAYER; index += 1) {
        addRecord(h, `capacity lesson ${index}`, { pinned: true })
    }
    const refused = String(
        await tool.execute(
            { title: 'one too many', body: '触发场景：超额。正确做法：先 unpin。', confidence: 0.9, pin: true } as never,
            { agent: h.agent } as never,
        ),
    )
    assert.match(refused, new RegExp(`refused: project already has ${MAX_PINNED_PER_LAYER} pinned record`))
    assert.match(refused, /the record itself was saved: one-too-many/)
    assert.equal(getRecord(h.store.db, 'one-too-many')?.pinned, false, 'the write still lands, unpinned')
})
