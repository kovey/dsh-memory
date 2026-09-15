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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/** Expand a leading `~` to the current user's home directory. */
export function expandHome(input) {
    if (input === '~')
        return os.homedir();
    if (input.startsWith('~/'))
        return path.join(os.homedir(), input.slice(2));
    return input;
}
/** dsh home: `$DSH_HOME` (expanded) or `~/.dsh`. */
export function dshHome() {
    const fromEnv = process.env['DSH_HOME'];
    if (fromEnv !== undefined && fromEnv !== '')
        return path.resolve(expandHome(fromEnv));
    return path.join(os.homedir(), '.dsh');
}
/** The global memory root, overridable for tests via `$DSH_MEMORY_HOME`. */
export function globalMemoryRoot(home = dshHome()) {
    const override = process.env['DSH_MEMORY_HOME'];
    if (override !== undefined && override !== '')
        return path.resolve(expandHome(override));
    return path.join(home, 'memory');
}
/** The project memory root: `<repo>/.dsh/memory`. */
export function projectMemoryRoot(repoRoot) {
    return path.join(repoRoot, '.dsh', 'memory');
}
/** True when `child` is `parent` or nested inside it (after normalization). */
export function isInside(parent, child) {
    const p = path.resolve(parent);
    const c = path.resolve(child);
    if (p === c)
        return true;
    return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}
/** mkdir -p that reports failure instead of throwing (sandbox denials are normal). */
export function ensureDir(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        return true;
    }
    catch {
        return false;
    }
}
const repoCache = new Map();
/** Drop cached repository lookups (tests, or after a workspace layout change). */
export function clearRepoCache() {
    repoCache.clear();
}
/**
 * Resolve the repository root owning `cwd`.
 *
 * Uses git's own answer (`--show-toplevel`) for the two layouts where `.git` is a
 * *file* — a linked worktree and a submodule — because the directory that holds
 * the `.git` entry is the working tree in both cases. Only a linked worktree is
 * folded into the main repository, so every worktree of one project shares a
 * single memory root; a submodule keeps its own memory (its common dir is
 * `<super>/.git/modules/<name>`, whose dirname would otherwise place project
 * memory *inside* `.git`, shared by every submodule of the superproject).
 *
 * Returns `undefined` when `cwd` is not inside a repository — callers must then
 * choose the global scope explicitly.
 */
export function resolveRepoRoot(cwd) {
    if (cwd === undefined || cwd === '')
        return undefined;
    const start = path.resolve(expandHome(cwd));
    const cached = repoCache.get(start);
    if (cached !== undefined)
        return cached ?? undefined;
    const found = detectRepoRoot(start);
    repoCache.set(start, found ?? null);
    return found;
}
function detectRepoRoot(start) {
    let dir = start;
    for (;;) {
        const entry = path.join(dir, '.git');
        if (fs.existsSync(entry)) {
            // A `.git` *directory* means `dir` owns the repository. Only a
            // `.git` *file* (worktree, submodule) needs git to resolve the
            // working tree — and asking git in the directory case would let it
            // walk further up and return an unrelated outer repository.
            if (isDirectory(entry))
                return dir;
            return gitWorkTreeRoot(dir) ?? dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
}
function isDirectory(target) {
    try {
        return fs.statSync(target).isDirectory();
    }
    catch {
        return false;
    }
}
/**
 * Project root for a directory whose `.git` is a file: git's `--show-toplevel`,
 * except in a linked worktree, which belongs to the main repository it shares a
 * common dir with.
 */
function gitWorkTreeRoot(dir) {
    const toplevel = git(dir, ['rev-parse', '--show-toplevel']);
    if (toplevel === undefined || toplevel === '')
        return undefined;
    const root = path.resolve(dir, toplevel);
    const main = mainWorkTree(dir);
    return main ?? root;
}
/**
 * The main repository's working tree, or undefined when `dir` is not a linked
 * worktree (a submodule reports the *same* absolute git dir and common dir, a
 * worktree reports its own dir inside the common one).
 */
function mainWorkTree(dir) {
    const gitDir = git(dir, ['rev-parse', '--absolute-git-dir']) ?? git(dir, ['rev-parse', '--git-dir']);
    const commonDir = git(dir, ['rev-parse', '--git-common-dir']);
    if (gitDir === undefined || commonDir === undefined)
        return undefined;
    const absoluteGitDir = path.resolve(dir, gitDir);
    const absoluteCommon = path.resolve(dir, commonDir);
    // git dir === common dir: a submodule (or a plain checkout with a relocated
    // git dir) — it has its own working tree and therefore its own memory.
    if (absoluteGitDir === absoluteCommon)
        return undefined;
    // A worktree's git dir lives inside the common dir; anything else (a fresh
    // clone's `.git` file pointing at an unrelated repository) keeps its own root.
    if (!isInside(absoluteCommon, absoluteGitDir))
        return undefined;
    const main = path.dirname(absoluteCommon);
    // Only trust dirname(common) when it really is the main working tree: a bare
    // repository has no `.git` there, and memory must not land in a bare store.
    return fs.existsSync(path.join(main, '.git')) ? main : undefined;
}
/** Run one git query, returning trimmed stdout or undefined on any failure. */
function git(dir, args) {
    try {
        const out = execFileSync('git', ['-C', dir, ...args], {
            encoding: 'utf8',
            timeout: 3000,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return out === '' ? undefined : out;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=paths.js.map