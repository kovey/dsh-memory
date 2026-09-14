/**
 * Recovery for signals that were collected but never distilled (DESIGN §7).
 *
 * Two ways a turn's pain signals end up undistilled:
 *   - `distillRunner: 'jobs'` on a one-shot surface: the agent is disposed right
 *     after the turn, which cancels its jobs before the LLM call even starts;
 *   - the process simply died mid-distillation.
 *
 * L1 is the durable record, so recovery is a query: signals with no matching
 * `distill` audit row are pending work. Retrying is safe because an *attempt* —
 * anything that passed `distillAllowed` and reached the model call, including a
 * timeout and a failure while writing the candidates — always writes an audit
 * row, so a group is picked up at most until it produces its first attempt.
 *
 * The two kinds of skip are deliberately different and this query is where the
 * difference lives:
 *   - a group that never passed the gate (distillation off, no route, budget
 *     exhausted) spent nothing and wrote nothing, so it stays pending and a
 *     later turn may still distil it;
 *   - a group that was attempted is settled by its audit row, even when that
 *     row says `created_count: 0` (all candidates rejected, timed out, failed).
 */
import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_CONFIG } from '../config.js'
import { rowInt, rowStr } from '../store/sqlite/db.js'
import type { Signal } from './signals.js'

export interface PendingGroup {
    sessionId: string
    turn: number
    signals: number
    lastAt: string
}

/** Age limit: old episodes are history, not work to spend an LLM call on. */
export const PENDING_MAX_AGE_DAYS = 14

/**
 * Freshness guard for a group that may still be in flight.
 *
 * A distillation call runs for up to `distillTimeoutMs` and only writes its
 * audit row at the end, so for that whole window the group still looks
 * unattempted. The guard is derived from the configured timeout instead of a
 * fixed number of seconds so it always covers one full distillation.
 */
export function pendingMinAgeSeconds(distillTimeoutMs: number): number {
    return Math.ceil(Math.max(0, distillTimeoutMs) / 1_000) + 1
}

export interface PendingOptions {
    limit?: number
    maxAgeDays?: number
    now?: Date
    /**
     * Signals younger than this are treated as belonging to a turn that may
     * still be running (its own turn-stopping will handle them).
     */
    minAgeSeconds?: number
    /**
     * Configured `learn.distillTimeoutMs`; used to derive `minAgeSeconds` when
     * the caller does not name one.
     */
    distillTimeoutMs?: number
}

/**
 * Signal groups with no distillation attempt yet, newest first.
 * Read-only; never mutates the store.
 */
export function pendingDistillations(db: DatabaseSync, options: PendingOptions = {}): PendingGroup[] {
    const limit = Math.max(1, options.limit ?? 3)
    const now = options.now ?? new Date()
    const cutoff = new Date(now.getTime() - (options.maxAgeDays ?? PENDING_MAX_AGE_DAYS) * 86_400_000).toISOString()
    const minAgeSeconds =
        options.minAgeSeconds ?? pendingMinAgeSeconds(options.distillTimeoutMs ?? DEFAULT_CONFIG.learn.distillTimeoutMs)
    const freshCutoff = new Date(now.getTime() - minAgeSeconds * 1_000).toISOString()
    const rows = db
        .prepare(
            `SELECT s.session_id AS session_id, s.turn AS turn, COUNT(*) AS n, MAX(s.at) AS last_at
             FROM signals s
             LEFT JOIN distill d ON d.session_id = s.session_id AND d.turn = s.turn
             WHERE d.id IS NULL AND s.at >= ? AND s.at <= ? AND s.turn IS NOT NULL
             GROUP BY s.session_id, s.turn
             ORDER BY MAX(s.at) DESC
             LIMIT ?`,
        )
        .all(cutoff, freshCutoff, limit)
    return rows.map((row) => ({
        sessionId: rowStr(row, 'session_id') ?? '',
        turn: rowInt(row, 'turn'),
        signals: rowInt(row, 'n'),
        lastAt: rowStr(row, 'last_at') ?? '',
    }))
}

/** Load the signals of one pending group, oldest first. */
export function loadGroupSignals(db: DatabaseSync, group: PendingGroup): Signal[] {
    const rows = db
        .prepare(
            'SELECT session_id, turn, step, kind, tool, detail, at FROM signals WHERE session_id = ? AND turn = ? ORDER BY at ASC',
        )
        .all(group.sessionId, group.turn)
    return rows.map((row) => {
        const step = rowInt(row, 'step', Number.NaN)
        const tool = rowStr(row, 'tool')
        const detail = rowStr(row, 'detail')
        return {
            sessionId: rowStr(row, 'session_id') ?? group.sessionId,
            turn: rowInt(row, 'turn', group.turn),
            kind: (rowStr(row, 'kind') ?? 'tool-failure') as Signal['kind'],
            ...(Number.isFinite(step) ? { step } : {}),
            ...(tool !== undefined ? { tool } : {}),
            ...(detail !== undefined ? { detail } : {}),
            at: rowStr(row, 'at') ?? new Date().toISOString(),
        }
    })
}
