import { getMeta, setMeta, transact } from '../store/sqlite/db.js';
import { listRecords } from '../store/sqlite/records.js';
import { clamp01 } from './confidence.js';
/** Half-life of confidence with no reinforcing evidence. */
export const DECAY_HALF_LIFE_DAYS = 180;
/** Never decay more than this fraction in one run. */
export const MAX_DECAY_PER_RUN = 0.5;
/** Minimum gap between decay runs. */
export const MIN_DECAY_INTERVAL_DAYS = 7;
/** Pending records untouched for this long (and never recalled) are archived. */
export const STALE_PENDING_DAYS = 60;
/** Pending records below this confidence are considered noise. */
export const STALE_PENDING_CONFIDENCE = 0.55;
const LAST_DECAY_KEY = 'last_decay_at';
const LAST_CONSOLIDATE_KEY = 'last_consolidate_at';
/** Decide what to archive and how much to decay, without writing anything. */
export function planDecay(db, now = new Date()) {
    const last = getMeta(db, LAST_DECAY_KEY);
    const lastAt = last !== undefined ? Date.parse(last) : Number.NaN;
    const elapsedDays = Number.isFinite(lastAt) ? (now.getTime() - lastAt) / 86_400_000 : 0;
    const skipped = Number.isFinite(lastAt) && elapsedDays < MIN_DECAY_INTERVAL_DAYS;
    const factor = skipped || !Number.isFinite(lastAt) ? 1 : Math.max(MAX_DECAY_PER_RUN, Math.pow(0.5, elapsedDays / DECAY_HALF_LIFE_DAYS));
    const today = now.toISOString().slice(0, 10);
    const records = listRecords(db, { status: ['active', 'pending'] });
    const archive = [];
    for (const record of records) {
        if (record.expiresAt !== undefined && record.expiresAt < today) {
            archive.push({ record, reason: `expired ${record.expiresAt}` });
            continue;
        }
        if (record.status !== 'pending')
            continue;
        if (record.confidence > STALE_PENDING_CONFIDENCE)
            continue;
        if (record.timesRecalled > 0)
            continue;
        const ageDays = (now.getTime() - Date.parse(record.updatedAt)) / 86_400_000;
        if (Number.isFinite(ageDays) && ageDays >= STALE_PENDING_DAYS) {
            archive.push({ record, reason: `pending and unrecalled for ${Math.round(ageDays)}d` });
        }
    }
    return { archive, factor, elapsedDays, skipped };
}
/**
 * Apply a plan: mark archived records, decay survivors, and record the run.
 * `dryRun` reports exactly what would happen without touching the store.
 */
export function applyDecay(db, plan, options = {}) {
    const now = options.now ?? new Date();
    const outcome = {
        archived: plan.archive.length,
        decayed: 0,
        factor: plan.factor,
        skipped: plan.skipped,
        archivedIds: plan.archive.map((item) => item.record.id),
    };
    if (options.dryRun === true)
        return outcome;
    transact(db, () => {
        const archiveStatement = db.prepare("UPDATE records SET status = 'archived', updated_at = ? WHERE id = ?");
        for (const item of plan.archive)
            archiveStatement.run(now.toISOString(), item.record.id);
        if (plan.factor < 1) {
            const survivors = listRecords(db, { status: ['active', 'pending'] });
            const decayStatement = db.prepare('UPDATE records SET confidence = ? WHERE id = ?');
            for (const record of survivors) {
                const next = Math.round(clamp01(record.confidence * plan.factor) * 1000) / 1000;
                if (next === record.confidence)
                    continue;
                decayStatement.run(next, record.id);
                outcome.decayed += 1;
            }
        }
        if (plan.factor < 1 || plan.elapsedDays === 0)
            setMeta(db, LAST_DECAY_KEY, now.toISOString());
    });
    return outcome;
}
/** Timestamp of the last consolidation run, if any. */
export function lastConsolidateAt(db) {
    const raw = getMeta(db, LAST_CONSOLIDATE_KEY);
    if (raw === undefined)
        return undefined;
    const stamp = Date.parse(raw);
    return Number.isFinite(stamp) ? new Date(stamp) : undefined;
}
export function markConsolidated(db, now = new Date()) {
    setMeta(db, LAST_CONSOLIDATE_KEY, now.toISOString());
}
/** Whether the lazy trigger should run for this scope (DESIGN §7). */
export function consolidationDue(db, options) {
    const now = options.now ?? new Date();
    const last = lastConsolidateAt(db);
    if (last === undefined) {
        // First run on a fresh store: initialize the marker without touching data.
        return { due: true, reason: 'first-run' };
    }
    const days = (now.getTime() - last.getTime()) / 86_400_000;
    if (days >= options.everyDays)
        return { due: true, reason: `${Math.floor(days)}d since last run` };
    const row = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE date >= ?').get(last.toISOString().slice(0, 10));
    const tasks = typeof row?.['n'] === 'number' ? row['n'] : 0;
    if (tasks >= options.everyNTasks)
        return { due: true, reason: `${tasks} tasks since last run` };
    return { due: false, reason: 'not due' };
}
export function scopeLabelOf(scope) {
    return scope.kind === 'project' ? `project:${scope.repo ?? scope.root}` : 'global';
}
//# sourceMappingURL=decay.js.map