import type { DatabaseSync } from 'node:sqlite';
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
/** Render the gate + health report for `memory_stats`. */
export declare function renderEvaluation(gate: GateReport, health: HealthDigest, trend: {
    current: TrendWindow;
    previous: TrendWindow;
}, baselineTasks: readonly BaselineTask[]): string[];
//# sourceMappingURL=baseline.d.ts.map