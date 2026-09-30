import type { DatabaseSync } from 'node:sqlite';
import type { MemoryConfig } from '../config.js';
import type { MetricSummary } from '../store/metrics.js';
import type { MemoryScope } from '../store/types.js';
/** One entry of the "基线任务集" section of baseline.md. */
export interface BaselineTask {
    index: number;
    name: string;
    project?: string;
    requirement?: string;
    acceptance?: string[];
}
export interface ParsedBaseline {
    title: string;
    metrics: {
        field: string;
        meaning: string;
        collection: string;
    }[];
    tasks: BaselineTask[];
    /** Section names found, so a caller can tell a wrong file from an empty one. */
    sections: string[];
}
/** Parse `baseline.md` (task list + metric table). Tolerant by design. */
export declare function parseBaseline(markdown: string): ParsedBaseline;
/** Read and parse the baseline document of a scope, when it exists. */
export declare function readBaseline(scope: MemoryScope): ParsedBaseline | undefined;
export interface MetricSnapshot {
    at: string;
    tasks: number;
    successRate: number | null;
    avgDuration: number | null;
    avgDisturb: number | null;
    avgRework: number | null;
    note?: string;
}
/** Compute the four gate metrics from the task ledger. */
export declare function snapshotMetrics(db: DatabaseSync, at?: Date, note?: string): MetricSnapshot;
/** Freeze the current metrics as the baseline to compare against. */
export declare function freezeBaseline(db: DatabaseSync, scopeLabel: string, note?: string, at?: Date): MetricSnapshot;
/** Most recent snapshot, or undefined when the gate has no reference yet. */
export declare function latestBaseline(db: DatabaseSync): MetricSnapshot | undefined;
/**
 * Task-ledger rows that actually carry one of the four gate metrics.
 *
 * A row with only `task_id`/`date`/`summary` and no outcome, duration, disturb
 * or rework value cannot be compared by the gate, so it must not count towards
 * the "enough data to freeze" threshold: freezing on such rows would only
 * produce a snapshot whose four metrics are `null`, i.e. a permanently UNKNOWN
 * gate wearing the appearance of a calibrated one.
 */
export declare function metricTaskCount(db: DatabaseSync): number;
/**
 * Why the current window may not be frozen automatically, or `undefined` when it
 * is healthy enough.
 *
 * The frozen snapshot is what every later period is judged against, so freezing
 * a bad period inverts the gate: a 12% success rate with 6.1 rework rounds per
 * task becomes "normal", and every later — genuinely better — period reads as a
 * regression or a pass. DESIGN §11 makes a freeze a human calibration step after
 * a *good* period; an automatic freeze therefore has to prove the period is good.
 *
 * A metric that carries no data does not pass either: "no success rate recorded"
 * is not evidence of a healthy window, it is the absence of evidence.
 */
export declare function qualityGateFailure(snapshot: MetricSnapshot, config: MemoryConfig): string | undefined;
/**
 * Freeze the first baseline automatically, when the user asked for it
 * (`eval.autoFreezeBaseline`), the ledger has enough comparable rows, and the
 * window passes the quality gate.
 *
 * This is the escape hatch from the gate's permanent-UNKNOWN state: with no
 * snapshot the gate can only ever answer UNKNOWN, which is exactly the state the
 * live store was in. Three guards matter:
 *
 *   - an existing snapshot is never replaced (idempotent) — refreezing is how a
 *     regression signal gets erased, and `setBaseline` already requires a human
 *     reason for that reason;
 *   - no data means no freeze, so the gate never pretends to have a reference;
 *   - a window that fails the quality gate is *not* written: the automatic path
 *     stays quiet and only hints, leaving the freeze to the human step it was
 *     always meant to be.
 *
 * Returns the frozen snapshot, or undefined when nothing was frozen.
 */
export declare function maybeFreezeBaseline(db: DatabaseSync, scope: MemoryScope, config: MemoryConfig, now?: Date): MetricSnapshot | undefined;
/**
 * How old a snapshot may get before the report calls it stale, as a multiple of
 * `eval.windowDays`. Three windows is the point where the reference describes a
 * system that no longer exists rather than a period that was measured.
 */
