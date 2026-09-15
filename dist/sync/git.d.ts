export interface GitResult {
    ok: boolean;
    stdout: string;
    stderr: string;
    code: number;
}
/** Files the memory store derives or keeps private — never versioned. */
export declare const GITIGNORE_ENTRIES: string[];
/** True when `dir` is inside a git work tree. */
export declare function isRepo(dir: string): boolean;
/**
 * Repository root owning `dir`, if any.
 *
 * The path is resolved through symlinks: git reports the physical path (on
 * macOS `/tmp/x` comes back as `/private/tmp/x`), and any later comparison with
 * the caller's logical path would otherwise look like "outside repository".
 */
export declare function repoRootOf(dir: string): string | undefined;
/** Write the memory `.gitignore` entries (idempotent, append-only). */
export declare function ensureGitignore(root: string): boolean;
/** Initialize a repository for a memory root (used for the global store). */
export declare function ensureRepo(root: string): boolean;
export declare function hasRemote(root: string): boolean;
export declare function isBusy(root: string): boolean;
export interface CommitOptions {
    /** Commit message body; a `dsh-memory:` prefix is added. */
    message: string;
    /** Extra paths (relative to the repo root) committed together with the root. */
    extraPaths?: readonly string[];
}
/** Stage and commit only the memory root's files. Never pushes. */
export declare function commitMemory(root: string, options: CommitOptions): GitResult & {
    committed: boolean;
    files: number;
};
export interface SyncOutcome {
    ok: boolean;
    action: 'up-to-date' | 'pulled' | 'pushed' | 'no-remote' | 'conflict' | 'error' | 'skipped';
    detail: string;
    conflicts: string[];
    rebased: boolean;
}
/**
 * Fetch and rebase the memory root's repository. Conflicts are *reported*, not
 * guessed at: the caller (or `resolveTextConflicts`) decides.
 */
export declare function sync(root: string, options?: {
    push?: boolean;
    timeoutMs?: number;
}): SyncOutcome;
/** Abort an in-progress rebase (used after an unresolvable conflict). */
export declare function abortRebase(root: string): GitResult;
/** Stage resolved paths and continue the rebase. */
export declare function continueRebase(root: string, resolvedPaths: readonly string[]): GitResult;
//# sourceMappingURL=git.d.ts.map