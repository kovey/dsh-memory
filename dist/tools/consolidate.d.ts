import type { DatabaseSync } from 'node:sqlite';
import type { MemoryConfig } from '../config.js';
import { ScopeResolver } from '../scope/resolver.js';
import type { StoreRegistry } from '../store/store.js';
import type { Layer } from '../store/types.js';
export interface ConsolidateToolDeps {
    config: MemoryConfig;
    registry: StoreRegistry;
    resolver: ScopeResolver;
}
export declare function consolidateTool(deps: ConsolidateToolDeps): import("@deepseek-ai/dsh-tools").ToolDefinition;
export declare function forgetTool(deps: ConsolidateToolDeps): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** One record a bulk forget would archive, with the reason it matched. */
export interface ForgetTarget {
    id: string;
    title: string;
    layer: Layer;
    updatedAt: string;
    /** Why this record is in the list — one clause per criterion that matched. */
    reason: string;
}
/**
 * Records a bulk forget would touch.
 *
 * Only `active`/`pending` records are candidates: archiving an archived record
 * is a no-op, and listing them would make the pre-flight count a lie. The result
 * is oldest-first (by `updated_at`), so when `limit` truncates the list it is
 * the stalest records that are dropped from it.
 */
export declare function selectForgetTargets(db: DatabaseSync, options?: {
    query?: string;
    layer?: Layer;
    olderThanDays?: number;
    now?: Date;
}): ForgetTarget[];
//# sourceMappingURL=consolidate.d.ts.map