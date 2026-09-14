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
import { clearRepoCache, projectMemoryRoot } from '../lib/paths.js'
import { ScopeResolver } from '../lib/scope/resolver.js'
import { exportAll, exportIndex } from '../lib/store/export.js'
import { countEvidence, parseLesson } from '../lib/store/frontmatter.js'
import { equivalentIds, normalizeDashes, assertRecordScope, ScopeViolationError } from '../lib/store/guard.js'
import { importLessons } from '../lib/store/import.js'
import { appendMetric } from '../lib/store/metrics.js'
import { rebuildScope } from '../lib/store/rebuild.js'
import { countRecords, extractTerms, getRecord, materialize, rawSearch, upsertRecord } from '../lib/store/sqlite/records.js'
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

test('export adopts un-imported lesson files and never deletes by default', async (t) => {
    // Regression guards from an audit: the old export pruned every `.md` the
    // store did not know, which deleted files written by memory-lesson.sh (the
    // designed fallback path) and, in a repo whose .gitignore covers `.dsh/`,
    // did so unrecoverably.
    const { store, scope } = await openProjectStore(t, 'store-adopt', {
        'kept.md': lessonDoc({ title: 'kept', body: 'body' }),
    })
    assert.ok(store)
    const scripted = path.join(scope.root, 'lessons', 'scripted-lesson.md')
    fs.writeFileSync(scripted, lessonDoc({ title: 'scripted lesson', body: '触发场景：x。正确做法：y。' }))
    const notes = path.join(scope.root, 'lessons', 'notes.md')
    fs.writeFileSync(notes, 'just notes, not a lesson\n')

    const result = exportAll(store.db, scope)
    assert.equal(result.removed, 0, 'a default export deletes nothing')
    assert.equal(fs.existsSync(scripted), true)
    assert.equal(fs.existsSync(notes), true)
    assert.ok(getRecord(store.db, 'scripted-lesson'), 'the scripted lesson is adopted into the store')

    // An explicit rebuild may prune lesson files the store still does not own —
    // and only files that are recognizable lessons: notes are not ours to delete.
    const orphan = path.join(scope.root, 'lessons', 'orphan-lesson.md')
    fs.writeFileSync(orphan, lessonDoc({ title: 'orphan lesson', body: '触发场景：x。正确做法：y。' }))
    const pruned = exportAll(store.db, scope, { prune: true, adopt: false })
    assert.equal(pruned.removed, 1, 'the unowned lesson file is removed')
    assert.equal(fs.existsSync(orphan), false)
    assert.equal(fs.existsSync(notes), true, 'a file that is not a lesson is never deleted')
    assert.equal(fs.existsSync(scripted), true, 'an adopted lesson is owned now and stays')
})

test('a failed write never costs the record its existing file', async (t) => {
    const { store, scope } = await openProjectStore(t, 'store-fail', {
        'kept.md': lessonDoc({ title: 'kept', body: 'body' }),
    })
    assert.ok(store)
    exportAll(store.db, scope, { prune: true })
    const good = path.join(scope.root, 'lessons', 'kept.md')
    const before = fs.readFileSync(good, 'utf8')
    // make the atomic temp path a directory so the write fails
    const blocker = path.join(scope.root, 'lessons', `.kept.md.${process.pid}.tmp`)
    fs.mkdirSync(blocker)
    try {
        const result = exportAll(store.db, scope, { prune: true })
        assert.ok(result.errors.some((error) => error.includes('kept')), 'the failure is reported')
        assert.equal(fs.existsSync(good), true, 'the previous good file survives a failed rewrite')
        assert.equal(fs.readFileSync(good, 'utf8'), before)
    } finally {
        fs.rmSync(blocker, { recursive: true, force: true })
    }
})

