import type { LessonFrontmatter } from '../store/frontmatter.js';
export type ConflictStrategy = 'merge-lesson' | 'regenerate-index' | 'take-ours' | 'take-theirs' | 'manual';
export interface ConflictResolution {
    path: string;
    strategy: ConflictStrategy;
    /** Replacement file content; absent when the caller must intervene. */
    content?: string;
    note: string;
}
/** True when a file contains unresolved rebase conflict markers. */
export declare function hasConflictMarkers(text: string): boolean;
export interface ConflictSides {
    ours: string;
    theirs: string;
}
/** One `<<<<<<< / ======= / >>>>>>>` block, as line indices. */
export interface ConflictHunk {
    /** First line index of the marker block. */
    start: number;
    /** Index of the closing marker line. */
    end: number;
    ours: string;
    theirs: string;
}
/**
 * Parse *every* conflict hunk in a file.
 *
 * Git can leave several hunks in one file, and an earlier implementation only
 * understood the first: it reported a successful merge whose output still
 * contained markers and had silently dropped text — which then got `git add`ed
 * into the memory repository. Returns `[]` for malformed markers, which callers
 * must treat as "a human decides".
 */
export declare function parseConflictHunks(text: string): ConflictHunk[];
/** Rebuild a complete file taking one side of every hunk. */
export declare function reconstructSide(text: string, side: 'ours' | 'theirs', hunks?: ConflictHunk[]): string | undefined;
/** Split one conflicted file into its two complete sides (first-hunk view kept for tests). */
export declare function splitConflict(text: string): ConflictSides | undefined;
export interface MergeDeps {
    /** Regenerate `MEMORY.md` (it is derived, so never merged by hand). */
    regenerateIndex?: () => string;
}
/** Decide how to resolve one conflicted path. Pure: reads the file, writes nothing. */
export declare function resolveConflict(absolutePath: string, deps?: MergeDeps): ConflictResolution;
/** Rules for combining two sides of a lesson conflict. */
export declare function mergeFrontmatter(a: LessonFrontmatter, b: LessonFrontmatter): LessonFrontmatter;
/** `permanent` beats any date; otherwise the later date wins. */
/** Merge two `evidence: kind×count, …` summaries, keeping the higher count per kind. */
export declare function laterEvidence(ours: string | undefined, theirs: string | undefined): string | undefined;
export declare function laterExpiry(a: string, b: string): string;
//# sourceMappingURL=merge.d.ts.map