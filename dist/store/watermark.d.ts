/**
 * Text-view export watermark (DESIGN §5.3.1).
 *
 * Writes land in SQLite first and are followed by a synchronous, full-snapshot
 * export to the git-tracked text view. That export can fail (disk full, sandbox
 * denial, the database not open yet) and the failure is only a log line: the
 * mutating tool still reports success. The database is then *ahead* of the text
 * view, and a later `rebuild` — which reads the text view as the recovery
 * source — would delete records that never reached disk, making a transient
 * failure permanent.
 *
 * This module is the cheap detector for that window: every fully successful
 * export records `{ at, records, maxUpdatedAt }` under `meta.last_export`, and
 * callers (`memory_stats`, `rebuild`) compare the store's current shape against
 * it. No sequence numbers are involved — the export is a full snapshot, so the
 * only meaningful comparison is "was anything written after the last snapshot?".
 */
import type { DatabaseSync } from 'node:sqlite';
/** `meta` key holding the last successful export. */
export declare const EXPORT_WATERMARK_KEY = "last_export";
export interface ExportWatermark {
    /** When that export finished (ISO 8601). */
    at: string;
    /** Total records the store held when it finished. */
    records: number;
    /** Newest `updated_at` it covered — the high-water mark of written content. */
    maxUpdatedAt?: string;
}
/** The store's current, comparable shape. */
export interface StoreShape {
    records: number;
    maxUpdatedAt?: string;
}
export type ExportLag = {
    kind: 'empty';
} | {
    kind: 'missing';
    shape: StoreShape;
} | {
    kind: 'fresh';
    watermark: ExportWatermark;
} | {
    kind: 'lagging';
    watermark: ExportWatermark;
    shape: StoreShape;
    unexported: number;
};
/** Record count plus the newest write timestamp. */
export declare function currentShape(db: DatabaseSync): StoreShape;
/**
 * Record a *fully successful* export.
 *
 * Callers must not record a partial one: a watermark that overstates what
 * reached disk would silence exactly the warning this exists to produce.
 */
export declare function recordExport(db: DatabaseSync, at?: string): ExportWatermark;
/** Parse the stored watermark, treating anything malformed as absent. */
export declare function readWatermark(db: DatabaseSync): ExportWatermark | undefined;
/**
 * Compare the store against its last successful export.
 *
 * `lagging` means at least one record is newer than the export or was not part
 * of it — i.e. deleting "records without a lesson file" would now lose data.
 */
export declare function exportLag(db: DatabaseSync): ExportLag;
//# sourceMappingURL=watermark.d.ts.map