export declare const STALE_BASELINE_WINDOW_MULTIPLE = 3;
export interface BaselineHealthReport {
    /** Whether the *frozen snapshot itself* would pass the freeze quality gate. */
    healthy: boolean;
    /** Gate violations of that snapshot, worded like the freeze gate's own refusal. */
    failures: string[];
    /** Age of the snapshot in whole days; `null` when its timestamp is unreadable. */
    ageDays: number | null;
    /** Older than `eval.windowDays` × `STALE_BASELINE_WINDOW_MULTIPLE`. */
    stale: boolean;
    staleAfterDays: number;
    windowDays: number;
    /** `eval.autoRepairUnhealthyBaseline` — whether a replacement may happen at all. */
    autoRepair: boolean;
    /**
     * Set when auto-repair is on but this call left the snapshot in place: the
     * reason travels into the report, so "nothing happened" is never silent.
     */
    autoRepairBlocked?: string;
}
/**
 * Judge the snapshot the gate is comparing against.
 *
 * This is the gap the quality gate left open: it only ever looked at the window
 * *about to be frozen*. A snapshot that was already in the table — frozen before
 * the gate existed, or by hand — was never re-examined, so a period with a 12%
 * success rate could sit in the reference position forever and turn every later
 * comparison into a rubber stamp. Detection is read-only; replacing it is
 * `repairUnhealthyBaseline` and needs `eval.autoRepairUnhealthyBaseline`.
 *
 * A metric that carries no data does not pass here either: `null` on the
 * reference side means the gate cannot compare that metric at all.
 */
export declare function assessBaselineHealth(baseline: MetricSnapshot, config: MemoryConfig, now?: Date): BaselineHealthReport;
export interface BaselineRepairReport {
    replaced: boolean;
    /** The unhealthy snapshot that was retired, when there was one. */
    previous?: MetricSnapshot;
    /** The healthy snapshot that now holds the reference position. */
    snapshot?: MetricSnapshot;
    /** Why the reference was left alone; always set when `replaced` is false. */
    skipped?: string;
    /** Task-ledger rows carrying a gate metric, when the threshold was consulted. */
    metricTasks?: number;
}
/**
 * Replace a snapshot that fails the quality gate, when the user asked for it
 * (`eval.autoRepairUnhealthyBaseline`) *and* the current window is healthy.
 *
 * `maybeFreezeBaseline` is idempotent by design — an existing snapshot is never
 * replaced, because refreezing is how a regression signal gets erased. That left
 * the opposite hole: a snapshot frozen from a bad period (the live store had
 * `success_rate 0.122 / avg_rework 6.12`) had no detection and no repair path, so
 * the gate kept comparing against it and a genuine regression read as PASS.
 *
 * Three conditions, all required, in this order:
 *
 *   1. the snapshot in the table fails the same quality gate;
 *   2. the *current* window passes it — a repair must never freeze a bad window
 *      in place of a bad snapshot (that would just launder the same mistake);
 *   3. the ledger has at least `eval.proposeFreezeAfterTasks` task metrics, so the
 *      replacement is not a snapshot of noise either.
 *
 * Atomicity and concurrency: the retiring `DELETE` and the new `INSERT` run in one
 * `transact` block. `node:sqlite`'s `DatabaseSync` is synchronous, so no other
 * statement of this process can interleave; other processes are serialized by
 * SQLite's write lock (WAL + `busy_timeout`), and a failing `BEGIN`/`COMMIT`
 * leaves the old row exactly as it was. Every row is deleted rather than only the
 * newest one: `latestBaseline` reads the newest row, so leaving an older row
 * behind would silently promote an even staler snapshot into the reference
 * position. The retired values stay auditable — they are quoted in the new row's
 * `note` and in the log line.
 *
 * A write error is caught and reported as a skip: a stats read must not fail
 * because the audit trail could not be updated.
 */
