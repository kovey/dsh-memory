/**
 * Automatic commits for the memory text view (DESIGN D6).
 *
 * Commits are local and path-scoped: `task-end` (throttled by
 * `git.checkpointMinutes`) or `immediate`. Pushing is deliberately absent from
 * this module — it only ever happens when a human asks for it through
 * `memory_sync({ push: true })`.
 */
import type { MemoryConfig } from '../config.js';
import type { MemoryScope } from '../store/types.js';
export interface CommitOutcome {
    committed: boolean;
    files: number;
    detail: string;
}
export declare class AutoCommitter {
    private readonly config;
    private readonly lastCommit;
    constructor(config: MemoryConfig);
    /** Whether the configured mode allows a commit right now. */
    private allowed;
    /**
     * Commit the memory root when the policy allows it. Safe to call on every
     * turn end: a no-op commit is a no-op.
     */
    maybeCommit(scope: MemoryScope, reason: string, now?: number): CommitOutcome | undefined;
    /** Force a commit (session end, explicit user request). */
    commitNow(scope: MemoryScope, reason: string, now?: number): CommitOutcome;
    /** Last commit timestamp for one root (tests and stats). */
    lastCommitAt(root: string): number | undefined;
}
//# sourceMappingURL=autocommit.d.ts.map