/**
 * Memory path resolution (DESIGN §5.1).
 *
 * Two roots, physically isolated:
 *   global  → <dshHome>/memory
 *   project → <repo>/.dsh/memory
 *
 * A project root is never substituted by the global root (invariant 3): when no
 * repository context exists the caller gets `undefined` and must decide
 * explicitly to fall back to the global scope.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Expand a leading `~` to the current user's home directory. */
export function expandHome(input: string): string {
    if (input === '~') return os.homedir()
    if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2))
    return input
}

/** dsh home: `$DSH_HOME` (expanded) or `~/.dsh`. */
export function dshHome(): string {
    const fromEnv = process.env['DSH_HOME']
    if (fromEnv !== undefined && fromEnv !== '') return path.resolve(expandHome(fromEnv))
    return path.join(os.homedir(), '.dsh')
}

/** The global memory root, overridable for tests via `$DSH_MEMORY_HOME`. */
export function globalMemoryRoot(home: string = dshHome()): string {
    const override = process.env['DSH_MEMORY_HOME']
    if (override !== undefined && override !== '') return path.resolve(expandHome(override))
    return path.join(home, 'memory')
}

/** The project memory root: `<repo>/.dsh/memory`. */
export function projectMemoryRoot(repoRoot: string): string {
    return path.join(repoRoot, '.dsh', 'memory')
}

/** True when `child` is `parent` or nested inside it (after normalization). */
export function isInside(parent: string, child: string): boolean {
    const p = path.resolve(parent)
    const c = path.resolve(child)
    if (p === c) return true
    return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

/** mkdir -p that reports failure instead of throwing (sandbox denials are normal). */
export function ensureDir(dir: string): boolean {
    try {
        fs.mkdirSync(dir, { recursive: true })
        return true
    } catch {
        return false
    }
}

const repoCache = new Map<string, string | null>()

/** Drop cached repository lookups (tests, or after a workspace layout change). */
export function clearRepoCache(): void {
    repoCache.clear()
}

/**
 * Resolve the repository root owning `cwd`.
 *
 * Uses the *common* git dir so every worktree of one repository shares a single
 * project memory root. Returns `undefined` when `cwd` is not inside a
 * repository — callers must then choose the global scope explicitly.
 */
export function resolveRepoRoot(cwd: string | undefined): string | undefined {
    if (cwd === undefined || cwd === '') return undefined
    const start = path.resolve(expandHome(cwd))
    const cached = repoCache.get(start)
    if (cached !== undefined) return cached ?? undefined

    const found = detectRepoRoot(start)
    repoCache.set(start, found ?? null)
    return found
}

function detectRepoRoot(start: string): string | undefined {
    let dir = start
    for (;;) {
        const entry = path.join(dir, '.git')
        if (fs.existsSync(entry)) {
            // A `.git` *directory* means `dir` owns the repository. Only a
            // `.git` *file* (worktree, submodule) needs git to resolve the
            // common dir — and asking git in the directory case would let it
            // walk further up and return an unrelated outer repository.
            if (isDirectory(entry)) return dir
            return gitCommonRoot(dir) ?? dir
        }
        const parent = path.dirname(dir)
        if (parent === dir) return undefined
        dir = parent
    }
}

function isDirectory(target: string): boolean {
    try {
        return fs.statSync(target).isDirectory()
    } catch {
        return false
    }
}

/** Resolve `<dir>/.git` to the repository root that owns worktrees too. */
function gitCommonRoot(dir: string): string | undefined {
    try {
        const out = execFileSync('git', ['-C', dir, 'rev-parse', '--git-common-dir'], {
            encoding: 'utf8',
            timeout: 3000,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
        if (out === '') return undefined
        const abs = path.isAbsolute(out) ? out : path.resolve(dir, out)
        return path.dirname(abs)
    } catch {
        return undefined
    }
}
