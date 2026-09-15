import type { MemoryConfig } from '../config.js';
import { ScopeResolver } from '../scope/resolver.js';
import type { StoreRegistry } from '../store/store.js';
import type { MemoryScope } from '../store/types.js';
export interface ConsolidateToolDeps {
    config: MemoryConfig;
    registry: StoreRegistry;
    resolver: ScopeResolver;
}
export declare function consolidateTool(deps: ConsolidateToolDeps): import("@deepseek-ai/dsh-tools").ToolDefinition;
export declare function forgetTool(deps: ConsolidateToolDeps): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Used by tests: accept a proposal without going through the tool surface. */
export declare function acceptProposal(deps: ConsolidateToolDeps, scope: MemoryScope, recordId: string): number;
//# sourceMappingURL=consolidate.d.ts.map