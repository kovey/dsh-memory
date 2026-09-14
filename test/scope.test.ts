/**
 * Scope resolution tests (DESIGN §9.3, invariant 3): project scopes come from
 * the session working directory, and a missing repository context must fall
 * back to the global scope explicitly — never silently.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { clearRepoCache } from '../lib/paths.js'
import { ScopeResolver } from '../lib/scope/resolver.js'
import { fakeRepo, memoryFixture, repoRoot, useGlobalMemoryHome } from './helpers.ts'

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
