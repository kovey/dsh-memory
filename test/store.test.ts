/**
 * Store tests: bootstrap import from the git-tracked text view, ranked search,
 * export round trip and the project/global isolation guards (DESIGN §5).
 *
 * Everything runs inside `.tmp-tests/`; the real `~/.dsh/memory` is never
 * touched, and the global root is redirected through `$DSH_MEMORY_HOME`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { clearRepoCache } from '../lib/paths.js'
import { ScopeResolver } from '../lib/scope/resolver.js'
import { exportAll, exportIndex } from '../lib/store/export.js'
import { assertRecordScope, ScopeViolationError } from '../lib/store/guard.js'
import { parseLesson } from '../lib/store/frontmatter.js'
import { countRecords, extractTerms, getRecord, materialize, rawSearch } from '../lib/store/sqlite/records.js'
import { loadSqliteModule } from '../lib/store/sqlite/db.js'
import { StoreRegistry } from '../lib/store/store.js'
import type { MemoryScope } from '../lib/store/types.js'
import { fakeRepo, lessonDoc, memoryFixture, useGlobalMemoryHome } from './helpers.ts'

interface Fixture2 {
    store: ReturnType<StoreRegistry['open']>
    registry: StoreRegistry
    scope: MemoryScope
    repo: string
}

async function openProjectStore(t: { skip: (reason: string) => void }, label: string, lessons: Record<string, string>): Promise<Fixture2> {
    clearRepoCache()
    const repo = fakeRepo(label)
    const globalHome = memoryFixture(`${label}-global`, {})
    useGlobalMemoryHome(globalHome.root)
    const lessonsDir = path.join(repo, '.dsh', 'memory', 'lessons')
    fs.mkdirSync(lessonsDir, { recursive: true })
    for (const [name, body] of Object.entries(lessons)) fs.writeFileSync(path.join(lessonsDir, name), body)

    const config = resolveConfig({})
    const registry = new StoreRegistry(config)
    const report = await registry.initialize(loadSqliteModule)
    if (!registry.available) {
        t.skip(`node:sqlite unavailable: ${report.probe.reason ?? 'unknown'}`)
        throw new Error('unreachable')
    }
    const scope = new ScopeResolver(config).resolve({ cwd: repo })
    const store = registry.open(scope)
    assert.ok(store, 'store must open')
    return { store, registry, scope, repo }
}

test('bootstraps the database from lessons already on disk', async (t) => {
    const { store, scope } = await openProjectStore(t, 'store-bootstrap', {
        'shell.md': lessonDoc({ title: 'shell background trap', body: 'Use redirection to a file.', confidence: 0.95 }),
        'jsonl.md': lessonDoc({ title: 'JSONL audit lines must be compact', body: 'One line per record.', confidence: 0.9 }),
        'zh-702048f517.md': lessonDoc({ title: '中文教训条目', body: '中文正文，含标点。', confidence: 0.85, timesSeen: 2 }),
    })
    assert.ok(store)
    const counts = countRecords(store.db)
    assert.equal(counts.total, 3)
    assert.equal(counts.active, 3)
    assert.equal(scope.root, `${scope.repo}/.dsh/memory`)

    const record = getRecord(store.db, 'zh-702048f517')
    assert.ok(record)
    assert.equal(record.title, '中文教训条目')
    assert.equal(record.timesSeen, 2)
    assert.equal(record.body, '中文正文，含标点。')
    assert.equal(record.origin, 'imported')
})

test('bootstrap import never overwrites an existing database', async (t) => {
    const { store, registry, scope } = await openProjectStore(t, 'store-idempotent', {
        'a.md': lessonDoc({ title: 'first lesson', body: 'body' }),
    })
    assert.ok(store)
    const imported = registry.reimport(scope)
    assert.equal(imported, 1)
    assert.equal(countRecords(store.db).total, 1)
})

test('ranked search finds CJK and ASCII lessons, and records round-trip', async (t) => {
    const { store } = await openProjectStore(t, 'store-search', {
        'stdio-inherit-breaks-pipelines.md': lessonDoc({
            title: 'stdio inherit breaks pipelines',
            body: 'Always redirect to a file before reading.',
        }),
        'zh-702048f517.md': lessonDoc({ title: '沙箱拒写全局目录', body: '写 ~/.dsh 被沙箱拒绝时降级到项目本地。' }),
    })
    assert.ok(store)

    const ascii = rawSearch(store.db, extractTerms('pipeline redirect file'), store.fts5)
    assert.equal(ascii.length, 1)
    assert.equal(ascii[0]?.id, 'stdio-inherit-breaks-pipelines')

    const cjk = rawSearch(store.db, extractTerms('沙箱'), store.fts5)
    assert.equal(cjk.length, 1)

    const miss = rawSearch(store.db, extractTerms('kubernetes helm chart'), store.fts5)
    assert.equal(miss.length, 0)
})

test('finds CJK text in the middle of a run (bigram index)', async (t) => {
    const { store } = await openProjectStore(t, 'store-cjk-midrun', {
        'dsh-sandbox.md': lessonDoc({
            title: '写入可能被沙箱拒绝',
            body: '写入可能被文件沙箱拒绝且无审批时，状态登记备项目本地回退。',
        }),
    })
    assert.ok(store)

    // Regression guard: with plain unicode61 the whole run 写入可能被沙箱拒绝 is a
    // single token and a query for 沙箱 would return nothing.
    assert.equal(rawSearch(store.db, extractTerms('沙箱'), store.fts5).length, 1)
    assert.equal(rawSearch(store.db, extractTerms('沙箱拒绝'), store.fts5).length, 1)
    assert.equal(rawSearch(store.db, extractTerms('文件沙箱'), store.fts5).length, 1)
    assert.equal(rawSearch(store.db, extractTerms('完全无关的词'), store.fts5).length, 0)
})

test('exports back to the text view preserving legacy frontmatter', async (t) => {
    const original = lessonDoc({ title: 'round trip lesson', body: 'line one\nline two', confidence: 0.8, timesSeen: 4 })
    const { store, scope } = await openProjectStore(t, 'store-export', { 'round-trip-lesson.md': original })
    assert.ok(store)

    const result = exportAll(store.db, scope)
    assert.deepEqual(result.errors, [])
    assert.equal(result.written, 1)

    const exported = fs.readFileSync(path.join(scope.root, 'lessons', 'round-trip-lesson.md'), 'utf8')
    const before = parseLesson(original)
    const after = parseLesson(exported)
    assert.ok(before && after)
    assert.equal(after.frontmatter.title, before.frontmatter.title)
    assert.equal(after.frontmatter.confidence, before.frontmatter.confidence)
    assert.equal(after.frontmatter.expires, before.frontmatter.expires)
    assert.equal(after.frontmatter.timesSeen, before.frontmatter.timesSeen)
    assert.equal(after.body, before.body)

    assert.ok(fs.existsSync(path.join(scope.root, 'MEMORY.md')))
})

test('export prunes lesson files whose records are gone', async (t) => {
    const { store, scope } = await openProjectStore(t, 'store-prune', {
        'kept.md': lessonDoc({ title: 'kept', body: 'body' }),
    })
    assert.ok(store)
    fs.writeFileSync(path.join(scope.root, 'lessons', 'stale.md'), lessonDoc({ title: 'stale', body: 'body' }))
    const result = exportAll(store.db, scope)
    assert.equal(result.removed, 1)
    assert.equal(fs.existsSync(path.join(scope.root, 'lessons', 'stale.md')), false)
})

test('the index export lists active records with metadata', async (t) => {
    const { store, scope } = await openProjectStore(t, 'store-index', {
        'alpha-lesson.md': lessonDoc({ title: 'alpha lesson', body: 'body', confidence: 0.66 }),
    })
    assert.ok(store)
    const file = exportIndex(store.db, scope)
    const text = fs.readFileSync(file, 'utf8')
    assert.match(text, /alpha lesson/)
    assert.match(text, /0\.66/)
    assert.match(text, /lessons\/alpha-lesson\.md/)
})

test('refuses to persist a project record into the global scope', () => {
    const repo = fakeRepo('guard-project')
    const globalRoot = memoryFixture('guard-global', {}).root
    useGlobalMemoryHome(globalRoot)
    const projectScope: MemoryScope = { kind: 'project', repo, root: `${repo}/.dsh/memory`, reason: 'session-cwd' }
    const globalScope: MemoryScope = { kind: 'global', root: globalRoot, reason: 'no-project-context' }

    const record = materialize({
        title: 'project only',
        body: 'body',
        layer: 'project',
        scopeKind: 'project',
        repo,
    })

    assert.doesNotThrow(() => assertRecordScope(record, projectScope, globalRoot))
    assert.throws(() => assertRecordScope(record, globalScope, globalRoot), ScopeViolationError)
})

test('refuses a global record written into a project root', () => {
    const repo = fakeRepo('guard-global-record')
    const globalRoot = memoryFixture('guard-global-record-home', {}).root
    useGlobalMemoryHome(globalRoot)
    const projectScope: MemoryScope = { kind: 'project', repo, root: `${repo}/.dsh/memory`, reason: 'session-cwd' }
    const record = materialize({ title: 'global only', body: 'body', layer: 'global', scopeKind: 'global' })
    assert.throws(() => assertRecordScope(record, projectScope, globalRoot), ScopeViolationError)
})
