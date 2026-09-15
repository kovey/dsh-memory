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
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryScope } from '../store/types.js';
export interface SessionStats {
    sessionId: string;
    /** Epoch ms when the session was first observed. */
    startedAt?: number;
    /** Highest turn number observed. */
    turns: number;
    /** Tool calls observed in this session. */
    toolCalls: number;
    /** Pain signals of any kind. */
    signals: number;
    /** `rework` signals — the same tool failing twice in one turn. */
    rework: number;
    /** User corrections — the closest observable proxy for "disturbed the human". */
    corrections: number;
}
export interface SessionLedgerRow {
    taskId: string;
    date: string;
    project: string;
    summary: string;
    outcome: 'success' | 'partial' | 'failed';
    durationMin: number;
    disturbCount: number;
    reworkRounds: number;
    lessons: number;
    tokens: number;
}
/** Read the per-session aggregates the ledger needs from the store. */
export declare function sessionStats(db: DatabaseSync, stats: SessionStats): SessionStats;
/**
 * Turn one session's aggregates into a ledger row.
 *
 * Outcomes are derived conservatively: any pain signal means the session did not
 * go cleanly (`failed`), a session that did work with no signals is `success`,
 * and a session that barely ran is `partial`. Disturb counts what can be
 * observed (user corrections); permission prompts are not visible to a plugin.
 */
export declare function buildLedgerRow(stats: SessionStats, now?: Date): SessionLedgerRow | undefined;
/** Fill in the learning counters recorded in the `distill` audit table. */
export declare function withLearningCounters(db: DatabaseSync, row: SessionLedgerRow, sessionId: string): SessionLedgerRow;
/** Write the row to the store and to the git-tracked `metrics.jsonl` view. */
export declare function recordSessionMetric(db: DatabaseSync, scope: MemoryScope, row: SessionLedgerRow): void;
//# sourceMappingURL=task-metrics.d.ts.map