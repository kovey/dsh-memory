/**
 * Small aggregation helpers shared by `memory_stats` and the consolidation
 * tools. Kept separate so the tool module stays about model-facing plumbing.
 */
import type { DatabaseSync } from 'node:sqlite';
import { conflictCount } from './conflicts.js';
export { conflictCount };
/** Number of open promotion proposals. */
export declare function openProposalsCount(db: DatabaseSync): number;
/** Distillation spend and outcomes for the recent window. */
//# sourceMappingURL=stats.d.ts.map