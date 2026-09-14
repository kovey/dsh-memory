/**
 * Recall bookkeeping (DESIGN §6, §7): every injection is recorded so the
 * learning loop can later tell whether a memory actually paid off.
 */
import type { DatabaseSync } from 'node:sqlite'
import { transact } from '../store/sqlite/db.js'

export interface UsageRow {
    recordId: string
    sessionId?: string
    turn?: number
    step?: number
    score: number
}

/** Record injections and bump each record's recall counter. */
export function recordRecalls(db: DatabaseSync, rows: readonly UsageRow[], at = new Date().toISOString()): number {
    if (rows.length === 0) return 0
    transact(db, () => {
        const insert = db.prepare(
            'INSERT INTO usage (record_id, session_id, turn, step, score, injected_at, outcome) VALUES (?, ?, ?, ?, ?, ?, NULL)',
        )
        const bump = db.prepare('UPDATE records SET times_recalled = times_recalled + 1 WHERE id = ?')
        for (const row of rows) {
            insert.run(row.recordId, row.sessionId ?? null, row.turn ?? null, row.step ?? null, row.score, at)
            bump.run(row.recordId)
        }
    })
    return rows.length
}

/**
 * Attribute an outcome to every record injected into one session's turn range.
 * M2 calls this when a turn carries pain signals; success raises the usage
 * weight, failure lowers it (the negative feedback of DESIGN §7).
 */
export function attributeOutcome(
    db: DatabaseSync,
    sessionId: string,
    outcome: 'success' | 'failure',
    turn?: number,
): number {
    const rows = turn === undefined
        ? db.prepare('SELECT id, record_id FROM usage WHERE session_id = ? AND outcome IS NULL').all(sessionId)
        : db
              .prepare('SELECT id, record_id FROM usage WHERE session_id = ? AND outcome IS NULL AND turn = ?')
              .all(sessionId, turn)
    if (rows.length === 0) return 0
    transact(db, () => {
        const setOutcome = db.prepare('UPDATE usage SET outcome = ? WHERE id = ?')
        const bumpSuccess = db.prepare('UPDATE records SET success_after_recall = success_after_recall + 1 WHERE id = ?')
        const bumpFailure = db.prepare('UPDATE records SET fail_after_recall = fail_after_recall + 1 WHERE id = ?')
        for (const row of rows) {
            const id = row['id']
            const recordId = row['record_id']
            if (typeof id !== 'number' && typeof id !== 'bigint') continue
            if (typeof recordId !== 'string') continue
            setOutcome.run(outcome, id)
            if (outcome === 'success') bumpSuccess.run(recordId)
            else bumpFailure.run(recordId)
        }
    })
    return rows.length
}

export interface RecallStats {
    injections: number
    attributed: number
    success: number
    failure: number
}

/** Recall statistics for `memory_stats`. */
export function recallStats(db: DatabaseSync): RecallStats {
    const row = db
        .prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) AS attributed,
                    SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success,
                    SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failure
             FROM usage`,
        )
        .get()
    const num = (key: string): number => {
        const value = row?.[key]
        if (typeof value === 'number') return value
        if (typeof value === 'bigint') return Number(value)
        return 0
    }
    return {
        injections: num('total'),
        attributed: num('attributed'),
        success: num('success'),
        failure: num('failure'),
    }
}
