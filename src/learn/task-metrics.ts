/**
 * Automatic task-metric recording (DESIGN §7 "turn/end → 指标入账", §11 M5 ledger).
 *
 * The ledger is shared with the pre-existing file workflow: `metrics.jsonl` is
 * still the git-tracked view, and the `tasks` table is what the regression gate
 * reads. Until now only *imports* happened — the plugin never wrote a row of its
 * own, so a session's outcome/rework/lessons never reached the gate.
 *
 * A row is only written for a session that actually did work (at least one turn),
 * so boot-only sessions do not pollute the ledger.
 */
import type { DatabaseSync } from 'node:sqlite'
import { log } from '../log.js'
import type { MemoryScope } from '../store/types.js'
import { appendMetric } from '../store/metrics.js'
import type { TaskMetric } from '../store/metrics.js'

export interface SessionStats {
    sessionId: string
    /** Epoch ms when the session was first observed. */
    startedAt?: number
    /** Highest turn number observed. */
    turns: number
    /** Tool calls observed in this session. */
    toolCalls: number
    /** Pain signals of any kind. */
    signals: number
    /** `rework` signals — the same tool failing twice in one turn. */
    rework: number
    /** User corrections — the closest observable proxy for "disturbed the human". */
    corrections: number
}

export interface SessionLedgerRow {
    taskId: string
    date: string
    project: string
    summary: string
    outcome: 'success' | 'partial' | 'failed'
    durationMin: number
    disturbCount: number
    reworkRounds: number
    lessons: number
    tokens: number
}

/** Read the per-session aggregates the ledger needs from the store. */
export function sessionStats(db: DatabaseSync, stats: SessionStats): SessionStats {
    const signals = db
        .prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN kind = 'rework' THEN 1 ELSE 0 END) AS rework, SUM(CASE WHEN kind = 'user-correction' THEN 1 ELSE 0 END) AS corrections FROM signals WHERE session_id = ?")
        .get(stats.sessionId)
    const num = (key: string): number => {
        const value = signals?.[key]
        return typeof value === 'number' ? value : 0
    }
    return { ...stats, signals: num('n'), rework: num('rework'), corrections: num('corrections') }
}

/**
 * Turn one session's aggregates into a ledger row.
 *
 * Outcomes are derived conservatively: any pain signal means the session did not
 * go cleanly (`failed`), a session that did work with no signals is `success`,
 * and a session that barely ran is `partial`. Disturb counts what can be
 * observed (user corrections); permission prompts are not visible to a plugin.
 */
export function buildLedgerRow(stats: SessionStats, now = new Date()): SessionLedgerRow | undefined {
    if (stats.turns <= 0) return undefined
    const durationMin = stats.startedAt !== undefined ? Math.max(0, Math.round((now.getTime() - stats.startedAt) / 60_000)) : 0
    const outcome: SessionLedgerRow['outcome'] =
        stats.signals > 0 ? 'failed' : stats.toolCalls > 0 ? 'success' : 'partial'
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
    }
}

/** Fill in the learning counters recorded in the `distill` audit table. */
export function withLearningCounters(db: DatabaseSync, row: SessionLedgerRow, sessionId: string): SessionLedgerRow {
    const audit = db
        .prepare('SELECT COALESCE(SUM(created_count), 0) AS created, COALESCE(SUM(COALESCE(tokens_in,0) + COALESCE(tokens_out,0)), 0) AS tokens FROM distill WHERE session_id = ?')
        .get(sessionId)
    const num = (key: string): number => {
        const value = audit?.[key]
        return typeof value === 'number' ? value : 0
    }
    return { ...row, lessons: num('created'), tokens: num('tokens') }
}

/** Write the row to the store and to the git-tracked `metrics.jsonl` view. */
export function recordSessionMetric(db: DatabaseSync, scope: MemoryScope, row: SessionLedgerRow): void {
    const metric: TaskMetric = {
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
    }
    try {
        appendMetric(db, scope, metric)
    } catch (error) {
        log('warn', 'memory: task metric write failed:', error)
    }
}
