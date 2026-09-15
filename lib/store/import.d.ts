import type { DatabaseSync } from 'node:sqlite';
import type { ParsedLesson } from './frontmatter.js';
import type { Layer, MemoryRecord, MemoryScope } from './types.js';
export interface ImportResult {
    root: string;
    scanned: number;
    imported: number;
    merged: number;
    skipped: number;
    errors: string[];
}
export interface ImportOptions {
    /**
     * Only insert ids the store does not have yet.
     *
     * The adoption pass (export) must never overwrite live state: the text view
     * does not carry everything the store knows (usage counters, distillations,
     * merges), so an unconditional upsert would silently revert them — an
     * archived record came back as active because its file has no status line.
     * Under this option a dash-equivalent id (see below) also counts as present:
     * the file is the same lesson under a legacy spelling, not a new one.
     */
    onlyMissing?: boolean;
    /** Replace the records table content instead of upserting into it. */
    rebuild?: boolean;
}
/** True when the records table holds nothing yet. */
export declare function isRecordsEmpty(db: DatabaseSync): boolean;
/** Import on first open only: an existing database is never overwritten. */
export declare function bootstrapImport(db: DatabaseSync, scope: MemoryScope): ImportResult | undefined;
/** Import every `<root>/lessons/*.md` document into the scope's database. */
export declare function importLessons(db: DatabaseSync, scope: MemoryScope, options?: ImportOptions): ImportResult;
/**
 * Convert one parsed lesson document into a record. The file name is
 * authoritative for identity: legacy slugs (including `zh-<sha1>` fallbacks)
 * must survive a round trip unchanged.
 */
export declare function recordFromLesson(parsed: ParsedLesson, layer: Layer, scope: MemoryScope, fileSlug: string): MemoryRecord;
//# sourceMappingURL=import.d.ts.map