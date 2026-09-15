/**
 * Distillation runners (DESIGN §4.2, §14.3).
 *
 * Two ways to spend the one bounded LLM call a painful turn earns:
 *
 *   inline — awaited inside `agent/turn-stopping` with a hard timeout. Simple,
 *            and the turn cannot close mid-write; it delays turn closure by at
 *            most `distillTimeoutMs`.
 *   jobs   — handed to `ctx.jobs` (mounted by dsh-base as `dsh-jobs-local`), so
 *            the turn closes immediately and the work is visible in the job
 *            list and cancelled automatically when its owner agent is disposed.
 *
 * Neither runner survives process exit — that is why the signals are written to
 * L1 *before* distillation starts, so a skill can still distil them later.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryConfig } from '../config.js';
import type { SessionState } from '../recall/session-state.js';
import type { ScopeResolver } from '../scope/resolver.js';
import type { StoreRegistry } from '../store/store.js';
import type { DistillOutcome, DistillRequest } from './distill.js';
import type { Signal } from './signals.js';
/**
 * The jobs service is optional (it is mounted by dsh-base, but this plugin must
 * keep working without it), so it is reached structurally through `ctx.reflect`
 * instead of an `inject` dependency — the same pattern the vision bridge uses for
 * the attachment service.
 */
/** Minimal structural view of the optional jobs service. */
interface JobsLike {
    start(spec: {
        kind: 'memory-distill';
        label: string;
        owner?: unknown;
        run(): {
            cancel(reason?: string): void;
            done: Promise<{
                status: 'completed' | 'killed' | 'failed';
                detail?: string;
                output?: string;
            }>;
        };
    }): string;
}
export interface RunnerDeps {
    ctx: Context;
    config: MemoryConfig;
    registry: StoreRegistry;
    resolver: ScopeResolver;
    state: SessionState;
}
export interface RunnerRequest extends DistillRequest {
    /** Live agent that owns the work, when the caller has one. */
    ownerAgent?: unknown;
    /**
     * Force a runner for this call. Recovery passes `inline`: a recovered group
     * was *lost by a cancelled job*, so handing it to another job on the same
     * one-shot surface would lose it again (and silently — the job dies before
     * it can write an audit row).
     */
    mode?: 'inline' | 'jobs';
}
export interface RunnerResult {
    mode: 'inline' | 'jobs' | 'skipped';
    /** Present for the inline path (and for jobs that already settled). */
    outcome?: DistillOutcome;
    jobId?: string;
    reason?: string;
}
/** Optional service lookup that never throws and never requires inject. */
export declare function optionalJobs(ctx: Context): JobsLike | undefined;
/** Mark a group as being distilled; visible to `isDistilling` immediately. */
export declare function beginDistillation(sessionId: string, turn: number): void;
/** Clear the mark once the attempt settled (audit row written, or the job died). */
export declare function endDistillation(sessionId: string, turn: number): void;
/**
 * Whether this process is already distilling that group.
 *
 * `ttlMs` bounds how long a mark may outlive its distillation: a job that is
 * killed before its producer ever runs would otherwise hide the group from
 * recovery for the rest of the process's life.
 */
export declare function isDistilling(sessionId: string, turn: number, ttlMs: number): boolean;
/** How long an in-flight mark stays trustworthy, derived from the call bound. */
export declare function distillInFlightTtlMs(distillTimeoutMs: number): number;
/**
 * Run — or hand off — one turn's distillation according to
 * `learn.distillRunner`. Never throws: a failing job submission falls back to
 * the inline path.
 *
 * Both runners mark the group in flight for as long as it is being distilled —
 * for the jobs path that starts *before* `jobs.start`, because the job's own LLM
 * call is what makes the group look unattempted.
 */
export declare function runDistillation(deps: RunnerDeps, request: RunnerRequest): Promise<RunnerResult>;
/** Signals available for a fallback distillation by a skill. */
export interface DeferredSignals {
    sessionId: string;
    turn: number;
    signals: Signal[];
}
export {};
//# sourceMappingURL=distill-runner.d.ts.map