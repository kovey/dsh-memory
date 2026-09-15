import type { DatabaseSync } from 'node:sqlite';
import type { Evidence, Layer, MemoryRecord, RecordStatus, ScopeKind } from '../types.js';
export interface RecordFilter {
    layers?: readonly Layer[];
    status?: readonly RecordStatus[];
    scopeKind?: ScopeKind;
    repo?: string;
    limit?: number;
}
export interface RecordCounts {
    total: number;
    active: number;
    pending: number;
    archived: number;
    expired: number;
    superseded: number;
}
/**
 * Slug a title exactly like `~/.dsh/scripts/memory-lesson.sh`, so ids stay
 * stable across the file-based fallback and this plugin. Non-ASCII titles fall
 * back to `zh-<sha1 prefix>`, matching the script's behaviour.
 */
export declare function slugify(title: string): string;
/** Build a persistable record from a draft, filling ids, counters and stamps. */
export declare function materialize(draft: {
    title: string;
    body: string;
    layer: Layer;
    scopeKind: ScopeKind;
    repo?: string;
    confidence?: number;
    expiresAt?: string;
    tags?: string[];
    evidence?: Evidence[];
    origin?: string;
    source?: MemoryRecord['source'];
    status?: RecordStatus;
}, now?: string): MemoryRecord;
export declare function clamp01(value: number): number;
export declare function rowToRecord(row: Record<string, unknown> | undefined): MemoryRecord | undefined;
/** Insert or replace a record, keeping its evidence rows in sync. */
export declare function upsertRecord(db: DatabaseSync, record: MemoryRecord): void;
export declare function getRecord(db: DatabaseSync, id: string): MemoryRecord | undefined;
export declare function listEvidence(db: DatabaseSync, recordId: string): Evidence[];
export declare function listRecords(db: DatabaseSync, filter?: RecordFilter): MemoryRecord[];
export declare function countRecords(db: DatabaseSync, now?: Date): RecordCounts;
export interface RawHit {
    id: string;
    /** Raw FTS5 bm25 value (negative is better) or a LIKE fallback score. */
    raw: number;
}
/**
 * Query the FTS index for `terms`, falling back to LIKE when FTS5 is missing.
 * The caller owns scoring and ranking (see `recall/rank.ts`).
 */
export declare function rawSearch(db: DatabaseSync, terms: readonly string[], fts5: boolean, filter?: RecordFilter): RawHit[];
/**
 * Build an FTS5 MATCH expression from free text. Every term becomes a quoted
 * prefix query so CJK text (which `unicode61` does not segment) still matches
 * inside longer tokens.
 */
export declare function buildMatchQuery(terms: readonly string[]): string | undefined;
/** Split free text into search terms; CJK runs stay whole, ASCII words lowercase. */
export declare function extractTerms(text: string, max?: number): string[];
//# sourceMappingURL=records.d.ts.map