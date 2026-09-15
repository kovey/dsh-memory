import { transact } from '../store/sqlite/db.js';
import { getRecord, upsertRecord } from '../store/sqlite/records.js';
import { nextConfidence } from '../learn/confidence.js';
/** Record injections and bump each record's recall counter. */
export function recordRecalls(db, rows, at = new Date().toISOString()) {
    if (rows.length === 0)
        return 0;
    transact(db, () => {
        const insert = db.prepare('INSERT INTO usage (record_id, session_id, turn, step, score, injected_at, outcome) VALUES (?, ?, ?, ?, ?, ?, NULL)');
        const bump = db.prepare('UPDATE records SET times_recalled = times_recalled + 1 WHERE id = ?');
        for (const row of rows) {
            insert.run(row.recordId, row.sessionId ?? null, row.turn ?? null, row.step ?? null, row.score, at);
            bump.run(row.recordId);
        }
    });
    return rows.length;
}
/**
 * Attribute an outcome to every record injected into one session's turn range.
 * M2 calls this when a turn carries pain signals; success raises the usage
 * weight, failure lowers it (the negative feedback of DESIGN §7).
 */
/**
 * Attribute an outcome and apply DESIGN §7's feedback to the records involved.
 *
 * A memory that keeps being recalled into failing turns must lose confidence —
 * that is the only mechanism that separates "useful memory" from "plausible
 * noise". The penalty is applied here, once per observed failure, because
 * `mergeRecord` no longer re-derives confidence.
 */
export function applyOutcome(db, sessionId, outcome, turn) {
    const attributed = attributeOutcome(db, sessionId, outcome, turn);
    // Success only needs the counter (already bumped) to affect later maths.
    if (attributed === 0 || outcome === 'success')
        return attributed;
    const rows = turn === undefined
        ? db.prepare('SELECT DISTINCT record_id FROM usage WHERE session_id = ?').all(sessionId)
        : db.prepare('SELECT DISTINCT record_id FROM usage WHERE session_id = ? AND turn = ?').all(sessionId, turn);
    transact(db, () => {
        for (const row of rows) {
            const id = row['record_id'];
            if (typeof id !== 'string')
                continue;
            const record = getRecord(db, id);
            if (record === undefined)
                continue;
            // The failure counter was just bumped; re-derive confidence once so a
            // memory that keeps feeding failing turns actually loses confidence.
            const confidence = nextConfidence({
                base: record.confidence,
                timesSeen: record.timesSeen,
                successAfterRecall: record.successAfterRecall,
                failAfterRecall: record.failAfterRecall,
                updatedAt: record.updatedAt,
            });
            if (confidence !== record.confidence)
                upsertRecord(db, { ...record, confidence });
        }
    });
    return attributed;
}
export function attributeOutcome(db, sessionId, outcome, turn) {
    const rows = turn === undefined
        ? db.prepare('SELECT id, record_id FROM usage WHERE session_id = ? AND outcome IS NULL').all(sessionId)
        : db
            .prepare('SELECT id, record_id FROM usage WHERE session_id = ? AND outcome IS NULL AND turn = ?')
            .all(sessionId, turn);
    if (rows.length === 0)
        return 0;
    transact(db, () => {
        const setOutcome = db.prepare('UPDATE usage SET outcome = ? WHERE id = ?');
        const bumpSuccess = db.prepare('UPDATE records SET success_after_recall = success_after_recall + 1 WHERE id = ?');
        const bumpFailure = db.prepare('UPDATE records SET fail_after_recall = fail_after_recall + 1 WHERE id = ?');
        for (const row of rows) {
            const id = row['id'];
            const recordId = row['record_id'];
            if (typeof id !== 'number' && typeof id !== 'bigint')
                continue;
            if (typeof recordId !== 'string')
                continue;
            setOutcome.run(outcome, id);
            if (outcome === 'success')
                bumpSuccess.run(recordId);
            else
                bumpFailure.run(recordId);
        }
    });
    return rows.length;
}
/** Recall statistics for `memory_stats`. */
export function recallStats(db) {
    const row = db
        .prepare(`SELECT COUNT(*) AS total,
                    SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) AS attributed,
                    SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success,
                    SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failure
             FROM usage`)
        .get();
    const num = (key) => {
        const value = row?.[key];
        if (typeof value === 'number')
            return value;
        if (typeof value === 'bigint')
            return Number(value);
        return 0;
    };
    return {
        injections: num('total'),
        attributed: num('attributed'),
        success: num('success'),
        failure: num('failure'),
    };
}
//# sourceMappingURL=usage.js.map