export declare function repairUnhealthyBaseline(db: DatabaseSync, scope: MemoryScope, config: MemoryConfig, now?: Date): BaselineRepairReport;
export type MetricVerdict = 'better' | 'same' | 'worse' | 'unknown';
/**
 * Three-state gate. `unknown` is the *absence* of a judgement, not a pass:
 * a gate that cannot compare anything must never read as "no regression".
 */
export type GateVerdict = 'pass' | 'regression' | 'unknown';
export interface MetricComparison {
    metric: 'successRate' | 'avgDuration' | 'avgDisturb' | 'avgRework';
    label: string;
    /** `up` means a higher value is better. */
    direction: 'up' | 'down';
    baseline: number | null;
    current: number | null;
    delta: number | null;
    verdict: MetricVerdict;
}
export interface GateReport {
    verdict: GateVerdict;
    baseline?: MetricSnapshot;
    current: MetricSnapshot;
    comparisons: MetricComparison[];
    regressed: string[];
    /** Why the verdict is `unknown`; absent whenever the gate actually decided. */
    unknownReason?: 'no-baseline' | 'no-comparable-metrics';
}
/** Tolerance so noise in a small ledger does not read as a regression. */
export declare const TOLERANCE: {
    successRate: number;
    duration: number;
    disturb: number;
    rework: number;
};
/**
 * Compare current metrics against the frozen baseline. The gate is asymmetric on
 * purpose: regressions fail it, improvements pass it, and missing data is
 * "unknown" rather than a silent pass.
 *
 * `pass` therefore needs at least one comparison that actually had data on both
 * sides; a baseline whose four metrics are all `null` (or a current window with
 * no metrics yet) is `unknown`, never `pass`.
 */
export declare function evaluateGate(current: MetricSnapshot, baseline: MetricSnapshot | undefined): GateReport;
export interface HealthDigest {
    injections: number;
    attributed: number;
    successAfterRecall: number;
    failureAfterRecall: number;
    /** Share of attributed recalls that ended in a successful turn. */
    recallHitRate: number | null;
    pending: number;
    active: number;
    archived: number;
    expired: number;
    conflicts: number;
    proposals: number;
    episodes: number;
    distillRuns: number;
    distillTokens: number;
    distillTimeouts: number;
}
/** Memory-quality indicators (DESIGN §11 M5). */
export declare function healthDigest(db: DatabaseSync, sinceDays?: number): HealthDigest;
/** Which metric the trend covers. */
export interface TrendWindow {
    days: number;
    from: string;
    to: string;
    summary: MetricSummary;
}
export declare function windowSummary(db: DatabaseSync, days: number, offsetDays?: number, now?: Date): TrendWindow;
/**
 * How close the task ledger is to a freezable baseline. Rendered next to the
 * UNKNOWN verdict so a model reading `memory_stats` can tell "no data yet"
 * (keep working) from "enough data, nobody froze it" (ask the user).
 */
export interface BaselineProgress {
    /** Task-ledger rows carrying at least one gate metric (see `metricTaskCount`). */
    metricTasks: number;
    /** `eval.proposeFreezeAfterTasks` — the floor below which a baseline is noise. */
    threshold: number;
    /** `eval.windowDays` — the window the gate compares over. */
    windowDays: number;
    /** `eval.autoFreezeBaseline` — says whether anyone will freeze it automatically. */
    autoFreeze: boolean;
    /**
     * Set when the configured quality gate would block that automatic freeze.
     *
     * Without it the report promises "the next memory_stats call freezes it
     * without asking" for a window the freeze path will refuse, which is exactly
     * the kind of rubber-stamp claim the gate exists to prevent.
     */
    autoFreezeBlocked?: string;
}
/** Render the gate + health report for `memory_stats`. */
export declare function renderEvaluation(gate: GateReport, health: HealthDigest, trend: {
    current: TrendWindow;
    previous: TrendWindow;
}, baselineTasks: readonly BaselineTask[], progress?: BaselineProgress, baselineHealth?: BaselineHealthReport): string[];
//# sourceMappingURL=baseline.d.ts.map