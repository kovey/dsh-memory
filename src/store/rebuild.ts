/**
 * Rebuilding a scope's database from its text view (DESIGN §5.3).
 *
 * The SQLite database is a derived artifact: cloning the memory repository onto
 * another machine, or a corrupted index, must both be recoverable from the
 * tracked text alone. Episodes (L1) and the metric ledger are re-imported too,
 * so a rebuild loses nothing that was worth keeping.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { log } from '../log.js'
import { assertInsideScope } from './guard.js'
import { importLessons } from './import.js'
import { importMetrics } from './metrics.js'
import { rebuildFts, transact } from './sqlite/db.js'
import { listRecords } from './sqlite/records.js'
import type { MemoryScope } from './types.js'

export interface RebuildResult {
    root: string
    imported: number
    removed: number
    metrics: number
    episodes: number
    errors: string[]
}

/** Import `<root>/sessions/*.jsonl` rows into the `signals` table. */
export function importEpisodes(db: DatabaseSync, scope: MemoryScope): number {
    const dir = path.join(scope.root, 'sessions')
    assertInsideScope(scope, dir)
    let files: string[]
    try {
        files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    } catch {
        return 0
    }
    let imported = 0
    transact(db, () => {
        // episodes are append-only logs: rebuild them from scratch
        db.prepare('DELETE FROM signals').run()
        const statement = db.prepare(
            'INSERT INTO signals (session_id, turn, step, kind, tool, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        for (const name of files) {
            const sessionFromName = name.slice(11).replace(/\.jsonl$/, '')
            let text: string
            try {
                text = fs.readFileSync(path.join(dir, name), 'utf8')
            } catch {
                continue
            }
            for (const line of text.split('\n')) {
                const trimmed = line.trim()
                if (trimmed === '') continue
                try {
                    const parsed: unknown = JSON.parse(trimmed)
                    if (parsed === null || typeof parsed !== 'object') continue
                    const row = parsed as Record<string, unknown>
                    const kind = typeof row['kind'] === 'string' ? row['kind'] : undefined
                    if (kind === undefined) continue
                    const session = typeof row['session'] === 'string' ? row['session'] : sessionFromName
                    statement.run(
                        session,
                        typeof row['turn'] === 'number' ? row['turn'] : null,
                        typeof row['step'] === 'number' ? row['step'] : null,
                        kind,
                        typeof row['tool'] === 'string' ? row['tool'] : null,
                        typeof row['detail'] === 'string' ? row['detail'] : null,
                        typeof row['at'] === 'string' ? row['at'] : new Date().toISOString(),
                    )
                    imported += 1
                } catch {
                    // a corrupt line must not abort the rebuild
                }
            }
        }
    })
    return imported
}

/**
 * Rebuild one scope from disk: import lessons and metrics, drop records whose
 * lesson file no longer exists, restore episodes, and refresh the search index.
 */
export function rebuildScope(db: DatabaseSync, scope: MemoryScope, fts5: boolean): RebuildResult {
    const result: RebuildResult = { root: scope.root, imported: 0, removed: 0, metrics: 0, episodes: 0, errors: [] }

    const imported = importLessons(db, scope)
    result.imported = imported.imported
    result.errors.push(...imported.errors)

    // Records without a lesson file are derived data that no longer exists.
    const onDisk = new Set<string>()
    try {
        for (const name of fs.readdirSync(path.join(scope.root, 'lessons'))) {
            if (name.endsWith('.md')) onDisk.add(name.slice(0, -3))
        }
    } catch {
        // no lessons directory: everything is stale
    }
    const stale = listRecords(db).filter((record) => !onDisk.has(record.id))
    if (stale.length > 0) {
        transact(db, () => {
            const statement = db.prepare('DELETE FROM records WHERE id = ?')
            for (const record of stale) statement.run(record.id)
        })
        result.removed = stale.length
    }

    try {
        result.metrics = importMetrics(db, scope)
    } catch (error) {
        result.errors.push(`metrics: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
        result.episodes = importEpisodes(db, scope)
    } catch (error) {
        result.errors.push(`episodes: ${error instanceof Error ? error.message : String(error)}`)
    }

    rebuildFts(db, fts5)
    log(
        'info',
        `memory: rebuilt ${scope.root} — imported ${result.imported}, removed ${result.removed}, metrics ${result.metrics}, episodes ${result.episodes}`,
    )
    return result
}

/**
 * Compare two roots' records for equivalence — used to prove that a rebuild
 * from the text view reproduces the same memory (M4 acceptance).
 */
export interface RecordFingerprint {
    id: string
    title: string
    confidence: number
    timesSeen: number
    expiresAt?: string
    bodyHash: number
}

export function fingerprint(db: DatabaseSync): RecordFingerprint[] {
    return listRecords(db)
        .map((record) => ({
            id: record.id,
            title: record.title,
            confidence: Math.round(record.confidence * 1000) / 1000,
            timesSeen: record.timesSeen,
            ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
            bodyHash: hash(record.body),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Stable 32-bit hash for body comparison; collisions are irrelevant here. */
export function hash(text: string): number {
    let value = 0
    for (let i = 0; i < text.length; i += 1) value = (value * 31 + text.charCodeAt(i)) | 0
    return value >>> 0
}
