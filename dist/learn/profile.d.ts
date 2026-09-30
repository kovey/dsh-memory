import type { MemoryScope } from '../store/types.js';
/** Files that make up the layer, in render order. */
export declare const PROFILE_FILES: readonly ["preferences.md", "conventions.md"];
export type ProfileFile = (typeof PROFILE_FILES)[number];
/**
 * A profile file *name* (without `.md`): lowercase letters, digits and dashes.
 *
 * This is a security boundary, not cosmetics: `memory_save` takes the name from
 * a model, and `../../lessons/x` or `/etc/passwd` must never resolve to a path.
 * `profileFilePath` still re-checks with `assertInsideScope`, so a traversal bug
 * here is caught there as well.
 */
export declare const PROFILE_NAME_RE: RegExp;
/** True when `name` may be used as `<memory root>/profile/<name>.md`. */
export declare function isProfileName(name: string): boolean;
export declare function profileDir(scope: MemoryScope): string;
/**
 * Path of one profile file, with the *name* rule enforced here rather than at
 * the call sites.
 *
 * `isProfileName` used to be checked only on the `memory_save` tool surface and
 * in `appendProfileLine`, so every other writer (`writeProfile`, a test, a future
 * caller) could create `profile/UPPER.md`, `profile/a.b.md` or `profile/x/y.md`:
 * names that stay inside the root but are not part of the documented layer. The
 * rule belongs where the path is built — one door, one check.
 *
 * Returns `undefined` (and logs) for a name that is not a bare `[a-z0-9-]` slug
 * or that would resolve outside the scope.
 */
export declare function profileFilePath(scope: MemoryScope, name: ProfileFile | string): string | undefined;
export interface ProfileEntry {
    name: string;
    text: string;
}
/** Read the layer's files, newest content first is not a thing here — order is fixed. */
export declare function readProfile(scope: MemoryScope): ProfileEntry[];
/**
 * Render the layer for the resident section: a short heading, then each file's
 * lines until the budget is spent. Bounded like every other prompt surface.
 */
export declare function renderProfile(entries: readonly ProfileEntry[], budgetTokens?: number): string;
/** Replace one profile file's content (used by a confirmed `memory_save`). */
export declare function writeProfile(scope: MemoryScope, name: string, text: string): string | undefined;
/**
 * Append one line to any L5 file, keeping it a list.
 *
 * `preferences.md` is the default door (`appendPreference`), but the layer is
 * "plain markdown under `profile/`": `conventions.md` and friends are legitimate
 * L5 files and had no write path at all before this. The name is validated here
 * rather than at the call site so every writer — tool, test, future caller —
 * gets the same guarantee.
 */
export declare function appendProfileLine(scope: MemoryScope, name: string, line: string, now?: Date): string | undefined;
/** Append one preference line to `preferences.md`, keeping it a list. */
export declare function appendPreference(scope: MemoryScope, line: string, now?: Date): string | undefined;
//# sourceMappingURL=profile.d.ts.map