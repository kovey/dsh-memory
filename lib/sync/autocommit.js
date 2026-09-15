import { log } from '../log.js';
import { commitMemory, ensureGitignore } from './git.js';
export class AutoCommitter {
    config;
    lastCommit = new Map();
    constructor(config) {
        this.config = config;
    }
    /** Whether the configured mode allows a commit right now. */
    allowed(scope, now) {
        const mode = this.config.git.autoCommit;
        if (!this.config.git.enabled || mode === 'off')
            return false;
        if (mode === 'immediate')
            return true;
        const last = this.lastCommit.get(scope.root);
        if (last === undefined)
            return true;
        return now - last >= this.config.git.checkpointMinutes * 60_000;
    }
    /**
     * Commit the memory root when the policy allows it. Safe to call on every
     * turn end: a no-op commit is a no-op.
     */
    maybeCommit(scope, reason, now = Date.now()) {
        if (!this.allowed(scope, now))
            return undefined;
        return this.commitNow(scope, reason, now);
    }
    /** Force a commit (session end, explicit user request). */
    commitNow(scope, reason, now = Date.now()) {
        try {
            ensureGitignore(scope.root);
            const result = commitMemory(scope.root, { message: `${scope.kind === 'project' ? 'project' : 'global'} memory: ${reason}` });
            if (result.committed) {
                this.lastCommit.set(scope.root, now);
                log('info', `memory: committed ${result.files} file(s) in ${scope.root} (${reason})`);
                return { committed: true, files: result.files, detail: reason };
            }
            if (!result.ok)
                log('debug', `memory: commit skipped for ${scope.root}: ${result.stderr.trim()}`);
            return { committed: false, files: 0, detail: result.ok ? 'nothing to commit' : result.stderr.trim() };
        }
        catch (error) {
            log('warn', `memory: commit failed for ${scope.root}:`, error);
            return { committed: false, files: 0, detail: error instanceof Error ? error.message : String(error) };
        }
    }
    /** Last commit timestamp for one root (tests and stats). */
    lastCommitAt(root) {
        return this.lastCommit.get(root);
    }
}
//# sourceMappingURL=autocommit.js.map