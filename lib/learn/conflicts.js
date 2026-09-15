import { extractTerms, listRecords } from '../store/sqlite/records.js';
import { jaccard, tokens } from './gate.js';
/**
 * Directive lexicons. The positive list deliberately avoids bare 要: it occurs
 * inside 不要/需要/重要, which would make every prohibition look "mixed" and
 * therefore undecidable.
 */
const POSITIVE = ['必须', '应该', '推荐', '使用', '启用', '总是', 'always', 'must', 'should', 'use ', 'enable'];
const NEGATIVE = ['不要', '禁止', '避免', '切勿', '不得', '别用', 'never', 'avoid', 'do not', "don't", 'disable', 'deprecated'];
/** How far past a negative marker its negated object is assumed to extend. */
const NEGATED_SPAN = 10;
/** Topic similarity above which two records are considered the same subject. */
export const TOPIC_THRESHOLD = 0.6;
/**
 * -1 (prohibitive), +1 (prescriptive), 0 (mixed / no directive).
 *
 * A prohibition often contains the very verb it forbids ("不要使用 X"), so the
 * negated span is blanked out before prescriptive markers are counted.
 */
export function directivePolarity(body) {
    const lowered = body.toLowerCase();
    let negative = 0;
    let stripped = lowered;
    for (const marker of NEGATIVE) {
        let index = stripped.indexOf(marker);
        while (index !== -1) {
            negative += 1;
            const end = index + marker.length + NEGATED_SPAN;
            stripped = stripped.slice(0, index) + ' '.repeat(Math.min(end, stripped.length) - index) + stripped.slice(end);
            index = stripped.indexOf(marker, index + marker.length);
        }
    }
    let positive = 0;
    for (const marker of POSITIVE)
        if (stripped.includes(marker))
            positive += 1;
    if (positive === 0 && negative === 0)
        return 0;
    if (positive > 0 && negative > 0)
        return 0;
    return positive > 0 ? 1 : -1;
}
/** The object a directive is about: domain tokens shared by both bodies. */
export function sharedObjects(a, b) {
    const left = new Set(extractTerms(a, 40));
    const right = new Set(extractTerms(b, 40));
    const shared = [];
    for (const token of left)
        if (right.has(token) && token.length >= 3)
            shared.push(token);
    return shared;
}
/** Detect contradictions among active records. Pure read. */
export function detectConflicts(records) {
    const out = [];
    const seen = new Set();
    for (let i = 0; i < records.length; i += 1) {
        for (let j = i + 1; j < records.length; j += 1) {
            const a = records[i];
            const b = records[j];
            if (a === undefined || b === undefined)
                continue;
            const topic = jaccard(tokens(a.title), tokens(b.title));
            if (topic < TOPIC_THRESHOLD)
                continue;
            const polarityA = directivePolarity(a.body);
            const polarityB = directivePolarity(b.body);
            if (polarityA === 0 || polarityB === 0 || polarityA === polarityB)
                continue;
            const shared = sharedObjects(a.body, b.body);
            if (shared.length === 0)
                continue;
            const key = [a.id, b.id].sort().join('|');
            if (seen.has(key))
                continue;
            seen.add(key);
            const winner = pickWinner(a, b);
            const loser = winner.id === a.id ? b : a;
            out.push({
                winner,
                loser,
                topicSimilarity: topic,
                reason: `opposite directives about ${shared.slice(0, 3).join(', ')} (topic ${topic.toFixed(2)})`,
            });
        }
    }
    return out;
}
/**
 * The more recent, better-evidenced record wins; ties fall back to confidence
 * (DESIGN §8: "keep the newer / stronger evidence").
 */
export function pickWinner(a, b) {
    const evidenceDiff = a.evidence.length - b.evidence.length;
    if (Math.abs(evidenceDiff) >= 2)
        return evidenceDiff > 0 ? a : b;
    const confDiff = a.confidence - b.confidence;
    if (Math.abs(confDiff) > 0.1)
        return confDiff > 0 ? a : b;
    const updatedA = Date.parse(a.updatedAt);
    const updatedB = Date.parse(b.updatedAt);
    if (Number.isFinite(updatedA) && Number.isFinite(updatedB) && updatedA !== updatedB) {
        return updatedA > updatedB ? a : b;
    }
    return a;
}
/** Record detected conflicts; resolution only marks the loser as superseded. */
export function applyConflicts(db, candidates, options = {}) {
    const now = options.now ?? new Date();
    const out = [];
    const exists = db.prepare('SELECT 1 AS x FROM conflicts WHERE winner_id = ? AND loser_id = ? LIMIT 1');
    const insert = db.prepare('INSERT INTO conflicts (winner_id, loser_id, reason, at) VALUES (?, ?, ?, ?)');
    const supersede = db.prepare("UPDATE records SET superseded_by = ?, status = 'archived', updated_at = ? WHERE id = ?");
    for (const candidate of candidates) {
        const already = exists.get(candidate.winner.id, candidate.loser.id) !== undefined;
        if (!already)
            insert.run(candidate.winner.id, candidate.loser.id, candidate.reason, now.toISOString());
        let resolved = false;
        if (options.resolve === true) {
            supersede.run(candidate.winner.id, now.toISOString(), candidate.loser.id);
            resolved = true;
        }
        out.push({ ...candidate, recorded: true, resolved });
    }
    return out;
}
/** Conflict rows for `memory_stats`. */
export function conflictCount(db) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM conflicts').get();
    return typeof row?.['n'] === 'number' ? row['n'] : 0;
}
/** Active records, newest first — the input set for conflict detection. */
export function activeRecords(db, limit = 500) {
    return listRecords(db, { status: ['active', 'pending'], limit });
}
//# sourceMappingURL=conflicts.js.map