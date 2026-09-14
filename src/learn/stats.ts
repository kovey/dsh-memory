/**
 * Small aggregation helpers shared by `memory_stats` and the consolidation
 * tools. Kept separate so the tool module stays about model-facing plumbing.
 */
import type { DatabaseSync } from 'node:sqlite'
import { conflictCount } from './conflicts.js'

export { conflictCount }

/** Number of open promotion proposals. */
export function openProposalsCount(db: DatabaseSync): number {
    const row = db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'open'").get()
    return typeof row?.['n'] === 'number' ? row['n'] : 0
}

/** Distillation spend and outcomes for the recent window. */
