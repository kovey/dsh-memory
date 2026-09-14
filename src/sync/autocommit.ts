/**
 * Automatic commits for the memory text view (DESIGN D6).
 *
 * Commits are local and path-scoped: `task-end` (throttled by
 * `git.checkpointMinutes`) or `immediate`. Pushing is deliberately absent from
 * this module — it only ever happens when a human asks for it through
 * `memory_sync({ push: true })`.
 */
import type { MemoryConfig } from '../config.js'
import { log } from '../log.js'
import type { MemoryScope } from '../store/types.js'
import { commitMemory, ensureGitignore } from './git.js'

export interface CommitOutcome {
    committed: boolean
    files: number
    detail: string
}

export class AutoCommitter {
    private readonly lastCommit = new Map<string, number>()

    constructor(private readonly config: MemoryConfig) {}

    /** Whether the configured mode allows a commit right now. */
    private allowed(scope: MemoryScope, now: number): boolean {
        const mode = this.config.git.autoCommit
        if (!this.config.git.enabled || mode === 'off') return false
        if (mode === 'immediate') return true
        const last = this.lastCommit.get(scope.root)
        if (last === undefined) return true
        return now - last >= this.config.git.checkpointMinutes * 60_000
    }

    /**
     * Commit the memory root when the policy allows it. Safe to call on every
     * turn end: a no-op commit is a no-op.
     */
    maybeCommit(scope: MemoryScope, reason: string, now = Date.now()): CommitOutcome | undefined {
        if (!this.allowed(scope, now)) return undefined
        return this.commitNow(scope, reason, now)
    }

    /** Force a commit (session end, explicit user request). */
    commitNow(scope: MemoryScope, reason: string, now = Date.now()): CommitOutcome {
        try {
            ensureGitignore(scope.root)
            const result = commitMemory(scope.root, { message: `${scope.kind === 'project' ? 'project' : 'global'} memory: ${reason}` })
            if (result.committed) {
                this.lastCommit.set(scope.root, now)
                log('info', `memory: committed ${result.files} file(s) in ${scope.root} (${reason})`)
                return { committed: true, files: result.files, detail: reason }
            }
            if (!result.ok) log('debug', `memory: commit skipped for ${scope.root}: ${result.stderr.trim()}`)
            return { committed: false, files: 0, detail: result.ok ? 'nothing to commit' : result.stderr.trim() }
        } catch (error) {
            log('warn', `memory: commit failed for ${scope.root}:`, error)
            return { committed: false, files: 0, detail: error instanceof Error ? error.message : String(error) }
        }
    }

    /** Last commit timestamp for one root (tests and stats). */
    lastCommitAt(root: string): number | undefined {
        return this.lastCommit.get(root)
    }
}
