import { conflictCount } from './conflicts.js';
export { conflictCount };
/** Number of open promotion proposals. */
export function openProposalsCount(db) {
    const row = db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'open'").get();
    return typeof row?.['n'] === 'number' ? row['n'] : 0;
}
/** Distillation spend and outcomes for the recent window. */
//# sourceMappingURL=stats.js.map