/**
 * Recall bookkeeping (DESIGN §6, §7): every injection is recorded so the
 * learning loop can later tell whether a memory actually paid off.
 */
import type { DatabaseSync } from 'node:sqlite';
export interface UsageRow {
    recordId: string;
    sessionId?: string;
    turn?: number;
    step?: number;
    score: number;
}
/** Record injections and bump each record's recall counter. */
export declare function recordRecalls(db: DatabaseSync, rows: readonly UsageRow[], at?: string): number;
/**
 * Attribute an outcome to every record injected into one session's turn range.
 * M2 calls this when a turn carries pain signals; success raises the usage
 * weight, failure lowers it (the negative feedback of DESIGN §7).
 */
/**
 * Attribute an outcome and apply DESIGN §7's feedback to the records involved.
 *
 * A memory that keeps being recalled into failing turns must lose confidence —
 * that is the only mechanism that separates "useful memory" from "plausible
 * noise". The penalty is applied here, once per observed failure, because
 * `mergeRecord` no longer re-derives confidence.
 */
export declare function applyOutcome(db: DatabaseSync, sessionId: string, outcome: 'success' | 'failure', turn?: number): number;
export declare function attributeOutcome(db: DatabaseSync, sessionId: string, outcome: 'success' | 'failure', turn?: number): number;
export interface RecallStats {
    injections: number;
    attributed: number;
    success: number;
    failure: number;
}
/** Recall statistics for `memory_stats`. */
export declare function recallStats(db: DatabaseSync): RecallStats;
//# sourceMappingURL=usage.d.ts.map