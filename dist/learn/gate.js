import { cjkBigrams } from '../store/sqlite/cjk.js';
import { extractTerms, getRecord, listRecords, materialize, rawSearch, upsertRecord } from '../store/sqlite/records.js';
import { nextConfidence, statusFor } from './confidence.js';
import { assertDraftScope, equivalentIds } from '../store/guard.js';
/** Similarity threshold above which two records are considered the same lesson. */
export const MERGE_THRESHOLD = 0.7;
/** Token set for similarity: ASCII words plus CJK bigrams. */
export function tokens(text) {
    const out = new Set(extractTerms(text, 64));
    for (const bigram of cjkBigrams(text).split(' ')) {
        if (bigram !== '')
            out.add(bigram);
    }
    return out;
}
export function jaccard(a, b) {
    if (a.size === 0 || b.size === 0)
        return 0;
    let shared = 0;
    for (const token of a)
        if (b.has(token))
            shared += 1;
    return shared / (a.size + b.size - shared);
}
/** Similarity between a draft and an existing record (title weighted double). */
export function similarity(draft, existing) {
    const draftBody = tokens(draft.body);
    const existingBody = tokens(existing.body);
    const bodySim = jaccard(draftBody, existingBody);
    const titleSim = jaccard(tokens(draft.title), tokens(existing.title));
    return Math.max(titleSim, 0.5 * titleSim + 0.5 * bodySim);
}
/** True when the text looks like a vague platitude rather than a lesson. */
export function looksGeneric(body) {
    const trimmed = body.trim();
    if (trimmed.length < 12)
        return true;
    const hasScene = /[：:，,。.;；!！?？]|触发|场景|当|如果|when|if|because|since/i.test(trimmed);
    return !hasScene && trimmed.length < 40;
}
/** Cap confidence for claims that carry no evidence (DESIGN §8). */
export function evidenceCappedConfidence(confidence, evidenceCount) {
    if (evidenceCount > 0)
        return confidence;
    return Math.min(confidence, 0.55);
}
/** Decide what to do with a draft; does not write anything. */
export function gateDraft(db, fts5, draft) {
    const title = draft.title.trim();
    const body = draft.body.trim();
    if (title.length < 4)
        return { action: 'reject', reason: 'title too short', similarity: 0, confidence: 0 };
    if (body.length < 12)
        return { action: 'reject', reason: 'body too short', similarity: 0, confidence: 0 };
    if (looksGeneric(body))
        return { action: 'reject', reason: 'no concrete trigger or action', similarity: 0, confidence: 0 };
    const confidence = evidenceCappedConfidence(draft.confidence, draft.evidence?.length ?? 0);
    const candidates = similarRecords(db, fts5, draft);
    let best;
    for (const record of candidates) {
        const score = similarity(draft, record);
        if (best === undefined || score > best.score)
            best = { record, score };
    }
    if (best !== undefined && best.score >= MERGE_THRESHOLD) {
        return {
            action: 'merge',
            reason: `similar to ${best.record.id} (${best.score.toFixed(2)})`,
            similarity: best.score,
            target: best.record,
            confidence,
        };
    }
    return { action: 'create', reason: 'new lesson', similarity: best?.score ?? 0, confidence };
}
/** Existing records worth comparing against (FTS first, recent records as backstop). */
function similarRecords(db, fts5, draft) {
    const terms = extractTerms(`${draft.title} ${draft.body}`, 12);
    const hits = rawSearch(db, terms, fts5, { status: ['active', 'pending'], limit: 20 });
    const records = hits
        .map((hit) => getRecord(db, hit.id))
        .filter((record) => record !== undefined);
    if (records.length > 0)
        return records;
    // backstop: the slug may collide even when the text drifted
    // Dash-equivalent ids count as the same record: the fallback script writes
    // `dsh-session--append` where this plugin writes `dsh-session-append`, and
    // treating them as different lessons duplicated one lesson into two rows.
    const byId = getRecord(db, slugOf(draft.title)) ??
        listRecords(db).find((record) => equivalentIds(record.id, slugOf(draft.title)));
    return byId === undefined ? [] : [byId];
}
function slugOf(title) {
    return materialize({ title, body: 'x', layer: 'project', scopeKind: 'project' }).id;
}
/** Merge a draft into an existing record, keeping the curated content intact. */
export function mergeRecord(existing, draft, now = new Date()) {
    const timesSeen = existing.timesSeen + 1;
    const updatedAt = now.toISOString();
    // Repetition still raises confidence (DESIGN §7: times_seen is evidence), but
    // the after-recall penalty is neutralised here — it is applied exactly once,
    // by the attribution path that observes the failure (`applyOutcome`).
    // Re-deriving it on every merge charged the same historical failures over and
    // over and could push a good lesson below its own starting point.
    const floor = Math.max(existing.confidence, draft.confidence);
    const grown = nextConfidence({
        base: floor,
        timesSeen,
        successAfterRecall: 0,
        failAfterRecall: 0,
        updatedAt,
        now,
    });
    const confidence = Math.max(floor, grown);
    const mergedEvidence = dedupeEvidence([...existing.evidence, ...(draft.evidence ?? [])]);
    // DESIGN §8: the body takes the *newer* observation. The old rule only
    // accepted a candidate more than 30% longer, so a corrected instruction of
    // similar length was silently dropped while its metadata was refreshed.
    const candidateBody = draft.body.trim();
    const body = candidateBody !== '' ? candidateBody : existing.body;
    const tags = [...new Set([...existing.tags, ...(draft.tags ?? [])])];
    return {
        ...existing,
        body,
        tags,
        confidence,
        timesSeen,
        updatedAt,
        evidence: mergedEvidence,
        status: existing.status === 'archived' ? existing.status : statusFor(confidence),
        origin: existing.origin ?? draft.origin,
    };
}
function dedupeEvidence(items) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const key = `${item.kind}|${item.detail ?? ''}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}
/**
 * Gate and persist a draft. `evidence` rows are written with the record, and a
 * merged record keeps its identity so links and usage history survive.
 */
export function applyDraft(db, scope, fts5, draft, now = new Date()) {
    const decision = gateDraft(db, fts5, draft);
    if (decision.action === 'reject') {
        return { action: 'reject', recordId: '', reason: decision.reason, confidence: 0 };
    }
    const layer = scope.kind === 'project' ? 'project' : 'global';
    if (decision.action === 'merge' && decision.target !== undefined) {
        const merged = mergeRecord(decision.target, draft, now);
        assertDraftScope(merged, scope);
        upsertRecord(db, merged);
        return {
            action: 'merge',
            recordId: merged.id,
            reason: decision.reason,
            confidence: merged.confidence,
            record: merged,
        };
    }
    // DESIGN §7: a model-distilled candidate enters `pending` below the human
    // threshold, so unreviewed model output is never injected as if someone had
    // confirmed it. Repetition still promotes it through the normal rules.
    const distilledCandidate = draft.origin === 'distilled';
    const record = materialize({
        title: draft.title.trim(),
        body: draft.body.trim(),
        layer,
        scopeKind: scope.kind,
        ...(scope.repo !== undefined ? { repo: scope.repo } : {}),
        confidence: distilledCandidate ? Math.min(decision.confidence, 0.6) : decision.confidence,
        ...(draft.expiresAt !== undefined ? { expiresAt: draft.expiresAt } : {}),
        ...(draft.tags !== undefined ? { tags: draft.tags } : {}),
        ...(draft.evidence !== undefined ? { evidence: draft.evidence } : {}),
        origin: draft.origin,
        ...(draft.source !== undefined ? { source: draft.source } : {}),
        ...(draft.status !== undefined && !distilledCandidate ? { status: draft.status } : {}),
        ...(distilledCandidate ? { status: 'pending' } : {}),
    }, now.toISOString());
    // Two different lessons can collapse to the same slug (titles differ only in
    // characters that are stripped) — `dsh: 记忆插件` and `dsh: 权限模式` both
    // become `dsh`. Writing the second one over the first replaced it wholesale:
    // body, evidence, counters and status all belonged to another lesson.
    let unique = record;
    if (getRecord(db, record.id) !== undefined) {
        let suffix = 2;
        while (getRecord(db, `${record.id}-${suffix}`) !== undefined)
            suffix += 1;
        unique = { ...record, id: `${record.id}-${suffix}` };
    }
    assertDraftScope(unique, scope);
    upsertRecord(db, unique);
    return { action: 'create', recordId: unique.id, reason: decision.reason, confidence: unique.confidence, record: unique };
}
//# sourceMappingURL=gate.js.map