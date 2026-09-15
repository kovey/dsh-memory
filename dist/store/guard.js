/**
 * Scope guards — the enforcement point for invariants 2 and 3 (DESIGN §2, §3).
 *
 * Project memory is written **only** under `<repo>/.dsh/memory`; a project-scope
 * write whose path resolves anywhere else is refused outright rather than
 * silently redirected to the global root. The same rule protects the reverse
 * direction, so the two databases can never contaminate each other.
 */
import path from 'node:path';
import { isInside, projectMemoryRoot } from '../paths.js';
export class ScopeViolationError extends Error {
    name = 'ScopeViolationError';
}
/** Assert that `target` lives inside the scope's memory root. */
export function assertInsideScope(scope, target) {
    if (!isInside(scope.root, target)) {
        throw new ScopeViolationError(`refusing to write outside the ${scope.kind} memory root: ${target} is not inside ${scope.root}`);
    }
}
/**
 * Assert that a record's own scope matches the target scope. A project record
 * may never be persisted into the global database (or vice versa), regardless
 * of what the caller asked for.
 *
 * `globalRoot` is the canonical global memory root (as resolved by the caller),
 * so an override such as `config.memoryHome` stays consistent.
 */
export function assertRecordScope(record, scope, globalRoot) {
    if (record.scopeKind !== scope.kind) {
        throw new ScopeViolationError(`record ${record.id} is ${record.scopeKind}-scoped but the target root is ${scope.kind}`);
    }
    if (record.scopeKind === 'project') {
        if (scope.repo === undefined || record.repo === undefined) {
            throw new ScopeViolationError(`project record ${record.id} requires a repository root on both sides`);
        }
        if (path.resolve(record.repo) !== path.resolve(scope.repo)) {
            throw new ScopeViolationError(`record ${record.id} belongs to ${record.repo} but the target project is ${scope.repo}`);
        }
        const expected = projectMemoryRoot(scope.repo);
        if (path.resolve(scope.root) !== path.resolve(expected)) {
            throw new ScopeViolationError(`project scope root must be ${expected}, got ${scope.root}`);
        }
    }
    else {
        if (path.resolve(scope.root) !== path.resolve(globalRoot)) {
            throw new ScopeViolationError(`global scope root must be ${globalRoot}, got ${scope.root}`);
        }
    }
}
/**
 * Assert a record about to be written belongs to the store it is written into.
 *
 * `assertRecordScope` needs the canonical global root and is therefore only
 * usable where the dsh home is known; this is the self-contained form that every
 * write path can afford: kind must match, and a project record must name the
 * same repository the scope resolved.
 */
export function assertDraftScope(record, scope) {
    if (record.scopeKind !== scope.kind) {
        throw new ScopeViolationError(`refusing to write a ${record.scopeKind} record into the ${scope.kind} store (${record.id})`);
    }
    if (scope.kind === 'project') {
        if (record.repo === undefined || scope.repo === undefined || path.resolve(record.repo) !== path.resolve(scope.repo)) {
            throw new ScopeViolationError(`refusing to write ${record.id} into ${scope.repo ?? '?'} — the record belongs to ${record.repo ?? 'no repository'}`);
        }
        return;
    }
    if (record.repo !== undefined) {
        throw new ScopeViolationError(`refusing to write project-scoped ${record.id} (${record.repo}) into the global store`);
    }
}
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
export function normalizeDashes(id) {
    return id.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}
/** True when two ids name the same lesson under `normalizeDashes`. */
export function equivalentIds(a, b) {
    return a === b || normalizeDashes(a) === normalizeDashes(b);
}
//# sourceMappingURL=guard.js.map