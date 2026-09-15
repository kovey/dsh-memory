import { DEFAULT_CONFIG } from '../config.js';
import { rowInt, rowStr } from '../store/sqlite/db.js';
/** Age limit: old episodes are history, not work to spend an LLM call on. */
export const PENDING_MAX_AGE_DAYS = 14;
/**
 * Freshness guard for a group that may still be in flight.
 *
 * A distillation call runs for up to `distillTimeoutMs` and only writes its
 * audit row at the end, so for that whole window the group still looks
 * unattempted. The guard is derived from the configured timeout instead of a
 * fixed number of seconds so it always covers one full distillation.
 */
export function pendingMinAgeSeconds(distillTimeoutMs) {
    return Math.ceil(Math.max(0, distillTimeoutMs) / 1_000) + 1;
}
/**
 * Signal groups with no distillation attempt yet, newest first.
 * Read-only; never mutates the store.
 */
export function pendingDistillations(db, options = {}) {
    const limit = Math.max(1, options.limit ?? 3);
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - (options.maxAgeDays ?? PENDING_MAX_AGE_DAYS) * 86_400_000).toISOString();
    const minAgeSeconds = options.minAgeSeconds ?? pendingMinAgeSeconds(options.distillTimeoutMs ?? DEFAULT_CONFIG.learn.distillTimeoutMs);
    const freshCutoff = new Date(now.getTime() - minAgeSeconds * 1_000).toISOString();
    const rows = db
        .prepare(`SELECT s.session_id AS session_id, s.turn AS turn, COUNT(*) AS n, MAX(s.at) AS last_at
             FROM signals s
             LEFT JOIN distill d ON d.session_id = s.session_id AND d.turn = s.turn
             WHERE d.id IS NULL AND s.at >= ? AND s.at <= ? AND s.turn IS NOT NULL
             GROUP BY s.session_id, s.turn
             ORDER BY MAX(s.at) DESC
             LIMIT ?`)
        .all(cutoff, freshCutoff, limit);
    return rows.map((row) => ({
        sessionId: rowStr(row, 'session_id') ?? '',
        turn: rowInt(row, 'turn'),
        signals: rowInt(row, 'n'),
        lastAt: rowStr(row, 'last_at') ?? '',
    }));
}
/** Load the signals of one pending group, oldest first. */
export function loadGroupSignals(db, group) {
    const rows = db
        .prepare('SELECT session_id, turn, step, kind, tool, detail, at FROM signals WHERE session_id = ? AND turn = ? ORDER BY at ASC')
        .all(group.sessionId, group.turn);
    return rows.map((row) => {
        const step = rowInt(row, 'step', Number.NaN);
        const tool = rowStr(row, 'tool');
        const detail = rowStr(row, 'detail');
        return {
            sessionId: rowStr(row, 'session_id') ?? group.sessionId,
            turn: rowInt(row, 'turn', group.turn),
            kind: (rowStr(row, 'kind') ?? 'tool-failure'),
            ...(Number.isFinite(step) ? { step } : {}),
            ...(tool !== undefined ? { tool } : {}),
            ...(detail !== undefined ? { detail } : {}),
            at: rowStr(row, 'at') ?? new Date().toISOString(),
        };
    });
}
//# sourceMappingURL=pending.js.map