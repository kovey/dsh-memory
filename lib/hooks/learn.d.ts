/**
 * Learning hooks (DESIGN §4.1, §7): the "Observe → Distill → Gate → Consolidate"
 * half of the flywheel.
 *
 * Everything except distillation itself is zero-cost; distillation is skipped
 * entirely for turns without pain signals.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryConfig } from '../config.js';
import type { SessionState } from '../recall/session-state.js';
import { ScopeResolver } from '../scope/resolver.js';
import type { AgentLike } from '../scope/resolver.js';
import type { StoreRegistry } from '../store/store.js';
import { TurnLedger } from '../learn/ledger.js';
import type { Signal, SignalBuffer } from '../learn/signals.js';
export interface LearnDeps {
    ctx: Context;
    config: MemoryConfig;
    registry: StoreRegistry;
    resolver: ScopeResolver;
    state: SessionState;
    signals: SignalBuffer;
    ledger: TurnLedger;
}
/**
 * Pick up pain signals that were collected but never distilled — a job killed
 * with its agent on a one-shot surface, or a process that died mid-call.
 *
 * Runs off the turn-end path, uses the *new* session's route/model, and is
 * naturally idempotent: any attempt that passed the gate writes a `distill`
 * audit row, so a group is retried until its first attempt and never again.
 * Attempts refused by the gate (budget, no route) write nothing and stay
 * pending, which is why the caller must not latch a scope that recovered
 * nothing.
 */
export declare function recoverPendingDistillations(deps: LearnDeps, agent: AgentLike | undefined, options?: {
    budgetMs?: number;
}): Promise<number>;
/** Register tool-result, request-error and turn-stopping listeners. */
export declare function registerLearnHooks(ctx: Context, deps: LearnDeps): (() => void)[];
/** Read the text of a tool result's content blocks. */
export declare function contentText(content: unknown): string;
export type { Signal };
//# sourceMappingURL=learn.d.ts.map