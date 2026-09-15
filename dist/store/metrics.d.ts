import type { DatabaseSync } from 'node:sqlite';
import type { MemoryScope } from './types.js';
export interface TaskMetric {
    task_id: string;
    date?: string;
    project?: string;
    summary?: string;
    outcome?: string;
    duration_min?: number | null;
    disturb_count?: number | null;
    rework_rounds?: number | null;
    lessons?: number | null;
    tokens?: number | null;
}
export declare function metricsFile(scope: MemoryScope): string;
/** Load a JSONL metric ledger into the database (idempotent by task_id). */
export declare function importMetrics(db: DatabaseSync, scope: MemoryScope): number;
/**
 * Append one metric row to both the database and the JSONL view.
 *
 * The view is upserted by `task_id` rather than appended blindly: the same task
 * is reported more than once (a session is resumed, a ledger row is refreshed),
 * and an append-only file grew one line per report for the same task.
 */
export declare function appendMetric(db: DatabaseSync, scope: MemoryScope, metric: TaskMetric): void;
/**
 * Rewrite the JSONL view from the database, deduplicated by `task_id`.
 *
 * One line per task: a database row replaces the line it supersedes *in place*
 * (so the file keeps its history order and produces a one-line diff), rows the
 * file does not have are appended, and a line whose `task_id` the database does
 * not know — written by hand, or by another machine's ledger that has not been
 * imported yet — is kept verbatim. Losing those would turn an export into a
 * silent delete of somebody else's record.
 */
export declare function exportMetrics(db: DatabaseSync, scope: MemoryScope): number;
export interface MetricSummary {
    tasks: number;
    success: number;
    partial: number;
    failed: number;
    avgDurationMin: number | null;
    avgDisturb: number | null;
    avgRework: number | null;
    lessons: number;
}
/** Aggregate the ledger for `memory_stats` (DESIGN §11 M5). */
export declare function summarizeMetrics(db: DatabaseSync): MetricSummary;
//# sourceMappingURL=metrics.d.ts.map