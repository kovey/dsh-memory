import type { MemoryScope } from './types.js';
/** Result of the versioning probe. */
export type VersioningState = 'versioned' | 'ignored' | 'no-repo' | 'unknown';
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
export declare function isGitIgnored(repo: string, path: string): boolean | undefined;
/**
 * Classify how (or whether) a scope's text view is versioned, and warn once per
 * root when the promise does not hold.
 */
export declare function probeVersioning(scope: MemoryScope): VersioningState;
/** Test hook: forget which roots have already been reported. */
export declare function resetVersioningProbe(): void;
//# sourceMappingURL=versioning.d.ts.map