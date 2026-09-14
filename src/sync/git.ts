/**
 * Git integration for the text view (DESIGN §5.3, D6).
 *
 * Three hard rules:
 *   1. Only the memory root is ever staged or committed — a memory commit must
 *      never sweep up unrelated work in the user's repository.
 *   2. Pushing is never automatic. `memory_sync({ push: true })` exists so a
 *      human can ask for it explicitly, and nothing else calls it.
 *   3. Every git failure is non-fatal: memory keeps working on disk even when
 *      the repository is dirty, mid-rebase, or missing.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { log } from '../log.js'

export interface GitResult {
    ok: boolean
    stdout: string
    stderr: string
    code: number
}

/** Files the memory store derives or keeps private — never versioned. */
export const GITIGNORE_ENTRIES = [
    '# dsh-memory: derived and private artifacts (the text view is tracked)',
    'memory.db',
    'memory.db-shm',
    'memory.db-wal',
    'sessions/',
    '.queue/',
    '*.bak.*',
    '',
]

function run(cwd: string, args: string[], timeoutMs = 15_000): GitResult {
    try {
        const stdout = execFileSync('git', ['-C', cwd, ...args], {
            encoding: 'utf8',
            timeout: timeoutMs,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        return { ok: true, stdout, stderr: '', code: 0 }
    } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; status?: number; message?: string }
        return {
            ok: false,
            stdout: failure.stdout ?? '',
            stderr: failure.stderr ?? failure.message ?? '',
            code: typeof failure.status === 'number' ? failure.status : 1,
        }
    }
}

