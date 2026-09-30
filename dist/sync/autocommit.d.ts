import type { MemoryConfig } from '../config.js';
import type { MemoryScope } from '../store/types.js';
/** Lock file name inside the memory root — deliberately not under `.git/`. */
export declare const LOCK_FILE_NAME = ".dsh-memory-commit.lock";
/** A lock older than this (mtime) belongs to a dead holder and may be taken. */
export declare const STALE_LOCK_MS = 120000;
export interface CommitOutcome {
    committed: boolean;
    files: number;
    detail: string;
    /** Why a commit did not happen, when it was not simply "nothing to commit". */
    skipped?: 'lock-timeout' | 'lock-unavailable' | 'in-process';
}
/** Who holds the lock, as far as the lock file says. */
export interface LockHolder {
    pid?: number;
    host?: string;
    at?: string;
    /** Identity of one acquisition, so we only ever release our own lock. */
    token?: string;
}
export interface CommitLock {
    root: string;
    file: string;
    token: string;
    /** True when an existing, stale lock was preempted to get here. */
    preempted: boolean;
}
export interface CommitLockFailure {
    reason: 'lock-timeout' | 'lock-unavailable';
    waitedMs: number;
    holder?: LockHolder;
}
export declare function lockFilePath(root: string): string;
/**
 * Acquire the export+commit lock for one memory root, waiting up to `timeoutMs`
 * for another process. Returns a failure record (never throws) when the lock
 * stayed busy or could not be created at all.
 */
export declare function acquireCommitLock(root: string, timeoutMs: number): CommitLock | CommitLockFailure;
/** Release a lock this process holds; never touches a lock someone else took. */
export declare function releaseCommitLock(lock: CommitLock): void;
/** Text-view export hook, run inside the lock right before the commit. */
export interface CommitHooks {
    exportText?: (scope: MemoryScope) => void;
}
export declare class AutoCommitter {
    private readonly config;
    private readonly hooks;
    private readonly lastCommit;
    constructor(config: MemoryConfig, hooks?: CommitHooks);
    /** Whether the configured mode allows a commit right now. */
    private allowed;
    /**
     * Commit the memory root when the policy allows it. Safe to call on every
     * turn end: a no-op commit is a no-op.
     */
    maybeCommit(scope: MemoryScope, reason: string, now?: number): CommitOutcome | undefined;
    /**
     * Same as {@link maybeCommit}, but queued behind any in-flight commit for the
     * same root in this process (promise chain) — the entry point for callers
     * that are already asynchronous.
     */
    maybeCommitAsync(scope: MemoryScope, reason: string, now?: number): Promise<CommitOutcome | undefined>;
    /** Force a commit (session end, explicit user request). */
    commitNow(scope: MemoryScope, reason: string, now?: number): CommitOutcome;
    /** Force a commit, queued behind in-flight commits for the same root. */
    commitAsync(scope: MemoryScope, reason: string, now?: number): Promise<CommitOutcome>;
    /** Last commit timestamp for one root (tests and stats). */
    lastCommitAt(root: string): number | undefined;
    /**
     * The export+commit critical section: export the text view, stage, commit.
     * Exactly one process (and one call inside this process) is inside at a time.
     */
    private commit;
}
//# sourceMappingURL=autocommit.d.ts.map