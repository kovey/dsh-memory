import { log } from '../log.js';
import { exportAll } from '../store/export.js';
import { listRecords } from '../store/sqlite/records.js';
import { activeRecords, applyConflicts, detectConflicts } from './conflicts.js';
import { applyDecay, markConsolidated, planDecay } from './decay.js';
import { pruneSkillDrafts, writeSkillDraft } from './promote.js';
const DEFAULT_PROMOTION_SEEN = 3;
const DEFAULT_PROMOTION_CONFIDENCE = 0.9;
/** Lessons that have proven themselves often enough to become a skill. */
export function promotionCandidates(db, options = {}) {
    const minSeen = options.promotionMinSeen ?? DEFAULT_PROMOTION_SEEN;
    const minConfidence = options.promotionMinConfidence ?? DEFAULT_PROMOTION_CONFIDENCE;
    return listRecords(db, { status: ['active'] }).filter((record) => record.timesSeen >= minSeen &&
        record.confidence >= minConfidence &&
        record.supersededBy === undefined &&
        record.status === 'active');
}
/** Record promotion proposals (idempotent: one open proposal per record). */
export function recordProposals(db, proposals, now = new Date()) {
    if (proposals.length === 0)
        return 0;
    const exists = db.prepare("SELECT 1 AS x FROM proposals WHERE record_id = ? AND kind = ? AND status = 'open' LIMIT 1");
    const insert = db.prepare('INSERT INTO proposals (kind, record_id, title, rationale, status, at) VALUES (?, ?, ?, ?, ?, ?)');
    let written = 0;
    for (const proposal of proposals) {
        if (exists.get(proposal.recordId, proposal.kind) !== undefined)
            continue;
        insert.run(proposal.kind, proposal.recordId, proposal.title, proposal.rationale, 'open', now.toISOString());
        written += 1;
    }
    return written;
}
export function openProposals(db, limit = 20) {
    const rows = db
        .prepare("SELECT kind, record_id, title, rationale, at FROM proposals WHERE status = 'open' ORDER BY at DESC LIMIT ?")
        .all(Math.max(1, limit));
    return rows.map((row) => ({
        kind: typeof row['kind'] === 'string' ? row['kind'] : 'unknown',
        recordId: typeof row['record_id'] === 'string' ? row['record_id'] : '',
        title: typeof row['title'] === 'string' ? row['title'] : '',
        rationale: typeof row['rationale'] === 'string' ? row['rationale'] : '',
        at: typeof row['at'] === 'string' ? row['at'] : '',
    }));
}
export function resolveProposal(db, recordId, status) {
    const result = db.prepare("UPDATE proposals SET status = ? WHERE record_id = ? AND status = 'open'").run(status, recordId);
    return typeof result.changes === 'number' ? result.changes : 0;
}
/** Run one consolidation pass for a scope. */
export function consolidate(db, scope, _fts5, options = {}) {
    const now = options.now ?? new Date();
    const dryRun = options.dryRun === true;
    const report = {
        scope: scope.kind === 'project' ? `project:${scope.repo ?? scope.root}` : 'global',
        dryRun,
        decayFactor: 1,
        decayed: 0,
        archived: 0,
        archivedIds: [],
        conflictsFound: 0,
        conflictsRecorded: 0,
        conflictsResolved: 0,
        proposals: [],
        skillDrafts: [],
        errors: [],
    };
    try {
        const plan = planDecay(db, now);
        report.decayFactor = plan.factor;
        const outcome = applyDecay(db, plan, { dryRun, now });
        report.archived = outcome.archived;
        report.archivedIds = outcome.archivedIds;
        report.decayed = outcome.decayed;
        if (plan.factor < 1 && !dryRun)
            log('info', `memory: decayed ${outcome.decayed} record(s) by ${plan.factor.toFixed(3)}`);
    }
    catch (error) {
        report.errors.push(`decay: ${message(error)}`);
    }
    try {
        const candidates = detectConflicts(activeRecords(db));
        report.conflictsFound = candidates.length;
        if (!dryRun && candidates.length > 0) {
            const applied = applyConflicts(db, candidates, {
                resolve: options.resolveConflicts === true,
                now,
            });
            report.conflictsRecorded = applied.filter((item) => item.recorded).length;
            report.conflictsResolved = applied.filter((item) => item.resolved).length;
        }
    }
    catch (error) {
        report.errors.push(`conflicts: ${message(error)}`);
    }
    try {
        report.proposals = promotionCandidates(db, options).map((record) => ({
            kind: 'promote-skill',
            recordId: record.id,
            title: record.title,
            rationale: `seen ${record.timesSeen}× at confidence ${record.confidence.toFixed(2)} — stable enough to become a skill or project convention`,
        }));
        if (!dryRun) {
            recordProposals(db, report.proposals, now);
            // Hand the human a ready-to-move SKILL.md instead of a row in a table
            // (DESIGN §3: the L3 → L4 step stays human-approved, so this is a
            // draft inside the memory root, never a write into ~/.dsh/skills).
            if (options.writeSkillDrafts !== false) {
                const written = [];
                for (const proposal of report.proposals) {
                    const record = listRecords(db).find((candidate) => candidate.id === proposal.recordId);
                    if (record === undefined)
                        continue;
                    const file = writeSkillDraft(scope, record, now);
                    if (file !== undefined)
                        written.push(file);
                }
                report.skillDrafts = written;
                const open = openProposals(db, 500).map((proposal) => proposal.recordId);
                pruneSkillDrafts(scope, open);
            }
        }
    }
    catch (error) {
        report.errors.push(`proposals: ${message(error)}`);
    }
    if (!dryRun) {
        try {
            const result = exportAll(db, scope);
            if (result.errors.length > 0)
                report.errors.push(...result.errors);
        }
        catch (error) {
            report.errors.push(`export: ${message(error)}`);
        }
        markConsolidated(db, now);
        try {
            db.prepare('INSERT INTO consolidate_runs (at, project, archived, decayed, conflicts, proposals, note) VALUES (?, ?, ?, ?, ?, ?, ?)').run(now.toISOString(), report.scope, report.archived, report.decayed, report.conflictsRecorded, report.proposals.length, options.resolveConflicts === true ? 'resolve-conflicts' : 'detect-only');
        }
        catch (error) {
            report.errors.push(`audit: ${message(error)}`);
        }
    }
    return report;
}
/** Render a consolidation report for a tool result. */
export function renderReport(report) {
    const lines = [
        `consolidation ${report.dryRun ? '(dry-run) ' : ''}— ${report.scope}`,
        `  decay: factor ${report.decayFactor.toFixed(3)} · records decayed ${report.decayed}`,
        `  archive: ${report.archived}${report.archivedIds.length > 0 ? ` (${report.archivedIds.slice(0, 5).join(', ')}${report.archivedIds.length > 5 ? '…' : ''})` : ''}`,
        `  conflicts: found ${report.conflictsFound} · recorded ${report.conflictsRecorded} · resolved ${report.conflictsResolved}${report.conflictsResolved === 0 && report.conflictsFound > 0 ? ' (pass resolveConflicts=true to supersede the weaker lesson)' : ''}`,
    ];
    if (report.proposals.length > 0) {
        lines.push(`  promotion proposals (${report.proposals.length}) — human approval required:`);
        for (const proposal of report.proposals.slice(0, 5)) {
            lines.push(`    · ${proposal.title} (${proposal.recordId}) — ${proposal.rationale}`);
        }
    }
    if (report.errors.length > 0)
        lines.push(`  errors: ${report.errors.join('; ')}`);
    return lines.join('\n');
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=consolidate.js.map