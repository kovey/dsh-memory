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
import type { DatabaseSync } from 'node:sqlite';
import type { Signal } from './signals.js';
export interface PendingGroup {
    sessionId: string;
    turn: number;
    signals: number;
    lastAt: string;
}
/** Age limit: old episodes are history, not work to spend an LLM call on. */
export declare const PENDING_MAX_AGE_DAYS = 14;
/**
 * Freshness guard for a group that may still be in flight.
 *
 * A distillation call runs for up to `distillTimeoutMs` and only writes its
 * audit row at the end, so for that whole window the group still looks
 * unattempted. The guard is derived from the configured timeout instead of a
 * fixed number of seconds so it always covers one full distillation.
 */
export declare function pendingMinAgeSeconds(distillTimeoutMs: number): number;
export interface PendingOptions {
    limit?: number;
    maxAgeDays?: number;
    now?: Date;
    /**
     * Signals younger than this are treated as belonging to a turn that may
     * still be running (its own turn-stopping will handle them).
     */
    minAgeSeconds?: number;
    /**
     * Configured `learn.distillTimeoutMs`; used to derive `minAgeSeconds` when
     * the caller does not name one.
     */
    distillTimeoutMs?: number;
}
/**
 * Signal groups with no distillation attempt yet, newest first.
 * Read-only; never mutates the store.
 */
export declare function pendingDistillations(db: DatabaseSync, options?: PendingOptions): PendingGroup[];
/** Load the signals of one pending group, oldest first. */
export declare function loadGroupSignals(db: DatabaseSync, group: PendingGroup): Signal[];
//# sourceMappingURL=pending.d.ts.map