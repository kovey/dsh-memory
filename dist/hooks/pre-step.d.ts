/**
 * `agent/pre-step` recall hook (DESIGN §4, §6).
 *
 * Runs the zero-LLM half of the learning flywheel: on the first step of a turn
 * it searches project + global memory for the incoming task and injects what it
 * finds as a plugin-sourced user message — a *logged* channel, so what the model
 * saw is exactly what the session log records.
 *
 * Guarantees: threshold floor, token budget, per-session idempotence, and a
 * total try/catch (a recall failure must never disturb the step).
 */
import '../message-source.js';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { PreStepDecision } from '@deepseek-ai/dsh-agent';
import type { MemoryConfig } from '../config.js';
import { ScopeResolver } from '../scope/resolver.js';
import type { AgentLike } from '../scope/resolver.js';
import type { SessionState } from '../recall/session-state.js';
import type { StoreRegistry } from '../store/store.js';
import type { TurnLedger } from '../learn/ledger.js';
import type { EmbeddingProvider, QueryVectorCache } from '../recall/semantic.js';
import type { SignalBuffer } from '../learn/signals.js';
export interface RecallHookDeps {
    config: MemoryConfig;
    registry: StoreRegistry;
    resolver: ScopeResolver;
    state: SessionState;
    /** Present when signal collection is wired (M2). */
    signals?: SignalBuffer;
    ledger?: TurnLedger;
    /** Optional semantic recall runtime (absent = lexical only). */
    semantic?: {
        provider?: EmbeddingProvider | undefined;
        cache?: QueryVectorCache;
    } | undefined;
}
interface PreStepPayload {
    agent?: AgentLike;
    messages?: readonly UserMessage[];
    turn?: number;
    step?: number;
    signal?: AbortSignal;
}
/** Build the pre-step middleware. */
export declare function createPreStepHook(deps: RecallHookDeps): (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>;
export {};
//# sourceMappingURL=pre-step.d.ts.map