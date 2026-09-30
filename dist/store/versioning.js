/**
 * Is this project's memory actually versioned?
 *
 * DESIGN §5.3 promises that the text view is git-tracked, so a clone can rebuild
 * the whole store. Many repositories ignore `.dsh/` wholesale, and then that
 * promise silently does not hold: memory lives only on this machine, an archive
 * is unrecoverable, and a rebuild has nothing to rebuild from. The failure is
 * invisible (everything works), so it has to be *said*.
 *
 * Read-only diagnostics: one `git check-ignore` call at bootstrap, never a
 * mutation, never a session failure.
 */
import { execFileSync } from 'node:child_process';
import { log } from '../log.js';
const probed = new Set();
/** True when git reports `path` as ignored in `repo`. */
export function isGitIgnored(repo, path) {
    try {
        execFileSync('git', ['-C', repo, 'check-ignore', '-q', path], { stdio: 'ignore', timeout: 5_000 });
        return true;
    }
    catch (error) {
        // exit code 1 = not ignored; anything else (no git, no repo) = unknown
        const status = error.status;
        return status === 0;
    }
}
/**
 * Classify how (or whether) a scope's text view is versioned, and warn once per
 * root when the promise does not hold.
 */
export function probeVersioning(scope) {
    if (scope.kind !== 'project' || scope.repo === undefined)
        return 'versioned';
    let state = 'unknown';
    try {
        state = isGitIgnored(scope.repo, scope.root) ? 'ignored' : 'versioned';
    }
    catch {
        state = 'unknown';
    }
    if (state === 'ignored' && !probed.has(scope.root)) {
        probed.add(scope.root);
        log('info', `memory: ${scope.root} is git-ignored in this repository — project memory is machine-local ` +
            '(no clone rebuild, no recoverable archive). Add a local exception for .dsh/memory/{lessons,MEMORY.md,profile,metrics.jsonl} to version it.');
    }
    return state;
}
/** Test hook: forget which roots have already been reported. */
export function resetVersioningProbe() {
    probed.clear();
}
//# sourceMappingURL=versioning.js.map