import { log } from '../log.js';
import { getMeta, rowNum, rowStr, setMeta } from './sqlite/db.js';
import { countRecords } from './sqlite/records.js';
/** `meta` key holding the last successful export. */
export const EXPORT_WATERMARK_KEY = 'last_export';
/** Record count plus the newest write timestamp. */
export function currentShape(db) {
    const records = countRecords(db).total;
    const row = db.prepare('SELECT MAX(updated_at) AS at FROM records').get();
    const maxUpdatedAt = rowStr(row, 'at');
    return { records, ...(maxUpdatedAt !== undefined ? { maxUpdatedAt } : {}) };
}
/**
 * Record a *fully successful* export.
 *
 * Callers must not record a partial one: a watermark that overstates what
 * reached disk would silence exactly the warning this exists to produce.
 */
export function recordExport(db, at = new Date().toISOString()) {
    const shape = currentShape(db);
    const watermark = {
        at,
        records: shape.records,
        ...(shape.maxUpdatedAt !== undefined ? { maxUpdatedAt: shape.maxUpdatedAt } : {}),
    };
    try {
        setMeta(db, EXPORT_WATERMARK_KEY, JSON.stringify(watermark));
    }
    catch (error) {
        // Never fail a write because the bookkeeping failed; the worst case is a
        // stale mark, which is the safe direction (it keeps warning).
        log('debug', 'memory: recording the export watermark failed:', error);
    }
    return watermark;
}
/** Parse the stored watermark, treating anything malformed as absent. */
export function readWatermark(db) {
    const raw = getMeta(db, EXPORT_WATERMARK_KEY);
    if (raw === undefined || raw === '')
        return undefined;
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.at !== 'string' || typeof parsed.records !== 'number')
            return undefined;
        return {
            at: parsed.at,
            records: parsed.records,
            ...(typeof parsed.maxUpdatedAt === 'string' ? { maxUpdatedAt: parsed.maxUpdatedAt } : {}),
        };
    }
    catch {
        return undefined;
    }
}
/**
 * Compare the store against its last successful export.
 *
 * `lagging` means at least one record is newer than the export or was not part
 * of it — i.e. deleting "records without a lesson file" would now lose data.
 */
export function exportLag(db) {
    const shape = currentShape(db);
    if (shape.records === 0)
        return { kind: 'empty' };
    const watermark = readWatermark(db);
    if (watermark === undefined)
        return { kind: 'missing', shape };
    const newer = shape.maxUpdatedAt !== undefined && shape.maxUpdatedAt > watermark.at;
    if (!newer && shape.records <= watermark.records)
        return { kind: 'fresh', watermark };
    const written = db.prepare('SELECT COUNT(*) AS n FROM records WHERE updated_at > ?').get(watermark.at);
    const count = Math.max(rowNum(written, 'n') ?? 0, shape.records - watermark.records, 1);
    return { kind: 'lagging', watermark, shape, unexported: count };
}
//# sourceMappingURL=watermark.js.map