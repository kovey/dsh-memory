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
/**
 * Is `path` ignored in `repo`?
 *
 * Three-state on purpose: `true` / `false` are git's answers, `undefined` means
 * git never answered (not a repository, no git on PATH, timeout). The old
 * boolean collapsed that third case into "not ignored", so a broken probe read
 * as "your memory is safely tracked" — the exact opposite of what it means.
 * (`status === 0` in the catch was dead code: exit 0 is the *success* path of
 * `git check-ignore`, the only exit code that returns from the `try`.)
 */
export function isGitIgnored(repo, path) {
    try {
        execFileSync('git', ['-C', repo, 'check-ignore', '-q', path], { stdio: 'ignore', timeout: 5_000 });
        return true;
    }
    catch (error) {
        const status = error.status;
        // exit 1 = git answered "not ignored"; everything else is "no answer".
        if (status === 1)
            return false;
        log('debug', `memory: git check-ignore could not answer for ${repo} (${status === undefined ? 'spawn failure' : `exit ${status}`}) — versioning state unknown`);
        return undefined;
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
        const ignored = isGitIgnored(scope.repo, scope.root);
        state = ignored === undefined ? 'unknown' : ignored ? 'ignored' : 'versioned';
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