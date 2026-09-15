import type { MemoryScope } from '../store/types.js';
/** Files that make up the layer, in render order. */
export declare const PROFILE_FILES: readonly ["preferences.md", "conventions.md"];
export type ProfileFile = (typeof PROFILE_FILES)[number];
export declare function profileDir(scope: MemoryScope): string;
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
/** Append one preference line to `preferences.md`, keeping it a list. */
export declare function appendPreference(scope: MemoryScope, line: string, now?: Date): string | undefined;
//# sourceMappingURL=profile.d.ts.map