test('rebuild keeps archived records and their files', async (t) => {
    // The archive directory was not scanned, so archived records looked like
    // records whose file vanished: rebuild dropped them and the next export
    // deleted the archive file — "archive, never delete" became a delayed delete.
    const { store, scope } = await openProjectStore(t, 'store-archive-rebuild', {
        'keeper.md': lessonDoc({ title: 'keeper', body: '触发场景：x。正确做法：y。' }),
        'archived-one.md': lessonDoc({ title: 'archived one', body: '触发场景：x。正确做法：y。' }),
    })
    assert.ok(store)
    store.db.prepare('UPDATE records SET status = ? WHERE id = ?').run('archived', 'archived-one')
    exportAll(store.db, scope, { prune: true })
    assert.equal(fs.existsSync(path.join(scope.root, 'archive', 'lessons', 'archived-one.md')), true)

    const rebuilt = rebuildScope(store.db, scope, true)
    assert.equal(rebuilt.removed, 0, 'an archived record is not an orphan')
    assert.ok(getRecord(store.db, 'archived-one'), 'the archived record survives a rebuild')
    exportAll(store.db, scope, { prune: true })
    assert.equal(
        fs.existsSync(path.join(scope.root, 'archive', 'lessons', 'archived-one.md')),
        true,
        'and so does its file',
    )
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

test('dash-equivalent ids are the same lesson (legacy script spelling)', () => {
    // memory-lesson.sh slugifies with `sed 's/-\+/-/g;s/^-//;s/-$//'`, a GNU-ism
    // that does nothing under BSD sed: the corpus keeps `-fetch--origin`,
    // `dsh-session--append`, … while the plugin's slugify folds every run.
    assert.equal(normalizeDashes('dsh-session--append'), 'dsh-session-append')
    assert.equal(normalizeDashes('-fetch--origin'), 'fetch-origin')
    assert.equal(normalizeDashes('plain-id'), 'plain-id')
    assert.equal(equivalentIds('-fetch--origin', 'fetch-origin'), true)
    assert.equal(equivalentIds('-fetch--origin', '-fetch-origin'), true)
    assert.equal(equivalentIds('fetch-origin', 'fetch-origin-2'), false)
    assert.equal(equivalentIds('a-b', 'a-c'), false)
    assert.equal(equivalentIds('zh-702048f517', 'zh-702048f518'), false)
})

test('a legacy dashed lesson file merges into the existing record', async (t) => {
    const { store, scope } = await openProjectStore(t, 'store-dash-merge', {})
    assert.ok(store)
    upsertRecord(store.db, {
        ...materialize({
            title: 'fetch origin before pushing',
            body: 'short body',
            layer: 'project',
            scopeKind: 'project',
            repo: scope.repo,
            confidence: 0.7,
        }),
        id: 'fetch-origin',
        evidence: [{ kind: 'tool-failure', detail: 'EACCES: /Users/x/.dsh', at: '2026-09-02T00:00:00.000Z' }],
    })

    fs.writeFileSync(
        path.join(scope.root, 'lessons', '-fetch--origin.md'),
        lessonDoc({
            title: 'fetch origin before pushing',
            body: 'longer body: fetch origin and compare before pushing.',
            confidence: 0.9,
            updated: '2026-09-03',
            extra: { evidence: 'tool-failure×2, user-statement×1' },
        }),
    )

    const result = importLessons(store.db, scope)
    assert.equal(result.merged, 1, 'the file was merged, not inserted under a second id')
    assert.equal(countRecords(store.db).total, 1, 'one lesson keeps exactly one record')
    assert.equal(getRecord(store.db, '-fetch--origin'), undefined)

    const merged = getRecord(store.db, 'fetch-origin')
    assert.ok(merged)
    assert.equal(merged.timesSeen, 2, 'seen once more')
    assert.equal(merged.confidence, 0.9, 'confidence takes the max')
    assert.equal(merged.body, 'longer body: fetch origin and compare before pushing.', 'the longer body wins')
    assert.deepEqual(countEvidence(merged.evidence), [
        { kind: 'tool-failure', count: 2 },
        { kind: 'user-statement', count: 1 },
    ])
    assert.ok(
        merged.evidence.some((item) => item.detail === 'EACCES: /Users/x/.dsh'),
        'the store keeps the detailed evidence row the text view cannot carry',
    )

    // The adoption pass runs after every export: repeating it must not inflate
    // times_seen or rewrite the record again.
    const second = importLessons(store.db, scope)
    assert.equal(second.merged, 0)
    assert.equal(second.skipped, 1)
    assert.equal(getRecord(store.db, 'fetch-origin')?.timesSeen, 2)

    const adopted = importLessons(store.db, scope, { onlyMissing: true })
    assert.equal(adopted.skipped, 1, 'an equivalent id counts as present')
    assert.equal(countRecords(store.db).total, 1)
    assert.equal(getRecord(store.db, 'fetch-origin')?.timesSeen, 2)
})

test('evidence kinds and counts reach the text view and survive a rebuild', async (t) => {
    const { store, scope } = await openProjectStore(t, 'store-evidence', {})
    assert.ok(store)
    upsertRecord(store.db, {
        ...materialize({
            title: 'sandbox denies the global memory root',
            body: '触发场景：写 ~/.dsh 被拒。正确做法：降级到项目本地。',
            layer: 'project',
            scopeKind: 'project',
            repo: scope.repo,
            confidence: 0.9,
        }),
        id: 'sandbox-denies-global',
        evidence: [
            { kind: 'tool-failure', detail: 'EACCES: permission denied, open ~/.dsh', at: '2026-09-02T00:00:00.000Z' },
            { kind: 'tool-failure', detail: 'EPERM again on retry', at: '2026-09-02T01:00:00.000Z' },
            { kind: 'user-statement', detail: '用户指出应当降级', at: '2026-09-02T02:00:00.000Z' },
        ],
    })

    const exported = exportAll(store.db, scope)
    assert.deepEqual(exported.errors, [])
    const file = path.join(scope.root, 'lessons', 'sandbox-denies-global.md')
    const text = fs.readFileSync(file, 'utf8')
    assert.match(text, /^evidence: tool-failure×2, user-statement×1$/m)
    // §8 judges quality by kinds and counts; the raw tool output stays local.
    assert.doesNotMatch(text, /EACCES|EPERM|用户指出/)

    // "Another machine": the database is rebuilt from the text view alone.
    const rebuilt = importLessons(store.db, scope, { rebuild: true })
    assert.equal(rebuilt.imported, 1)
    const record = getRecord(store.db, 'sandbox-denies-global')
    assert.ok(record)
    assert.deepEqual(countEvidence(record.evidence), [
        { kind: 'tool-failure', count: 2 },
        { kind: 'user-statement', count: 1 },
    ])

    // A rebuilt document is stable: exporting it again changes nothing.
    exportAll(store.db, scope)
    assert.equal(fs.readFileSync(file, 'utf8'), text)
})

test('metrics.jsonl keeps one line per task_id and keeps foreign rows', async (t) => {
    const { store, scope } = await openProjectStore(t, 'store-metrics', {})
    assert.ok(store)
    const file = path.join(scope.root, 'metrics.jsonl')
    const lines = (): Record<string, unknown>[] =>
        fs
            .readFileSync(file, 'utf8')
            .split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => JSON.parse(line) as Record<string, unknown>)

    appendMetric(store.db, scope, { task_id: 't-1', date: '2026-09-01', outcome: 'partial', duration_min: 10 })
    // The same task reported again (a resumed session) must overwrite its line,
    // not add a second one — the ledger used to grow one line per report.
    appendMetric(store.db, scope, { task_id: 't-1', outcome: 'success' })
    assert.equal(lines().length, 1)
    assert.equal(lines()[0]?.['outcome'], 'success')
    assert.equal(lines()[0]?.['date'], '2026-09-01', 'the update keeps the fields the report did not carry')

    // A row the database does not know (hand-written, or from a machine whose
    // ledger was not imported yet) is not ours to delete.
    fs.appendFileSync(file, `${JSON.stringify({ task_id: 'manual-1', date: '2025-01-01', summary: '手写记录' })}\n`)
    // …and a stale duplicate line inside the file collapses into one.
    fs.appendFileSync(file, `${JSON.stringify({ task_id: 't-1', date: '2026-09-01', outcome: 'stale' })}\n`)

    const result = exportAll(store.db, scope)
    assert.deepEqual(result.errors, [])
    assert.equal(result.metrics, 1, 'exportAll rewrites the ledger from the store')
    const after = lines()
    assert.deepEqual(after.map((row) => row['task_id']), ['t-1', 'manual-1'], 'order is stable, duplicates collapse')
    assert.equal(after[0]?.['outcome'], 'success', 'the database wins over a stale file line')
    assert.equal(after[1]?.['summary'], '手写记录')
})

test('closeIdle releases the least recently used roots, which reopen intact', async (t) => {
    const registry = new StoreRegistry(resolveConfig({}))
    await registry.initialize(loadSqliteModule)
    if (!registry.available) {
        t.skip('node:sqlite unavailable')
        return
    }
    const tick = async (): Promise<void> => {
        await new Promise((resolve) => setTimeout(resolve, 5))
    }

    const scopes: MemoryScope[] = []
    for (const label of ['a', 'b', 'c']) {
        const repo = fakeRepo(`store-lru-${label}`)
        const scope: MemoryScope = { kind: 'project', repo, root: projectMemoryRoot(repo), reason: 'session-cwd' }
        scopes.push(scope)
        const store = registry.open(scope)
        assert.ok(store)
        upsertRecord(
            store.db,
            materialize({
                title: `lesson of ${label}`,
                body: '触发场景：x。正确做法：y。',
                layer: 'project',
                scopeKind: 'project',
                repo,
                confidence: 0.9,
            }),
        )
        await tick()
    }
    assert.equal(registry.listOpen().length, 3)

    assert.deepEqual(registry.closeIdle(5), [], 'nothing is closed below the limit')
    assert.deepEqual(registry.closeIdle(2), [scopes[0]?.root], 'the oldest root is released first')
    assert.deepEqual(registry.listOpen().map((store) => store.scope.root), [scopes[1]?.root, scopes[2]?.root])

    // Reopening works: the database is on disk, and the text view is re-read.
    const reopened = registry.open(scopes[0]!)
    assert.ok(reopened, 'a released root opens again')
    assert.equal(countRecords(reopened.db).total, 1, 'and still holds its records')
    assert.equal(registry.closeIdle(0).length, 3, 'a zero limit releases every root')
    assert.equal(registry.listOpen().length, 0)
    registry.closeAll()
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

test('a rebuild keeps the local data the text view cannot reproduce', async (t) => {
    // DESIGN §5.3 promises a "sidecar" for non-reproducible data. Without it,
    // `memory_reindex({ rebuild: true })` silently reset every usage counter and
    // the task ledger the regression gate reads.
    const { store, scope } = await openProjectStore(t, 'store-sidecar', {
        'kept.md': lessonDoc({ title: 'kept', body: '触发场景：x。正确做法：y。' }),
    })
    assert.ok(store)
    const at = new Date().toISOString()
    store.db
        .prepare('INSERT INTO usage (record_id, session_id, turn, step, score, injected_at, outcome) VALUES (?,?,?,?,?,?,?)')
        .run('kept', 'sess-sidecar', 1, 1, 0.9, at, 'success')
    store.db
        .prepare('INSERT INTO signals (session_id, turn, step, kind, tool, detail, at) VALUES (?,?,?,?,?,?,?)')
        .run('sess-sidecar', 1, 1, 'tool-failure', 'bash', 'exit code 2', at)
    store.db
        .prepare('INSERT INTO tasks (task_id, date, project, summary, outcome, duration_min, disturb_count, rework_rounds, lessons, tokens) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('t-sidecar', at.slice(0, 10), 'p', 'summary', 'success', 5, 0, 0, 1, 100)

    const rebuilt = rebuildScope(store.db, scope, true)
    assert.equal(rebuilt.imported >= 1, true)
    assert.equal(
        store.db.prepare('SELECT COUNT(*) AS n FROM usage WHERE session_id = ?').get('sess-sidecar')?.['n'],
        1,
        'recall bookkeeping survives',
    )
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE task_id = ?').get('t-sidecar')?.['n'], 1)
    // The signal exists only in the database (no episode file carries it): the
    // rebuild rewrites `signals` from the logs, so this row is exactly what the
    // sidecar has to carry across.
    assert.equal(
        store.db.prepare('SELECT COUNT(*) AS n FROM signals WHERE session_id = ?').get('sess-sidecar')?.['n'],
        1,
        'a database-only signal survives the rebuild',
    )

    // a second rebuild does not duplicate the preserved rows
    rebuildScope(store.db, scope, true)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM usage WHERE session_id = ?').get('sess-sidecar')?.['n'], 1)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM signals WHERE session_id = ?').get('sess-sidecar')?.['n'], 1)
})
