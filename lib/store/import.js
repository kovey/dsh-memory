/**
 * Text view → SQLite (DESIGN §5.3).
 *
 * The plugin never requires a manual migration: when a memory root's database
 * is empty it is bootstrapped from the lessons already on disk, which is how
 * the pre-existing `~/.dsh/memory/lessons/*.md` corpus enters the store.
 */
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import { countEvidence, expiresToIso, parseEvidenceSummary, parseLesson } from './frontmatter.js';
import { normalizeDashes } from './guard.js';
import { getRecord, materialize, upsertRecord } from './sqlite/records.js';
import { rowStr, transact } from './sqlite/db.js';
/**
 * Upper bounds for evidence rebuilt from a text-view summary. The field is
 * hand-editable, so a typo (`tool-failure×999999`) must not turn into a runaway
 * insert loop.
 */
const MAX_EVIDENCE_PER_KIND = 50;
const MAX_EVIDENCE_TOTAL = 200;
/** True when the records table holds nothing yet. */
export function isRecordsEmpty(db) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM records').get();
    const n = row?.['n'];
    if (typeof n === 'number')
        return n === 0;
    if (typeof n === 'bigint')
        return n === 0n;
    return true;
}
/** Import on first open only: an existing database is never overwritten. */
export function bootstrapImport(db, scope) {
    if (!isRecordsEmpty(db))
        return undefined;
    return importLessons(db, scope);
}
/** Import every `<root>/lessons/*.md` document into the scope's database. */
export function importLessons(db, scope, options = {}) {
    const result = { root: scope.root, scanned: 0, imported: 0, merged: 0, skipped: 0, errors: [] };
    const dir = path.join(scope.root, 'lessons');
    let entries;
    try {
        entries = fs.readdirSync(dir).filter((name) => name.endsWith('.md'));
    }
    catch {
        return result;
    }
    const layer = scope.kind === 'project' ? 'project' : 'global';
    transact(db, () => {
        if (options.rebuild === true)
            db.prepare('DELETE FROM records').run();
        const stored = storedIds(db);
        for (const name of entries) {
            result.scanned += 1;
            const file = path.join(dir, name);
            try {
                const parsed = parseLesson(fs.readFileSync(file, 'utf8'));
                if (parsed === undefined) {
                    result.skipped += 1;
                    continue;
                }
                const id = path.basename(name, '.md');
                // An exact id always wins: the record already owns this file. A
                // legacy `memory-lesson.sh` file name keeps its dash runs
                // (`-fetch--origin.md`) while the plugin's slugify folds them
                // (`fetch-origin`), so a file with no exact record is matched
                // dash-insensitively and merged into the equivalent record rather
                // than becoming a second id for the same insight.
                const target = stored.exact.has(id) ? id : stored.canonical.get(normalizeDashes(id));
                if (target !== undefined && options.onlyMissing === true) {
                    result.skipped += 1;
                    continue;
                }
                const existing = target === undefined ? undefined : getRecord(db, target);
                const record = recordFromLesson(parsed, layer, scope, id);
                // The text view only carries evidence *counts*; keep the store's
                // detailed rows and fill in what they are missing, so a rebuild
                // restores §8's evidence without double-counting real signals.
                if (existing !== undefined) {
                    record.evidence = fillEvidenceGaps(existing.evidence, countEvidence(record.evidence), record.updatedAt);
                }
                if (existing !== undefined && existing.id !== id) {
                    if (mergeIntoExisting(db, existing, record))
                        result.merged += 1;
                    else
                        result.skipped += 1;
                    continue;
                }
                upsertRecord(db, record);
                stored.exact.add(record.id);
                preferCanonical(stored.canonical, record.id);
                result.imported += 1;
            }
            catch (error) {
                result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    });
    log('info', `imported ${result.imported}/${result.scanned} lessons from ${dir} (merged ${result.merged})`);
    return result;
}
/** Stored ids: the exact set, plus a dash-insensitive index for legacy names. */
function storedIds(db) {
    const exact = new Set();
    const canonical = new Map();
    for (const row of db.prepare('SELECT id FROM records').all()) {
        const id = rowStr(row, 'id');
        if (id === undefined || id === '')
            continue;
        exact.add(id);
        preferCanonical(canonical, id);
    }
    return { exact, canonical };
}
/**
 * Index one id by its dash-insensitive form, preferring the already-canonical
 * spelling. When both spellings exist (the bug this index prevents, seen in a
 * database that predates the fix) the canonical one wins; otherwise the first
 * stays.
 */
function preferCanonical(index, id) {
    const key = normalizeDashes(id);
    const kept = index.get(key);
    if (kept === undefined || (kept !== key && id === key))
        index.set(key, id);
}
/**
 * Merge a lesson file whose id differs from a stored record only in dash runs
 * into that record — DESIGN §8's merge rules (`times_seen+1`, confidence `max`,
 * evidence union) with the longer body winning, since the text view has no
 * reliable "which came first" beyond its `updated` date.
 *
 * Two deliberate exclusions, both protecting live state from a file that merely
 * happens to still be on disk: the record's `status` (an archived lesson is not
 * resurrected by re-adoption) and its identity (id, layer, scope, expiry) are
 * never taken from the file.
 *
 * Returns false when the file adds nothing (same body, same confidence, no new
 * evidence) — otherwise the adoption pass, which runs after every export, would
 * inflate `times_seen` on each run.
 */
function mergeIntoExisting(db, existing, candidate) {
    const body = candidate.body.length > existing.body.length ? candidate.body : existing.body;
    const confidence = Math.max(existing.confidence, candidate.confidence);
    const evidence = mergeEvidence(existing.evidence, candidate.evidence);
    if (body === existing.body && confidence === existing.confidence && evidence.length === existing.evidence.length) {
        return false;
    }
    upsertRecord(db, {
        ...existing,
        body,
        confidence,
        evidence,
        timesSeen: existing.timesSeen + 1,
        updatedAt: candidate.updatedAt > existing.updatedAt ? candidate.updatedAt : existing.updatedAt,
    });
    return true;
}
/**
 * Merge two evidence lists as multisets keyed by signal identity, keeping the
 * larger multiplicity of each signal.
 *
 * A plain union is wrong here: two `tool-failure` signals observed in the same
 * turn are the same row, and deduplicating them would halve the count §8 judges
 * a lesson by (which is exactly how a text-view round trip lost a signal).
 * Concatenating instead would double-count what both sides already agree on.
 */
function mergeEvidence(base, extra) {
    const baseCounts = countByKey(base);
    const extraCounts = countByKey(extra);
    const emitted = new Map();
    const merged = [];
    for (const item of [...base, ...extra]) {
        const key = evidenceKey(item);
        const wanted = Math.max(baseCounts.get(key) ?? 0, extraCounts.get(key) ?? 0);
        const already = emitted.get(key) ?? 0;
        if (already >= wanted)
            continue;
        emitted.set(key, already + 1);
        merged.push(item);
    }
    return merged;
}
function countByKey(evidence) {
    const counts = new Map();
    for (const item of evidence)
        counts.set(evidenceKey(item), (counts.get(evidenceKey(item)) ?? 0) + 1);
    return counts;
}
function evidenceKey(item) {
    return `${item.kind}\u0000${item.detail ?? ''}\u0000${item.turn ?? ''}\u0000${item.at}`;
}
/**
 * Materialize the evidence summary of a lesson file into rows, adding only the
 * kinds the store does not already have enough of. A record whose real signal
 * rows survived must not be doubled by the counts read back from the text view.
 */
function fillEvidenceGaps(existing, counts, at) {
    const have = new Map();
    for (const item of existing)
        have.set(item.kind, (have.get(item.kind) ?? 0) + 1);
    const rows = [];
    for (const { kind, count } of counts) {
        const missing = Math.min(count - (have.get(kind) ?? 0), MAX_EVIDENCE_PER_KIND);
        for (let i = 0; i < missing && rows.length < MAX_EVIDENCE_TOTAL; i += 1) {
            rows.push({ kind: kind, at });
        }
    }
    return mergeEvidence(existing, rows);
}
/**
 * Convert one parsed lesson document into a record. The file name is
 * authoritative for identity: legacy slugs (including `zh-<sha1>` fallbacks)
 * must survive a round trip unchanged.
 */
export function recordFromLesson(parsed, layer, scope, fileSlug) {
    const { frontmatter, body } = parsed;
    const expiresAt = expiresToIso(frontmatter.expires);
    const record = materialize({
        title: frontmatter.title,
        body,
        layer,
        scopeKind: scope.kind,
        ...(scope.repo !== undefined ? { repo: scope.repo } : {}),
        confidence: frontmatter.confidence,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(frontmatter.tags !== undefined ? { tags: frontmatter.tags } : {}),
        origin: 'imported',
        ...(frontmatter.status !== undefined ? { status: frontmatter.status } : {}),
    }, `${frontmatter.updated}T00:00:00.000Z`);
    record.id = fileSlug;
    record.timesSeen = frontmatter.timesSeen;
    record.timesRecalled = frontmatter.timesRecalled ?? 0;
    record.successAfterRecall = frontmatter.successAfterRecall ?? 0;
    record.failAfterRecall = frontmatter.failAfterRecall ?? 0;
    if (frontmatter.supersededBy !== undefined)
        record.supersededBy = frontmatter.supersededBy;
    if (frontmatter.created !== undefined)
        record.createdAt = `${frontmatter.created}T00:00:00.000Z`;
    // §8 judges a lesson by its evidence kinds and counts, and that summary is
    // all the text view carries: restore one row per count so a rebuild on
    // another machine is not blind to it. `updated` dates the rows, which keeps
    // the restored set stable across repeated imports.
    record.evidence = evidenceFromSummary(frontmatter.evidence, record.updatedAt);
    return record;
}
/** Evidence rows a text-view summary stands for (kinds and counts only). */
function evidenceFromSummary(summary, at) {
    return fillEvidenceGaps([], parseEvidenceSummary(summary ?? ''), at);
}
//# sourceMappingURL=import.js.map