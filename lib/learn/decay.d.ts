/**
 * Forgetting (DESIGN §8): decay and archive.
 *
 * A store that only grows gets worse — stale confidence inflates ranking and
 * eventually misleads recall. Decay is applied *once per consolidation run* for
 * the elapsed interval (never per record age, which would compound), and
 * archiving moves records to `archive/lessons/` instead of deleting them, so a
 * wrong decision stays reviewable.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryRecord, MemoryScope } from '../store/types.js';
/** Half-life of confidence with no reinforcing evidence. */
export declare const DECAY_HALF_LIFE_DAYS = 180;
/** Never decay more than this fraction in one run. */
export declare const MAX_DECAY_PER_RUN = 0.5;
/** Minimum gap between decay runs. */
export declare const MIN_DECAY_INTERVAL_DAYS = 7;
/** Pending records untouched for this long (and never recalled) are archived. */
export declare const STALE_PENDING_DAYS = 60;
/** Pending records below this confidence are considered noise. */
export declare const STALE_PENDING_CONFIDENCE = 0.55;
export interface DecayPlan {
    /** Records to archive, with the rule that matched. */
    archive: {
        record: MemoryRecord;
        reason: string;
    }[];
    /** Factor applied to every surviving record (1 = no decay). */
    factor: number;
    /** Days since the previous decay run (0 on the first run). */
    elapsedDays: number;
    /** True when the interval floor suppressed this run. */
    skipped: boolean;
}
/** Decide what to archive and how much to decay, without writing anything. */
export declare function planDecay(db: DatabaseSync, now?: Date): DecayPlan;
export interface DecayOutcome {
    archived: number;
    decayed: number;
    factor: number;
    skipped: boolean;
    archivedIds: string[];
}
/**
 * Apply a plan: mark archived records, decay survivors, and record the run.
 * `dryRun` reports exactly what would happen without touching the store.
 */
export declare function applyDecay(db: DatabaseSync, plan: DecayPlan, options?: {
    dryRun?: boolean;
    now?: Date;
}): DecayOutcome;
/** Timestamp of the last consolidation run, if any. */
export declare function lastConsolidateAt(db: DatabaseSync): Date | undefined;
export declare function markConsolidated(db: DatabaseSync, now?: Date): void;
/** Whether the lazy trigger should run for this scope (DESIGN §7). */
export declare function consolidationDue(db: DatabaseSync, options: {
    everyDays: number;
    everyNTasks: number;
    now?: Date;
}): {
    due: boolean;
    reason: string;
};
export declare function scopeLabelOf(scope: MemoryScope): string;
//# sourceMappingURL=decay.d.ts.map