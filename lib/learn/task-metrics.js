import { log } from '../log.js';
import { appendMetric } from '../store/metrics.js';
/** Read the per-session aggregates the ledger needs from the store. */
export function sessionStats(db, stats) {
    const signals = db
        .prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN kind = 'rework' THEN 1 ELSE 0 END) AS rework, SUM(CASE WHEN kind = 'user-correction' THEN 1 ELSE 0 END) AS corrections FROM signals WHERE session_id = ?")
        .get(stats.sessionId);
    const num = (key) => {
        const value = signals?.[key];
        return typeof value === 'number' ? value : 0;
    };
    return { ...stats, signals: num('n'), rework: num('rework'), corrections: num('corrections') };
}
/**
 * Turn one session's aggregates into a ledger row.
 *
 * Outcomes are derived conservatively: any pain signal means the session did not
 * go cleanly (`failed`), a session that did work with no signals is `success`,
 * and a session that barely ran is `partial`. Disturb counts what can be
 * observed (user corrections); permission prompts are not visible to a plugin.
 */
export function buildLedgerRow(stats, now = new Date()) {
    if (stats.turns <= 0)
        return undefined;
    const durationMin = stats.startedAt !== undefined ? Math.max(0, Math.round((now.getTime() - stats.startedAt) / 60_000)) : 0;
    const outcome = stats.signals > 0 ? 'failed' : stats.toolCalls > 0 ? 'success' : 'partial';
    return {
        taskId: `s-${now.toISOString().slice(0, 10)}-${stats.sessionId.slice(-8)}`,
        date: now.toISOString().slice(0, 10),
        project: 'session',
        summary: `auto: ${stats.turns} turn(s), ${stats.toolCalls} tool call(s), ${stats.signals} signal(s)`,
        outcome,
        durationMin,
        disturbCount: stats.corrections,
        reworkRounds: stats.rework,
        lessons: 0,
        tokens: 0,
    };
}
/** Fill in the learning counters recorded in the `distill` audit table. */
export function withLearningCounters(db, row, sessionId) {
    const audit = db
        .prepare('SELECT COALESCE(SUM(created_count), 0) AS created, COALESCE(SUM(COALESCE(tokens_in,0) + COALESCE(tokens_out,0)), 0) AS tokens FROM distill WHERE session_id = ?')
        .get(sessionId);
    const num = (key) => {
        const value = audit?.[key];
        return typeof value === 'number' ? value : 0;
    };
    return { ...row, lessons: num('created'), tokens: num('tokens') };
}
/** Write the row to the store and to the git-tracked `metrics.jsonl` view. */
export function recordSessionMetric(db, scope, row) {
    const metric = {
        task_id: row.taskId,
        date: row.date,
        project: row.project,
        summary: row.summary,
        outcome: row.outcome,
        duration_min: row.durationMin,
        disturb_count: row.disturbCount,
        rework_rounds: row.reworkRounds,
        lessons: row.lessons,
        tokens: row.tokens,
    };
    try {
        appendMetric(db, scope, metric);
    }
    catch (error) {
        log('warn', 'memory: task metric write failed:', error);
    }
}
//# sourceMappingURL=task-metrics.js.map