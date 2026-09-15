import type { MemoryRecord, MemoryScope } from './types.js';
export declare class ScopeViolationError extends Error {
    readonly name = "ScopeViolationError";
}
/** Assert that `target` lives inside the scope's memory root. */
export declare function assertInsideScope(scope: MemoryScope, target: string): void;
/**
 * Assert that a record's own scope matches the target scope. A project record
 * may never be persisted into the global database (or vice versa), regardless
 * of what the caller asked for.
 *
 * `globalRoot` is the canonical global memory root (as resolved by the caller),
 * so an override such as `config.memoryHome` stays consistent.
 */
export declare function assertRecordScope(record: MemoryRecord, scope: MemoryScope, globalRoot: string): void;
/**
 * Assert a record about to be written belongs to the store it is written into.
 *
 * `assertRecordScope` needs the canonical global root and is therefore only
 * usable where the dsh home is known; this is the self-contained form that every
 * write path can afford: kind must match, and a project record must name the
 * same repository the scope resolved.
 */
export declare function assertDraftScope(record: MemoryRecord, scope: MemoryScope): void;
/**
 * Dash-insensitive form of a lesson id (identity, not scope).
 *
 * `slugify` and the legacy `memory-lesson.sh` disagree about runs of `-`:
 * the plugin folds them and trims the ends (`dsh-session--append` →
 * `dsh-session-append`), while the script's `sed 's/-\+/-/g;s/^-//;s/-$//'` is
 * a GNU-ism that is a no-op under BSD sed — the real corpus still carries
 * `-fetch--origin.md` and `dsh-session--append.md`. Both spellings name one
 * lesson, so id lookups compare this canonical form instead of the raw string.
 *
 * Only dashes and case are left alone; anything else (a `zh-<sha1>` fallback,
 * a `-2` disambiguation suffix) stays significant.
 */
export declare function normalizeDashes(id: string): string;
/** True when two ids name the same lesson under `normalizeDashes`. */
export declare function equivalentIds(a: string, b: string): boolean;
//# sourceMappingURL=guard.d.ts.map