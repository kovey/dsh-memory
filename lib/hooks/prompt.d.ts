/**
 * System-prompt contributions (DESIGN §6, channel ①).
 *
 * Two independently switchable sections:
 *   - `memory:protocol`  — always-on, static, tiny: what the memory system is
 *     and which tools exist. Never mentions a tool that is not registered.
 *   - `memory:index`     — per-agent, dynamic: how much project/global memory
 *     exists and the most recent titles, so the model knows what to search for
 *     without paying for the bodies.
 *
 * The index section is registered on the *agent-scoped* context, so it resolves
 * the right repository per session and unwinds automatically on disposal.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryConfig } from '../config.js';
import { ScopeResolver } from '../scope/resolver.js';
import type { AgentLike } from '../scope/resolver.js';
import type { StoreRegistry } from '../store/store.js';
export declare const PROTOCOL_SECTION = "memory:protocol";
export declare const INDEX_SECTION = "memory:index";
/**
 * Which tools the host actually registered (see `registerTools`). The protocol
 * text is rendered from this object and from nothing else, so a tool whose
 * registration failed is never advertised.
 *
 * `search`/`get` are optional for callers that only track the write capability:
 * an explicit `false` suppresses the line, `undefined` keeps the historical
 * default of mentioning the read tools.
 */
export interface PromptCapabilities {
    save: boolean;
    search?: boolean;
    get?: boolean;
}
export interface PromptDeps {
    config: MemoryConfig;
    registry: StoreRegistry;
    resolver: ScopeResolver;
    /** Which tools exist, so the protocol never advertises a missing tool. */
    capabilities: PromptCapabilities;
}
/** Static protocol text. Kept short: ~120 tokens at the default budget. */
export declare function protocolText(config: MemoryConfig, capabilities?: PromptCapabilities): string;
/** Register the global protocol section. Returns disposers. */
export declare function registerProtocolSection(ctx: Context, deps: PromptDeps): (() => void)[];
/**
 * Register the per-agent index section. Called from `agent/created` with the
 * agent's own scoped context.
 */
export declare function registerAgentIndexSection(agent: AgentLike & {
    ctx?: Context;
}, deps: PromptDeps): boolean;
/** Dynamic index summary for one agent's scope. */
export declare function indexSummaryText(deps: PromptDeps, agent: AgentLike | undefined): string;
//# sourceMappingURL=prompt.d.ts.map