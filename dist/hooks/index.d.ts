/**
 * Hook wiring (DESIGN §4, §7). Everything registered here is zero-LLM; the
 * learning loop's bounded distillation arrives in M2.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryConfig } from '../config.js';
import { SessionState } from '../recall/session-state.js';
import { ScopeResolver } from '../scope/resolver.js';
import type { StoreRegistry } from '../store/store.js';
import { AutoCommitter } from '../sync/autocommit.js';
import { TurnLedger } from '../learn/ledger.js';
import { SignalBuffer } from '../learn/signals.js';
import type { PromptDeps } from './prompt.js';
export interface HookDeps extends PromptDeps {
    config: MemoryConfig;
    registry: StoreRegistry;
    resolver: ScopeResolver;
    state: SessionState;
    /** Bounded pain-signal buffer (L0). */
    signals: SignalBuffer;
    /** Per-turn work counters, used for recall attribution. */
    ledger: TurnLedger;
    /** Local-only commits of the memory text view. */
    committer: AutoCommitter;
}
export interface HookHandle {
    deps: HookDeps;
    dispose: () => void;
}
/** Build the shared dependency bag (tools and hooks use the same one). */
export declare function createHookDeps(config: MemoryConfig, registry: StoreRegistry, resolver: ScopeResolver, capabilities: {
    save: boolean;
}, semantic?: {
    provider?: import('../recall/semantic.js').EmbeddingProvider | undefined;
    cache?: import('../recall/semantic.js').QueryVectorCache;
} | undefined): HookDeps;
/** Register every hook and prompt contribution. */
export declare function registerHooks(ctx: Context, deps: HookDeps): HookHandle;
//# sourceMappingURL=index.d.ts.map