/** True when `dir` is inside a git work tree. */
export function isRepo(dir: string): boolean {
    if (!fs.existsSync(dir)) return false
    return run(dir, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true'
}

/**
 * Repository root owning `dir`, if any.
 *
 * The path is resolved through symlinks: git reports the physical path (on
 * macOS `/tmp/x` comes back as `/private/tmp/x`), and any later comparison with
 * the caller's logical path would otherwise look like "outside repository".
 */
export function repoRootOf(dir: string): string | undefined {
    const result = run(dir, ['rev-parse', '--show-toplevel'])
    const top = result.stdout.trim()
    if (!result.ok || top === '') return undefined
    return realPathOf(top)
}

/** `realpath` that never throws; falls back to the input. */
function realPathOf(target: string, cache = new Map<string, string>()): string {
    const cached = cache.get(target)
    if (cached !== undefined) return cached
    let resolved = target
    try {
        resolved = fs.realpathSync(target)
    } catch {
        resolved = target
    }
    cache.set(target, resolved)
    return resolved
}

/** Write the memory `.gitignore` entries (idempotent, append-only). */
export function ensureGitignore(root: string): boolean {
    try {
        fs.mkdirSync(root, { recursive: true })
        const file = path.join(root, '.gitignore')
        const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
        const lines = existing.split('\n')
        const missing = GITIGNORE_ENTRIES.filter((entry) => entry !== '' && !lines.includes(entry))
        if (missing.length === 0) return false
        const prefix = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`
        fs.writeFileSync(file, `${prefix}${missing.join('\n')}`)
        return true
    } catch (error) {
        log('debug', `memory: gitignore update failed for ${root}:`, error)
        return false
    }
}

/** Initialize a repository for a memory root (used for the global store). */
export function ensureRepo(root: string): boolean {
    ensureGitignore(root)
    if (isRepo(root)) return true
    const result = run(root, ['init', '--quiet'])
    if (!result.ok) {
        log('warn', `memory: git init failed for ${root}: ${result.stderr.trim()}`)
        return false
    }
    return true
}

export function hasRemote(root: string): boolean {
    return run(root, ['remote']).stdout.trim() !== ''
}

export function isBusy(root: string): boolean {
    const state = path.join(repoRootOf(root) ?? root, '.git')
    return ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD'].some((marker) =>
        fs.existsSync(path.join(state, marker)),
    )
}

/**
 * Paths the memory root contributes to its repository, relative to the repo
 * root. Both sides are resolved first so a symlinked memory root (macOS `/tmp`,
 * a symlinked `$HOME`, a linked workspace) still stages the right paths.
 */
function relativePaths(root: string): { repo: string; paths: string[] } | undefined {
    const repo = repoRootOf(root)
    if (repo === undefined) return undefined
    const physicalRoot = realPathOf(root)
    const relative = path.relative(repo, physicalRoot)
    if (relative === '' ) return { repo, paths: ['.'] }
    if (relative.startsWith('..')) {
        // The root resolves outside the repository git reported: refuse rather
        // than stage a path git will reject.
        return { repo, paths: [] }
    }
    return { repo, paths: [relative] }
}

export interface CommitOptions {
    /** Commit message body; a `dsh-memory:` prefix is added. */
    message: string
    /** Extra paths (relative to the repo root) committed together with the root. */
    extraPaths?: readonly string[]
}

/** Stage and commit only the memory root's files. Never pushes. */
export function commitMemory(root: string, options: CommitOptions): GitResult & { committed: boolean; files: number } {
    const target = relativePaths(root)
    if (target === undefined) return { ok: false, stdout: '', stderr: 'not a git repository', code: 1, committed: false, files: 0 }
    if (isBusy(root)) {
        return { ok: false, stdout: '', stderr: 'repository is mid-merge/rebase', code: 1, committed: false, files: 0 }
    }
    const paths = [...target.paths, ...(options.extraPaths ?? [])]
    if (paths.length === 0) {
        return { ok: false, stdout: '', stderr: 'memory root resolves outside its repository', code: 1, committed: false, files: 0 }
    }
    const add = run(target.repo, ['add', '-A', '--', ...paths])
    if (!add.ok) return { ...add, committed: false, files: 0 }

    const status = run(target.repo, ['diff', '--cached', '--name-only', '--', ...paths])
    const files = status.stdout.split('\n').filter((line) => line.trim() !== '')
    if (files.length === 0) return { ok: true, stdout: '', stderr: '', code: 0, committed: false, files: 0 }

    // Pathspec on commit keeps unrelated staged work out of this commit.
    const commit = run(target.repo, ['commit', '--quiet', '-m', `dsh-memory: ${options.message}`, '--', ...paths])
    return { ...commit, committed: commit.ok, files: files.length }
}

export interface SyncOutcome {
    ok: boolean
    action: 'up-to-date' | 'pulled' | 'pushed' | 'no-remote' | 'conflict' | 'error' | 'skipped'
    detail: string
    conflicts: string[]
    rebased: boolean
}

/**
 * Fetch and rebase the memory root's repository. Conflicts are *reported*, not
 * guessed at: the caller (or `resolveTextConflicts`) decides.
 */
export function sync(root: string, options: { push?: boolean; timeoutMs?: number } = {}): SyncOutcome {
    const target = relativePaths(root)
    if (target === undefined) {
        return { ok: false, action: 'skipped', detail: 'not a git repository', conflicts: [], rebased: false }
    }
    if (!hasRemote(target.repo)) {
        return { ok: true, action: 'no-remote', detail: 'no remote configured — local commits only', conflicts: [], rebased: false }
    }
    if (isBusy(root)) {
        return { ok: false, action: 'skipped', detail: 'repository is mid-merge/rebase', conflicts: [], rebased: false }
    }
    const timeout = options.timeoutMs ?? 30_000
    const fetch = run(target.repo, ['fetch', '--quiet', '--prune'], timeout)
    if (!fetch.ok) return { ok: false, action: 'error', detail: `fetch failed: ${fetch.stderr.trim()}`, conflicts: [], rebased: false }

    const upstream = run(target.repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    if (!upstream.ok || upstream.stdout.trim() === '') {
        return { ok: true, action: 'no-remote', detail: 'branch has no upstream — nothing to pull', conflicts: [], rebased: false }
    }

    const pull = run(target.repo, ['pull', '--rebase', '--quiet'], timeout)
    if (!pull.ok) {
        const conflicted = run(target.repo, ['diff', '--name-only', '--diff-filter=U'])
        const conflicts = conflicted.stdout.split('\n').filter((line) => line.trim() !== '')
        if (conflicts.length > 0) {
            return { ok: false, action: 'conflict', detail: 'rebase stopped with conflicts', conflicts, rebased: true }
        }
        return { ok: false, action: 'error', detail: `pull failed: ${pull.stderr.trim()}`, conflicts: [], rebased: false }
    }

    if (options.push === true) {
        const push = run(target.repo, ['push', '--quiet'], timeout)
        if (!push.ok) return { ok: false, action: 'error', detail: `push failed: ${push.stderr.trim()}`, conflicts: [], rebased: true }
        return { ok: true, action: 'pushed', detail: `rebased onto ${upstream.stdout.trim()} and pushed`, conflicts: [], rebased: true }
    }
    return { ok: true, action: 'pulled', detail: `rebased onto ${upstream.stdout.trim()}`, conflicts: [], rebased: true }
}

/** Abort an in-progress rebase (used after an unresolvable conflict). */
export function abortRebase(root: string): GitResult {
    const target = relativePaths(root)
    if (target === undefined) return { ok: false, stdout: '', stderr: 'not a git repository', code: 1 }
    return run(target.repo, ['rebase', '--abort'])
}

/** Stage resolved paths and continue the rebase. */
export function continueRebase(root: string, resolvedPaths: readonly string[]): GitResult {
    const target = relativePaths(root)
    if (target === undefined) return { ok: false, stdout: '', stderr: 'not a git repository', code: 1 }
    run(target.repo, ['add', '--', ...resolvedPaths])
    return run(target.repo, ['-c', 'core.editor=true', 'rebase', '--continue'])
}
