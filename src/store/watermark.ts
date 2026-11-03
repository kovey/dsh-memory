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
import type { DatabaseSync } from 'node:sqlite'
import { log } from '../log.js'
import { getMeta, rowNum, rowStr, setMeta } from './sqlite/db.js'
import { countRecords } from './sqlite/records.js'

/** `meta` key holding the last successful export. */
export const EXPORT_WATERMARK_KEY = 'last_export'

export interface ExportWatermark {
    /** When that export finished (ISO 8601). */
    at: string
    /** Total records the store held when it finished. */
    records: number
    /** Newest `updated_at` it covered — the high-water mark of written content. */
    maxUpdatedAt?: string
}

/** The store's current, comparable shape. */
export interface StoreShape {
    records: number
    maxUpdatedAt?: string
}

export type ExportLag =
    | { kind: 'empty' }
    | { kind: 'missing'; shape: StoreShape }
    | { kind: 'fresh'; watermark: ExportWatermark }
    | { kind: 'lagging'; watermark: ExportWatermark; shape: StoreShape; unexported: number }

/** Record count plus the newest write timestamp. */
export function currentShape(db: DatabaseSync): StoreShape {
    const records = countRecords(db).total
    const row = db.prepare('SELECT MAX(updated_at) AS at FROM records').get()
    const maxUpdatedAt = rowStr(row, 'at')
    return { records, ...(maxUpdatedAt !== undefined ? { maxUpdatedAt } : {}) }
}

/**
 * Record a *fully successful* export.
 *
 * Callers must not record a partial one: a watermark that overstates what
 * reached disk would silence exactly the warning this exists to produce.
 */
export function recordExport(db: DatabaseSync, at: string = new Date().toISOString()): ExportWatermark {
    const shape = currentShape(db)
    const watermark: ExportWatermark = {
        at,
        records: shape.records,
        ...(shape.maxUpdatedAt !== undefined ? { maxUpdatedAt: shape.maxUpdatedAt } : {}),
    }
    try {
        setMeta(db, EXPORT_WATERMARK_KEY, JSON.stringify(watermark))
    } catch (error) {
        // Never fail a write because the bookkeeping failed; the worst case is a
        // stale mark, which is the safe direction (it keeps warning).
        log('debug', 'memory: recording the export watermark failed:', error)
    }
    return watermark
}

/** Parse the stored watermark, treating anything malformed as absent. */
export function readWatermark(db: DatabaseSync): ExportWatermark | undefined {
    const raw = getMeta(db, EXPORT_WATERMARK_KEY)
    if (raw === undefined || raw === '') return undefined
    try {
        const parsed = JSON.parse(raw) as Partial<ExportWatermark>
        if (typeof parsed.at !== 'string' || typeof parsed.records !== 'number') return undefined
        return {
            at: parsed.at,
            records: parsed.records,
            ...(typeof parsed.maxUpdatedAt === 'string' ? { maxUpdatedAt: parsed.maxUpdatedAt } : {}),
        }
    } catch {
        return undefined
    }
}

/**
 * Compare the store against its last successful export.
 *
 * `lagging` means at least one record is newer than the export or was not part
 * of it — i.e. deleting "records without a lesson file" would now lose data.
 */
export function exportLag(db: DatabaseSync): ExportLag {
    const shape = currentShape(db)
    if (shape.records === 0) return { kind: 'empty' }
    const watermark = readWatermark(db)
    if (watermark === undefined) return { kind: 'missing', shape }
    const newer = shape.maxUpdatedAt !== undefined && shape.maxUpdatedAt > watermark.at
    if (!newer && shape.records <= watermark.records) return { kind: 'fresh', watermark }
    const written = db.prepare('SELECT COUNT(*) AS n FROM records WHERE updated_at > ?').get(watermark.at)
    const count = Math.max(rowNum(written, 'n') ?? 0, shape.records - watermark.records, 1)
    return { kind: 'lagging', watermark, shape, unexported: count }
}
