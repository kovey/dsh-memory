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
export function distillDigest(db: DatabaseSync, sinceDays = 7): { runs: number; created: number; timedOut: number; tokens: number } {
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString()
    const row = db
        .prepare(
            `SELECT COUNT(*) AS runs,
                    COALESCE(SUM(created_count), 0) AS created,
                    COALESCE(SUM(timed_out), 0) AS timed_out,
                    COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)), 0) AS tokens
             FROM distill WHERE at >= ?`,
        )
        .get(since)
    const num = (key: string): number => {
        const value = row?.[key]
        if (typeof value === 'number') return value
        if (typeof value === 'bigint') return Number(value)
        return 0
    }
    return { runs: num('runs'), created: num('created'), timedOut: num('timed_out'), tokens: num('tokens') }
}
