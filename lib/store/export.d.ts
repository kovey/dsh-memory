import type { DatabaseSync } from 'node:sqlite';
import type { MemoryRecord, MemoryScope } from './types.js';
export interface ExportResult {
    root: string;
    written: number;
    removed: number;
    /** Rows in the rewritten `metrics.jsonl` ledger. */
    metrics: number;
    errors: string[];
}
export interface ExportOptions {
    /**
     * Delete `.md` files this store does not own.
     *
     * Off by default: a file written by `memory-lesson.sh`, by hand, or by a
     * colleague's machine is not ours to delete, and in a project whose
     * `.gitignore` covers `.dsh/` such a deletion is unrecoverable. Adopting
     * unknown lesson files (below) is the designed behaviour; pruning is only
     * for an explicit rebuild.
     */
    prune?: boolean;
    /** Adopt lesson files that no record claims yet (the script fallback path). */
    adopt?: boolean;
}
/**
 * Write every record of a root to its text-view path: active/pending records to
 * `lessons/<id>.md`, archived records to `archive/lessons/<id>.md`.
 *
 * Archiving must never delete a lesson file — that would turn "archive instead
 * of delete" into a silent loss — so an archived record is *moved* and files
 * with no surviving record in that state are pruned.
 */
export declare function exportLessons(db: DatabaseSync, scope: MemoryScope, options?: ExportOptions): ExportResult;
/** One lesson document, frontmatter compatible with `memory-lesson.sh`. */
export declare function renderRecord(record: MemoryRecord, evidenceSummary?: string): string;
/** Regenerate the `MEMORY.md` index for a scope root. */
export declare function exportIndex(db: DatabaseSync, scope: MemoryScope): string;
/** Atomic write: temp file in the same directory, then rename. */
export declare function writeAtomic(file: string, content: string): void;
/** Full text-view export for one root. */
export declare function exportAll(db: DatabaseSync, scope: MemoryScope, options?: ExportOptions): ExportResult;
//# sourceMappingURL=export.d.ts.map