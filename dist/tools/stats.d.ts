import type { MemoryConfig } from '../config.js';
import type { EmbeddingProvider } from '../recall/semantic.js';
import { ScopeResolver } from '../scope/resolver.js';
import type { StoreRegistry } from '../store/store.js';
import type { MemoryScope } from '../store/types.js';
export interface StatsToolDeps {
    config: MemoryConfig;
    registry: StoreRegistry;
    resolver: ScopeResolver;
    semantic?: {
        provider?: EmbeddingProvider | undefined;
    } | undefined;
}
export declare function statsTool(deps: StatsToolDeps): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Exported for tests: the scope label used when freezing a baseline. */
export declare function scopeLabel(scope: MemoryScope): string;
//# sourceMappingURL=stats.d.ts.map