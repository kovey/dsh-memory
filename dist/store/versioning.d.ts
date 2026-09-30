import type { MemoryScope } from './types.js';
/** Result of the versioning probe. */
export type VersioningState = 'versioned' | 'ignored' | 'no-repo' | 'unknown';
/** True when git reports `path` as ignored in `repo`. */
export declare function isGitIgnored(repo: string, path: string): boolean;
/**
 * Classify how (or whether) a scope's text view is versioned, and warn once per
 * root when the promise does not hold.
 */
export declare function probeVersioning(scope: MemoryScope): VersioningState;
/** Test hook: forget which roots have already been reported. */
export declare function resetVersioningProbe(): void;
//# sourceMappingURL=versioning.d.ts.map