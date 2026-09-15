/**
 * Scope resolution tests (DESIGN §9.3, invariant 3): project scopes come from
 * the session working directory, and a missing repository context must fall
 * back to the global scope explicitly — never silently.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../dist/config.js'
import { clearRepoCache, projectMemoryRoot, resolveRepoRoot } from '../dist/paths.js'
import { ScopeResolver } from '../dist/scope/resolver.js'
import { fakeRepo, memoryFixture, repoRoot, tempDir, useGlobalMemoryHome } from './helpers.ts'

test('resolves a project scope from the session working directory', () => {
    clearRepoCache()
    const repo = fakeRepo('scope-project')
    const home = memoryFixture('scope-global', {})
    useGlobalMemoryHome(home.root)
    const resolver = new ScopeResolver(resolveConfig({}))

    const scope = resolver.resolve({ agent: { session: { header: { cwd: repo } } } })
    assert.equal(scope.kind, 'project')
    assert.equal(scope.repo, repo)
    assert.equal(scope.root, `${repo}/.dsh/memory`)
    assert.equal(scope.reason, 'session-cwd')
})

test('falls back to the global scope when no repository owns the directory', () => {
    clearRepoCache()
    const home = memoryFixture('scope-norepo', {})
    useGlobalMemoryHome(home.root)
    const resolver = new ScopeResolver(resolveConfig({}))
    // The system temp directory is outside every repository; scratch dirs under
    // the plugin repo are *inside* one (and must resolve to it, not to global).
    const orphan = os.tmpdir()

    const scope = resolver.resolve({ cwd: orphan })
    assert.equal(scope.kind, 'global')
    assert.equal(scope.reason, 'no-project-context')
    assert.equal(scope.root, home.root)
})

test('a session outside every repository never inherits the host repo', () => {
    clearRepoCache()
    const home = memoryFixture('scope-host-repo', {})
    useGlobalMemoryHome(home.root)
    // process.cwd() *is* inside the plugin repository here: a session whose own
    // cwd is outside every repository must still resolve to the global scope,
    // otherwise memory would leak across projects.
    const scope = new ScopeResolver(resolveConfig({})).resolve({
        agent: { session: { header: { cwd: os.tmpdir() } } },
    })
    assert.equal(scope.kind, 'global')
    assert.equal(scope.reason, 'no-project-context')
    assert.equal(scope.root, home.root)
})

test('a scratch directory inside a repository belongs to that repository', () => {
    clearRepoCache()
    const home = memoryFixture('scope-inside-repo', {})
    useGlobalMemoryHome(home.root)
    const scratch = memoryFixture('scope-scratch', {}).root
    const scope = new ScopeResolver(resolveConfig({})).resolve({ cwd: scratch })
    assert.equal(scope.kind, 'project')
    assert.equal(scope.repo, repoRoot)
})

test('honours an explicit global request without touching the project root', () => {
    clearRepoCache()
    const repo = fakeRepo('scope-explicit')
    const home = memoryFixture('scope-explicit-global', {})
    useGlobalMemoryHome(home.root)
    const resolver = new ScopeResolver(resolveConfig({}))

    const scope = resolver.resolve({ agent: { session: { header: { cwd: repo } } }, explicit: 'global' })
    assert.equal(scope.kind, 'global')
    assert.equal(scope.root, home.root)
    assert.equal(scope.reason, 'explicit-global')
})

test('detects subagent sessions and withholds write authority by default', () => {
    clearRepoCache()
    const home = memoryFixture('scope-subagent', {})
    useGlobalMemoryHome(home.root)
    const resolver = new ScopeResolver(resolveConfig({}))

    const subagent = { session: { header: { cwd: home.root, origin: 'subagent' as const } } }
    assert.equal(resolver.isSubagent(subagent), true)
    assert.equal(resolver.mayWrite(subagent), false)
    assert.equal(resolver.mayWrite({ session: { header: { cwd: home.root } } }), true)

    const permissive = new ScopeResolver(resolveConfig({ routing: { subagentWrite: true } }))
    assert.equal(permissive.mayWrite(subagent), true)
})

test('reads the session cwd from the session header, not the process cwd', () => {
    clearRepoCache()
    const repo = fakeRepo('scope-header-wins')
    const home = memoryFixture('scope-header-global', {})
    useGlobalMemoryHome(home.root)
    const resolver = new ScopeResolver(resolveConfig({}))
    const scope = resolver.resolve({ agent: { session: { id: 's1', header: { cwd: repo } } } })
    assert.equal(scope.repo, repo)
})

// ---- real git layouts -------------------------------------------------------
// The project root of a submodule used to resolve to `<super>/.git/modules`
// (dirname of the common dir), so its memory landed *inside* `.git` and every
// submodule of a superproject shared one database. These tests build the real
// layouts with git; if git is missing they are skipped rather than mocked.

function git(cwd: string, args: string[]): string {
    return execFileSync('git', ['-C', cwd, '-c', 'user.email=test@example.com', '-c', 'user.name=tester', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
}

function gitAvailable(): boolean {
    try {
        execFileSync('git', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
        return true
    } catch {
        return false
    }
}

/** A committed repository, so `worktree add` and `submodule add` have a HEAD. */
function initRepo(dir: string): string {
    fs.mkdirSync(dir, { recursive: true })
    git(dir, ['init', '-q', '-b', 'main'])
    fs.writeFileSync(path.join(dir, 'README.md'), 'scratch\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'init'])
    return dir
}

test('a submodule owns its own project root, not the superproject .git', (t) => {
    if (!gitAvailable()) {
        t.skip('git is not available')
        return
    }
    const sub = initRepo(tempDir('scope-sub-origin'))
    const superRepo = initRepo(tempDir('scope-super'))
    git(superRepo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'modules/sub'])
    const subDir = path.join(superRepo, 'modules', 'sub')
    fs.mkdirSync(path.join(subDir, 'inner'), { recursive: true })
    clearRepoCache()

    assert.equal(resolveRepoRoot(subDir), subDir, 'the submodule work tree is the project root')
    assert.equal(resolveRepoRoot(path.join(subDir, 'inner')), subDir, 'and so it is from a nested directory')
    // The bug's fingerprint: memory must never live inside the superproject's
    // git dir, and two submodules must not share one root.
    assert.equal(resolveRepoRoot(subDir)?.startsWith(path.join(superRepo, '.git')), false)
    assert.equal(resolveRepoRoot(superRepo), superRepo, 'the superproject keeps its own root')
    assert.notEqual(projectMemoryRoot(resolveRepoRoot(subDir) ?? ''), projectMemoryRoot(superRepo))
})

test('a linked worktree shares the main repository root', (t) => {
    if (!gitAvailable()) {
        t.skip('git is not available')
        return
    }
    const main = initRepo(tempDir('scope-worktree-main'))
    fs.mkdirSync(path.join(main, 'src'), { recursive: true })
    const worktree = path.join(main, '..', `${path.basename(main)}-wt`)
    git(main, ['worktree', 'add', '-q', '-b', 'feature', worktree])
    clearRepoCache()

    assert.equal(resolveRepoRoot(worktree), main, 'the worktree writes into the main project memory')
    assert.equal(resolveRepoRoot(path.join(worktree, 'src')), main, 'also from a nested directory')
})

test('a plain repository resolves to its own top level', (t) => {
    if (!gitAvailable()) {
        t.skip('git is not available')
        return
    }
    const repo = initRepo(tempDir('scope-plain-repo'))
    const nested = path.join(repo, 'packages', 'inner')
    fs.mkdirSync(nested, { recursive: true })
    clearRepoCache()
    assert.equal(resolveRepoRoot(nested), repo)
    // A scratch directory of this repository is not inside the scratch repo.
    assert.equal(resolveRepoRoot(repoRoot), repoRoot)
})
