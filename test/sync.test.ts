/**
 * Git-sync and rebuild tests (DESIGN §5.3, D6).
 *
 * Real repositories are used (no git mocks): the point of these tests is that a
 * memory commit touches only the memory root, and that a clone can rebuild the
 * database from the text view alone.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../dist/config.js'
import { clearRepoCache } from '../dist/paths.js'
import { ScopeResolver } from '../dist/scope/resolver.js'
import { exportAll } from '../dist/store/export.js'
import { loadSqliteModule } from '../dist/store/sqlite/db.js'
import { countRecords, getRecord, materialize, upsertRecord } from '../dist/store/sqlite/records.js'
import { fingerprint, importEpisodes, rebuildScope } from '../dist/store/rebuild.js'
import { StoreRegistry } from '../dist/store/store.js'
import { AutoCommitter } from '../dist/sync/autocommit.js'
import { commitMemory, ensureGitignore, ensureRepo, hasRemote, isRepo, repoRootOf, sync } from '../dist/sync/git.js'
import {
    hasConflictMarkers,
    laterExpiry,
    mergeFrontmatter,
    parseConflictHunks,
    reconstructSide,
    resolveConflict,
    splitConflict,
} from '../dist/sync/merge.js'
import { lessonDoc, tempDir, useGlobalMemoryHome } from './helpers.ts'
import { parseLesson, renderLesson } from '../dist/store/frontmatter.js'

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function initRepo(label: string): string {
    const dir = tempDir(label)
    git(dir, 'init', '--quiet', '-b', 'main')
    git(dir, 'config', 'user.email', 'test@example.com')
    git(dir, 'config', 'user.name', 'dsh-memory test')
    git(dir, 'config', 'commit.gpgsign', 'false')
    return dir
}

async function openScope(t: { skip: (reason: string) => void }, repo: string, config: Record<string, unknown> = {}) {
    clearRepoCache()
    const resolved = resolveConfig(config)
    const registry = new StoreRegistry(resolved)
    const report = await registry.initialize(loadSqliteModule)
    if (!registry.available) {
        t.skip(`node:sqlite unavailable: ${report.probe.reason ?? 'unknown'}`)
        throw new Error('unreachable')
    }
    const resolver = new ScopeResolver(resolved)
    const agent = { session: { id: 'sync-test', header: { cwd: repo } } }
    const scope = resolver.resolve({ agent })
    const store = registry.open(scope)
    assert.ok(store)
    return { resolved, registry, resolver, agent, scope, store, repo }
}

// ---- git primitives ---------------------------------------------------------

test('the gitignore template is written once and never duplicated', () => {
    const root = tempDir('m4-ignore')
    assert.equal(ensureGitignore(root), true)
    const first = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
    assert.match(first, /memory\.db/)
    assert.match(first, /sessions\//)
    assert.equal(ensureGitignore(root), false, 'second call adds nothing')
    assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), first)
})

test('a memory commit touches only the memory root', async (t) => {
    const repo = initRepo('m4-scope')
    const h = await openScope(t, repo)
    upsertRecord(h.store.db, materialize({ title: 'scoped lesson', body: '触发场景：x。正确做法：y。', layer: 'project', scopeKind: 'project', repo }))
    exportAll(h.store.db, h.scope)

    // unrelated work in the same repository must stay untouched
    fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'work in progress\n')

    ensureRepo(h.scope.root)
    const result = commitMemory(h.scope.root, { message: 'test commit' })
    assert.equal(result.committed, true)
    assert.ok(result.files > 0)

    const committed = git(repo, 'show', '--name-only', '--pretty=format:').split('\n').filter((line) => line !== '')
    assert.ok(committed.some((file) => file.includes('lessons/scoped-lesson.md')))
    assert.equal(committed.includes('unrelated.txt'), false, 'unrelated file must not be committed')
    const status = git(repo, 'status', '--porcelain')
    assert.match(status, /unrelated\.txt/, 'unrelated file still pending')

    // a second commit with no changes is a no-op
    const again = commitMemory(h.scope.root, { message: 'nothing new' })
    assert.equal(again.committed, false)
    assert.equal(again.ok, true)
    assert.equal(isRepo(h.scope.root), true)
    assert.equal(repoRootOf(h.scope.root), repo)
    assert.equal(hasRemote(repo), false)
})

test('sync reports a missing remote instead of failing', async (t) => {
    const repo = initRepo('m4-noremote')
    const h = await openScope(t, repo)
    ensureRepo(h.scope.root)
    const outcome = sync(h.scope.root, {})
    assert.equal(outcome.ok, true)
    assert.equal(outcome.action, 'no-remote')
})

test('two clones exchange lessons through the remote', async (t) => {
    const origin = tempDir('m4-origin')
    git(origin, 'init', '--quiet', '--bare', '-b', 'main')
    const a = initRepo('m4-clone-a')
    git(a, 'remote', 'add', 'origin', origin)
    const h = await openScope(t, a)

    upsertRecord(h.store.db, materialize({ title: 'lesson from A', body: '触发场景：a。正确做法：A 的做法。', layer: 'project', scopeKind: 'project', repo: a }))
    exportAll(h.store.db, h.scope)
    ensureRepo(h.scope.root)
    commitMemory(h.scope.root, { message: 'add lesson A' })
    git(a, 'push', '--quiet', '-u', 'origin', 'main')

    // clone B gets the text view, not the database
    const b = tempDir('m4-clone-b')
    execFileSync('git', ['clone', '--quiet', origin, b], { stdio: ['ignore', 'pipe', 'pipe'] })
    git(b, 'config', 'user.email', 'test@example.com')
    git(b, 'config', 'user.name', 'dsh-memory test')
    assert.equal(fs.existsSync(path.join(b, '.dsh', 'memory', 'memory.db')), false, 'databases are not versioned')

    const hb = await openScope(t, b)
    const rebuilt = rebuildScope(hb.store.db, hb.scope, hb.store.fts5)
    assert.equal(rebuilt.imported, 1)
    const record = getRecord(hb.store.db, 'lesson-from-a')
    assert.ok(record)
    assert.equal(record.title, 'lesson from A')

    // B adds its own lesson, pushes; A pulls it back
    upsertRecord(hb.store.db, materialize({ title: 'lesson from B', body: '触发场景：b。正确做法：B 的做法。', layer: 'project', scopeKind: 'project', repo: b }))
    exportAll(hb.store.db, hb.scope)
    commitMemory(hb.scope.root, { message: 'add lesson B' })
    git(b, 'push', '--quiet')

    const pulled = sync(a, {})
    assert.equal(pulled.ok, true, pulled.detail)
    assert.equal(pulled.action, 'pulled')
    const after = rebuildScope(h.store.db, h.scope, h.store.fts5)
    assert.ok(after.imported >= 1)
    assert.ok(getRecord(h.store.db, 'lesson-from-b'), 'lesson B arrived through git')
})

// ---- commit policy ----------------------------------------------------------

test('auto-commit follows the configured cadence', async (t) => {
    const repo = initRepo('m4-cadence')
    const h = await openScope(t, repo, { git: { autoCommit: 'task-end', checkpointMinutes: 30 } })
    upsertRecord(h.store.db, materialize({ title: 'cadence lesson', body: '触发场景：x。正确做法：y。', layer: 'project', scopeKind: 'project', repo }))
    exportAll(h.store.db, h.scope)

    const throttled = new AutoCommitter(h.resolved)
    const first = throttled.maybeCommit(h.scope, 'turn end')
    assert.equal(first?.committed, true)
    fs.writeFileSync(path.join(h.scope.root, 'lessons', 'cadence-lesson.md'), `${fs.readFileSync(path.join(h.scope.root, 'lessons', 'cadence-lesson.md'), 'utf8')}\n<!-- tweak -->\n`)
    const soon = throttled.maybeCommit(h.scope, 'turn end')
    assert.equal(soon, undefined, 'checkpoint throttle holds')
    const later = throttled.maybeCommit(h.scope, 'turn end', Date.now() + 31 * 60_000)
    assert.equal(later?.committed, true, 'after the checkpoint window it commits again')

    const immediate = new AutoCommitter(resolveConfig({ git: { autoCommit: 'immediate' } }))
    fs.writeFileSync(path.join(h.scope.root, 'lessons', 'cadence-lesson.md'), `${fs.readFileSync(path.join(h.scope.root, 'lessons', 'cadence-lesson.md'), 'utf8')}\n<!-- again -->\n`)
    assert.equal(immediate.maybeCommit(h.scope, 'immediate')?.committed, true)

    const off = new AutoCommitter(resolveConfig({ git: { autoCommit: 'off' } }))
    fs.writeFileSync(path.join(h.scope.root, 'lessons', 'cadence-lesson.md'), `${fs.readFileSync(path.join(h.scope.root, 'lessons', 'cadence-lesson.md'), 'utf8')}\n<!-- off -->\n`)
    assert.equal(off.maybeCommit(h.scope, 'off'), undefined)
})

// ---- conflict merging -------------------------------------------------------

const CONFLICTED = `<<<<<<< HEAD
---
title: shared lesson
confidence: 0.8
expires: 2026-06-01
times_seen: 2
updated: 2026-09-01
---

触发场景：本机做法。正确做法：A。
=======
---
title: shared lesson
confidence: 0.95
expires: 2027-01-01
times_seen: 3
updated: 2026-09-10
---

触发场景：另一台机器的做法，包含更多上下文。正确做法：B，并且补充说明。
>>>>>>> feature
`

test('lesson conflicts merge by rule', () => {
    const dir = tempDir('m4-merge')
    const file = path.join(dir, 'shared-lesson.md')
    fs.writeFileSync(file, CONFLICTED)
    assert.equal(hasConflictMarkers(CONFLICTED), true)
    const sides = splitConflict(CONFLICTED)
    assert.ok(sides)
    assert.equal(parseLesson(sides.ours)?.frontmatter.timesSeen, 2)
    assert.equal(parseLesson(sides.theirs)?.frontmatter.timesSeen, 3)

    const resolution = resolveConflict(file)
    assert.equal(resolution.strategy, 'merge-lesson')
    const merged = parseLesson(resolution.content ?? '')
    assert.ok(merged)
    assert.equal(merged.frontmatter.timesSeen, 5, 'repetitions add up')
    assert.equal(merged.frontmatter.confidence, 0.95, 'stronger confidence wins')
    assert.equal(merged.frontmatter.expires, '2027-01-01', 'later expiry wins')
    assert.match(merged.body, /正确做法：B/, 'longer body kept')
    assert.equal(hasConflictMarkers(resolution.content ?? ''), false)
})

test('MEMORY.md regenerates, unknown files fall back to the longer side', () => {
    const dir = tempDir('m4-merge-index')
    const indexFile = path.join(dir, 'MEMORY.md')
    fs.writeFileSync(indexFile, `<<<<<<< HEAD\ntable A\n=======\ntable B\n>>>>>>> other\n`)
    const regenerated = resolveConflict(indexFile, { regenerateIndex: () => '# MEMORY\n\nregenerated\n' })
    assert.equal(regenerated.strategy, 'regenerate-index')
    assert.match(regenerated.content ?? '', /regenerated/)

    const metrics = path.join(dir, 'metrics.jsonl')
    fs.writeFileSync(metrics, `<<<<<<< HEAD\n{"task_id":"a"}\n=======\n{"task_id":"b","extra":"longer"}\n>>>>>>> other\n`)
    const fallback = resolveConflict(metrics)
    assert.equal(fallback.strategy, 'take-theirs')
    assert.match(fallback.content ?? '', /longer/)

    const clean = path.join(dir, 'clean.md')
    fs.writeFileSync(clean, 'no markers here')
    assert.equal(resolveConflict(clean).strategy, 'manual')
})

test('frontmatter merge rules are total', () => {
    const merged = mergeFrontmatter(
        { title: 'a', confidence: 0.5, expires: '2026-01-01', timesSeen: 1, updated: '2026-01-01', tags: ['x'] },
        { title: 'bb', confidence: 0.7, expires: 'permanent', timesSeen: 2, updated: '2026-02-01', tags: ['y'] },
    )
    assert.equal(merged.timesSeen, 3)
    assert.equal(merged.confidence, 0.7)
    assert.equal(merged.expires, 'permanent')
    assert.deepEqual(merged.tags, ['x', 'y'])
    assert.equal(merged.updated, '2026-02-01')
    assert.equal(laterExpiry('2026-01-01', '2025-01-01'), '2026-01-01')
    assert.equal(laterExpiry('permanent', '2030-01-01'), 'permanent')
})

// ---- rebuild ----------------------------------------------------------------

test('a clone rebuilds the same memory from the text view alone', async (t) => {
    const repo = initRepo('m4-rebuild')
    const h = await openScope(t, repo)
    const lessons = {
        'alpha.md': lessonDoc({ title: 'alpha lesson', body: '触发场景：a。正确做法：A。', confidence: 0.9, timesSeen: 3 }),
        'beta.md': lessonDoc({ title: 'beta lesson', body: '触发场景：b。正确做法：B。', confidence: 0.7 }),
    }
    fs.mkdirSync(path.join(h.scope.root, 'lessons'), { recursive: true })
    for (const [name, body] of Object.entries(lessons)) {
        fs.writeFileSync(path.join(h.scope.root, 'lessons', name), body)
    }
    fs.writeFileSync(
        path.join(h.scope.root, 'metrics.jsonl'),
        `${JSON.stringify({ task_id: 't-1', date: '2026-09-01', project: 'demo', summary: 'x', outcome: 'success' })}\n`,
    )
    fs.mkdirSync(path.join(h.scope.root, 'sessions'), { recursive: true })
    fs.writeFileSync(
        path.join(h.scope.root, 'sessions', '2026-09-14.sess.jsonl'),
        `${JSON.stringify({ at: new Date().toISOString(), session: 'sess', turn: 1, kind: 'tool-failure', tool: 'bash', detail: 'boom' })}\n`,
    )
    const first = rebuildScope(h.store.db, h.scope, h.store.fts5)
    assert.equal(first.imported, 2)
    assert.equal(first.metrics, 1)
    assert.equal(first.episodes, 1)
    // counters survive the earlier bootstrap (times_seen comes from frontmatter)
    assert.equal(getRecord(h.store.db, 'alpha')?.timesSeen, 3)
    const before = fingerprint(h.store.db)

    // simulate a fresh clone: copy only the tracked text view
    const clone = initRepo('m4-rebuild-clone')
    fs.cpSync(path.join(h.scope.root, 'lessons'), path.join(clone, '.dsh', 'memory', 'lessons'), { recursive: true })
    fs.cpSync(path.join(h.scope.root, 'sessions'), path.join(clone, '.dsh', 'memory', 'sessions'), { recursive: true })
    fs.copyFileSync(path.join(h.scope.root, 'metrics.jsonl'), path.join(clone, '.dsh', 'memory', 'metrics.jsonl'))

    const hc = await openScope(t, clone)
    const rebuilt = rebuildScope(hc.store.db, hc.scope, hc.store.fts5)
    assert.equal(rebuilt.imported, 2)
    assert.deepEqual(fingerprint(hc.store.db), before, 'clone reproduces the same memory')
    assert.equal(hc.store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.['n'], 1)
    assert.equal(hc.store.db.prepare('SELECT COUNT(*) AS n FROM signals').get()?.['n'], 1)
})

test('rebuild drops records whose lesson file is gone and keeps the rest', async (t) => {
    const repo = initRepo('m4-rebuild-prune')
    const h = await openScope(t, repo)
    upsertRecord(h.store.db, materialize({ title: 'kept lesson', body: '触发场景：x。正确做法：y。', layer: 'project', scopeKind: 'project', repo }))
    upsertRecord(h.store.db, materialize({ title: 'vanished lesson', body: '触发场景：x。正确做法：y。', layer: 'project', scopeKind: 'project', repo }))
    exportAll(h.store.db, h.scope)
    assert.equal(countRecords(h.store.db).total, 2)
    fs.rmSync(path.join(h.scope.root, 'lessons', 'vanished-lesson.md'))

    const result = rebuildScope(h.store.db, h.scope, h.store.fts5)
    assert.equal(result.removed, 1)
    assert.equal(countRecords(h.store.db).total, 1)
    assert.ok(getRecord(h.store.db, 'kept-lesson'))
    assert.equal(getRecord(h.store.db, 'vanished-lesson'), undefined)
})

test('episode logs are re-imported, and a corrupt line does not abort them', async (t) => {
    const repo = initRepo('m4-episodes')
    const h = await openScope(t, repo)
    const dir = path.join(h.scope.root, 'sessions')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
        path.join(dir, '2026-09-14.sess.jsonl'),
        [
            JSON.stringify({ at: new Date().toISOString(), turn: 1, kind: 'tool-failure', tool: 'bash', detail: 'one' }),
            '{ this is not json',
            JSON.stringify({ at: new Date().toISOString(), turn: 2, kind: 'user-correction' }),
        ].join('\n') + '\n',
    )
    const imported = importEpisodes(h.store.db, h.scope)
    assert.equal(imported, 2)
    const rows = h.store.db.prepare('SELECT session_id, turn, kind FROM signals ORDER BY turn').all()
    assert.equal(rows.length, 2)
    assert.equal(rows[0]?.['session_id'], 'sess', 'session id recovered from the file name')
    // idempotent: importing twice does not duplicate rows
    assert.equal(importEpisodes(h.store.db, h.scope), 2)
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM signals').get()?.['n'], 2)
})

test('exported lesson files round-trip through git conflict-free shapes', async (t) => {
    const repo = initRepo('m4-roundtrip')
    const h = await openScope(t, repo)
    upsertRecord(h.store.db, materialize({ title: 'round trip git', body: '触发场景：x。正确做法：y。', layer: 'project', scopeKind: 'project', repo, confidence: 0.85 }))
    exportAll(h.store.db, h.scope)
    const file = path.join(h.scope.root, 'lessons', 'round-trip-git.md')
    const text = fs.readFileSync(file, 'utf8')
    assert.equal(hasConflictMarkers(text), false)
    const parsed = parseLesson(text)
    assert.ok(parsed)
    assert.equal(renderLesson(parsed.frontmatter, parsed.body), text)
})

test('a symlinked memory root still commits (macOS /tmp vs /private/tmp)', async (t) => {
    const repo = initRepo('m4-symlink')
    const link = path.join(tempDir('m4-symlink-link'), 'memlink')
    fs.symlinkSync(path.join(repo, '.dsh', 'memory'), link, 'dir')
    // create the real directory before the link target is used
    fs.mkdirSync(path.join(repo, '.dsh', 'memory', 'lessons'), { recursive: true })

    const h = await openScope(t, repo)
    upsertRecord(h.store.db, materialize({ title: 'symlinked lesson', body: '触发场景：x。正确做法：y。', layer: 'project', scopeKind: 'project', repo }))
    exportAll(h.store.db, h.scope)

    ensureRepo(link)
    const result = commitMemory(link, { message: 'via symlink' })
    assert.equal(result.ok, true, result.stderr)
    assert.equal(result.committed, true)
    const committed = git(repo, 'show', '--name-only', '--pretty=format:')
    assert.match(committed, /lessons\/symlinked-lesson\.md/)
})

test('multiple conflict hunks are merged without leaving markers behind', () => {
    // Regression guard: the first implementation merged only the first hunk and
    // returned content that still contained markers (with text silently
    // dropped) — which the sync path would then `git add`.
    const dir = tempDir('m4-merge-multi')
    const file = path.join(dir, 'multi-hunk.md')
    fs.writeFileSync(
        file,
        `---
title: multi hunk
confidence: 0.8
expires: permanent
times_seen: 1
updated: 2026-09-01
---

<<<<<<< HEAD
第一段：本项目做法 pnpm 安装。
=======
第一段：另一台机器的做法 pnpm 安装，带更多上下文说明。
>>>>>>> other

中间不变的行。

<<<<<<< HEAD
第二段：本项目做法。
=======
第二段：另一台机器的做法，也更长一些。
>>>>>>> other
`,
    )
    const hunks = parseConflictHunks(fs.readFileSync(file, 'utf8'))
    assert.equal(hunks.length, 2)

    const resolution = resolveConflict(file)
    assert.equal(resolution.strategy, 'merge-lesson')
    const content = resolution.content ?? ''
    assert.equal(hasConflictMarkers(content), false, 'no markers may survive a merge')
    assert.match(content, /第一段：另一台机器的做法/, 'longer side wins per hunk')
    assert.match(content, /第二段：另一台机器的做法/, 'the second hunk is resolved too')
    assert.match(content, /中间不变的行/, 'untouched text between hunks survives')
    assert.equal(parseLesson(content)?.frontmatter.timesSeen, 2)
    assert.equal(reconstructSide(fs.readFileSync(file, 'utf8'), 'ours')?.includes('第二段：本项目做法'), true)
})

test('several hunks in a non-lesson file are left for a human', () => {
    const dir = tempDir('m4-merge-manual')
    const file = path.join(dir, 'metrics.jsonl')
    fs.writeFileSync(
        file,
        `<<<<<<< HEAD
{"task_id":"a"}
=======
{"task_id":"b"}
>>>>>>> other
<<<<<<< HEAD
{"task_id":"c"}
=======
{"task_id":"d"}
>>>>>>> other
`,
    )
    assert.equal(resolveConflict(file).strategy, 'manual')
})

// ---- end-to-end conflict resolution through the real tool -------------------

test('a real rebase conflict is resolved from any working directory', async (t) => {
    // The audit found this escape: `git diff --name-only` lists repo-relative
    // paths, the tool treated them as absolute (resolving against the process
    // cwd), so automatic merges reported ENOENT "needs a human" — or wrote the
    // merged lesson to an unrelated file — while the memory repo kept its
    // conflict markers. There was no end-to-end test, which is why it survived.
    const origin = tempDir('sync-e2e-origin')
    git(origin, 'init', '--quiet', '--bare', '-b', 'main')

    const seed = tempDir('sync-e2e-seed')
    git(seed, 'init', '--quiet', '-b', 'main')
    git(seed, 'config', 'user.email', 'test@example.com')
    git(seed, 'config', 'user.name', 'dsh-memory test')
    fs.mkdirSync(path.join(seed, 'lessons'), { recursive: true })
    fs.writeFileSync(
        path.join(seed, 'lessons', 'shared.md'),
        lessonDoc({ title: 'shared lesson', body: '触发场景：本机。正确做法：本机做法。' }),
    )
    git(seed, 'add', '-A')
    git(seed, 'commit', '--quiet', '-m', 'seed')
    git(seed, 'remote', 'add', 'origin', origin)
    git(seed, 'push', '--quiet', '-u', 'origin', 'main')

    // our memory root: a clone that has diverged
    const root = tempDir('sync-e2e-local')
    git(root, 'clone', '--quiet', origin, root)
    git(root, 'config', 'user.email', 'test@example.com')
    git(root, 'config', 'user.name', 'dsh-memory test')
    fs.writeFileSync(
        path.join(root, 'lessons', 'shared.md'),
        lessonDoc({
            title: 'shared lesson',
            body: '触发场景：本机。正确做法：本机做法，补充了这一段说明以便合并时保留更长的一侧。',
            timesSeen: 3,
            confidence: 0.95,
        }),
    )
    git(root, 'add', '-A')
    git(root, 'commit', '--quiet', '-m', 'local edit')

    // the remote gains a different edit to the same file
    fs.writeFileSync(
        path.join(seed, 'lessons', 'shared.md'),
        lessonDoc({ title: 'shared lesson', body: '触发场景：远端。正确做法：远端做法。', timesSeen: 2 }),
    )
    git(seed, 'add', '-A')
    git(seed, 'commit', '--quiet', '-m', 'remote edit')
    git(seed, 'push', '--quiet')

    // `git diff --name-only` reports repo-relative paths; assert that contract
    // without leaving the repository mid-rebase for the tool run below.
    const probe = sync(root)
    assert.equal(probe.action, 'conflict', JSON.stringify(probe))
    assert.deepEqual(probe.conflicts, ['lessons/shared.md'], 'paths are reported repo-relative')
    git(root, 'rebase', '--abort')

    // The memory root *is* the clone (a standalone repository, as a global memory
    // root is): point the global root at it and run from a directory that is not
    // a repository, so the session's scope is exactly this root.
    // Outside the plugin repository: a cwd inside *any* repository would resolve
    // to that repository's project scope instead of the global root under test.
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-e2e-cwd-'))
    clearRepoCache()
    useGlobalMemoryHome(root)
    const config = resolveConfig({})
    const registry = new StoreRegistry(config)
    const available = await registry.initialize(loadSqliteModule)
    if (!registry.available) {
        t.skip(`node:sqlite unavailable: ${available.probe.reason ?? 'unknown'}`)
        return
    }
    const resolver = new ScopeResolver(config)
    const store = registry.open(resolver.resolve({ cwd: elsewhere }))
    assert.equal(store?.scope.root, root, 'the session scope is the cloned root')
    const committer = new AutoCommitter(config)

    // Run the tool from an unrelated cwd: the old code resolved `lessons/shared.md`
    // against it.
    const previousCwd = process.cwd()
    process.chdir(elsewhere)
    try {
        const { syncTool } = await import('../dist/tools/sync.js')
        const tool = syncTool({ config, registry, resolver, committer })
        const report = await (tool as unknown as {
            execute: (args: unknown, exec: unknown) => Promise<string>
        }).execute({ resolveConflicts: true, rebuild: false }, { agent: { session: { id: 'sync-e2e', header: { cwd: elsewhere } } } })
        assert.doesNotMatch(report, /unreadable|ENOENT/, `the merge must not fail on a path: ${report}`)
        assert.doesNotMatch(report, /needs a human/, report)
        assert.match(report, /resolved shared\.md: merge-lesson/, `the merge must happen by rule: ${report}`)
    } finally {
        process.chdir(previousCwd)
    }

    const merged = fs.readFileSync(path.join(root, 'lessons', 'shared.md'), 'utf8')
    assert.equal(hasConflictMarkers(merged), false, 'no markers survive into the memory repo')
    assert.match(merged, /本机做法/, 'the longer side won the body')
    // and nothing was written into the unrelated cwd
    assert.equal(fs.existsSync(path.join(elsewhere, 'lessons', 'shared.md')), false)
})
