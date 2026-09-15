/**
 * Model-facing memory tools (DESIGN §9.1).
 *
 * M0 ships the read-only surface (`memory_search`, `memory_get`,
 * `memory_stats`) plus the derived-index repair tool (`memory_reindex`).
 * Writing tools arrive with the learning loop in M2.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryConfig } from '../config.js';
import type { StoreRegistry } from '../store/store.js';
import { ScopeResolver } from '../scope/resolver.js';
import type { SessionState } from '../recall/session-state.js';
import type { AutoCommitter } from '../sync/autocommit.js';
import type { EmbeddingProvider, QueryVectorCache } from '../recall/semantic.js';
export interface ToolDeps {
    config: MemoryConfig;
    registry: StoreRegistry;
    resolver: ScopeResolver;
    state: SessionState;
    committer: AutoCommitter;
    semantic?: {
        provider?: EmbeddingProvider | undefined;
        cache?: QueryVectorCache;
    } | undefined;
}
/**
 * Outcome of one registration pass. Capabilities (and therefore the prompt
 * protocol) are derived from `registered`/`failed`, never from what the plugin
 * *intended* to register.
 */
export interface ToolRegistration {
    /** Disposers for `ctx.effect`, one per successfully registered tool. */
    disposers: (() => void)[];
    /** Tool names the host actually accepted, in registration order. */
    registered: string[];
    /** Tool names whose `ctx.tools.register` threw. */
    failed: string[];
}
/**
 * Register every tool and report what the host accepted: `disposers` for
 * `ctx.effect`, plus the names that registered and the names that failed, which
 * is what the prompt capabilities are derived from.
 */
export declare function registerTools(ctx: Context, deps: ToolDeps): ToolRegistration;
/**
 * `memory_config` — session-scoped quieting (DESIGN §4.2).
 *
 * Deliberately not persistent: it changes how *this* session behaves (turn off
 * automatic recall while debugging), and a fresh session starts with the
 * configured defaults again. Durable switches live in the profile patch.
 */
export declare function configTool(deps: ToolDeps): import("@deepseek-ai/dsh-tools").ToolDefinition;
/**
 * `memory_import` — pull one lesson file into the store (DESIGN §4).
 *
 * The store already adopts files inside its own root on every export; this is
 * for a lesson that lives *elsewhere* (another project, a scratch file) and is
 * worth keeping here.
 */
export declare function importTool(deps: ToolDeps): import("@deepseek-ai/dsh-tools").ToolDefinition;
//# sourceMappingURL=index.d.ts.map