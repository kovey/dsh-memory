import { ScopeResolver } from '../scope/resolver.js';
import type { AgentLike } from '../scope/resolver.js';
import type { StoreRegistry } from '../store/store.js';
import type { MemoryConfig } from '../config.js';
export interface SaveToolDeps {
    config: MemoryConfig;
    registry: StoreRegistry;
    resolver: ScopeResolver;
}
/** `permanent` | `30d` | `2026-12-31` → expiry date or undefined. */
export declare function parseTtl(ttl: string | undefined, now?: Date): string | undefined;
/** Caps that keep a model from bloating the text view or the memory pack. */
export declare const MAX_SAVE_BODY_CHARS = 4000;
export declare const MAX_SAVE_TITLE_CHARS = 120;
export declare const MAX_SAVE_TAGS = 8;
/**
 * The one refusal text every write-class tool returns to a subagent
 * (`routing.subagentWrite` off). Shared verbatim so the model gets the same
 * explanation no matter which write door it tried.
 */
export declare function subagentWriteRefusal(operation: string): string;
/**
 * `undefined` when `agent` may perform a memory-writing operation, otherwise the
 * refusal text to return verbatim *before* touching anything.
 *
 * Every write door goes through this — `memory_save`, `memory_forget`,
 * `memory_consolidate` (when it applies), `memory_sync`, `memory_reindex` and
 * `memory_stats(setBaseline)` — so a subagent hits the same wall on all of them
 * and can never perform a partial write first.
 */
export declare function refuseWrite(deps: {
    resolver: ScopeResolver;
}, agent: AgentLike | undefined, operation: string): string | undefined;
export declare function saveTool(deps: SaveToolDeps): import("@deepseek-ai/dsh-tools").ToolDefinition;
//# sourceMappingURL=save.d.ts.map