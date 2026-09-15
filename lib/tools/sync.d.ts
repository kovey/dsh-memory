import type { MemoryConfig } from '../config.js';
import { ScopeResolver } from '../scope/resolver.js';
import type { StoreRegistry } from '../store/store.js';
import { AutoCommitter } from '../sync/autocommit.js';
export interface SyncToolDeps {
    config: MemoryConfig;
    registry: StoreRegistry;
    resolver: ScopeResolver;
    committer: AutoCommitter;
}
export declare function syncTool(deps: SyncToolDeps): import("@deepseek-ai/dsh-tools").ToolDefinition;
//# sourceMappingURL=sync.d.ts.map