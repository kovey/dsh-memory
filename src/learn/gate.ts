/**
 * Write gate (DESIGN §8): nothing enters the active store without passing the
 * same door, whether it came from the model (`memory_save`) or from automatic
 * distillation.
 *
 * The gate rejects noise, merges near-duplicates instead of piling up variants,
 * and caps confidence for claims that carry no evidence.
 */
import type { DatabaseSync } from 'node:sqlite'
import { cjkBigrams } from '../store/sqlite/cjk.js'
import { extractTerms, getRecord, materialize, rawSearch, upsertRecord } from '../store/sqlite/records.js'
import type { Evidence, MemoryRecord, MemoryScope } from '../store/types.js'
import { nextConfidence, statusFor } from './confidence.js'

export interface CandidateDraft {
    title: string
    body: string
    confidence: number
    tags?: string[]
    evidence?: Evidence[]
    origin: string
    source?: MemoryRecord['source']
    /** Caller-supplied expiry (`YYYY-MM-DD`); undefined means permanent. */
    expiresAt?: string
    /** Force the record status (used by tests and explicit user saves). */
    status?: 'active' | 'pending'
}

export type GateAction = 'create' | 'merge' | 'reject'

export interface GateDecision {
    action: GateAction
    reason: string
    similarity: number
    target?: MemoryRecord
    /** Confidence actually stored (evidence caps applied). */
    confidence: number
}

/** Similarity threshold above which two records are considered the same lesson. */
export const MERGE_THRESHOLD = 0.7

/** Token set for similarity: ASCII words plus CJK bigrams. */
export function tokens(text: string): Set<string> {
    const out = new Set<string>(extractTerms(text, 64))
    for (const bigram of cjkBigrams(text).split(' ')) {
        if (bigram !== '') out.add(bigram)
    }
    return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0
    let shared = 0
    for (const token of a) if (b.has(token)) shared += 1
    return shared / (a.size + b.size - shared)
}

/** Similarity between a draft and an existing record (title weighted double). */
export function similarity(draft: CandidateDraft, existing: MemoryRecord): number {
    const draftBody = tokens(draft.body)
    const existingBody = tokens(existing.body)
    const bodySim = jaccard(draftBody, existingBody)
    const titleSim = jaccard(tokens(draft.title), tokens(existing.title))
    return Math.max(titleSim, 0.5 * titleSim + 0.5 * bodySim)
}

/** True when the text looks like a vague platitude rather than a lesson. */
export function looksGeneric(body: string): boolean {
    const trimmed = body.trim()
    if (trimmed.length < 12) return true
    const hasScene = /[：:，,。.;；!！?？]|触发|场景|当|如果|when|if|because|since/i.test(trimmed)
    return !hasScene && trimmed.length < 40
}

/** Cap confidence for claims that carry no evidence (DESIGN §8). */
export function evidenceCappedConfidence(confidence: number, evidenceCount: number): number {
    if (evidenceCount > 0) return confidence
    return Math.min(confidence, 0.55)
}

/** Decide what to do with a draft; does not write anything. */
export function gateDraft(db: DatabaseSync, fts5: boolean, draft: CandidateDraft): GateDecision {
    const title = draft.title.trim()
    const body = draft.body.trim()
    if (title.length < 4) return { action: 'reject', reason: 'title too short', similarity: 0, confidence: 0 }
    if (body.length < 12) return { action: 'reject', reason: 'body too short', similarity: 0, confidence: 0 }
    if (looksGeneric(body)) return { action: 'reject', reason: 'no concrete trigger or action', similarity: 0, confidence: 0 }

    const confidence = evidenceCappedConfidence(draft.confidence, draft.evidence?.length ?? 0)
    const candidates = similarRecords(db, fts5, draft)
    let best: { record: MemoryRecord; score: number } | undefined
    for (const record of candidates) {
        const score = similarity(draft, record)
        if (best === undefined || score > best.score) best = { record, score }
    }
    if (best !== undefined && best.score >= MERGE_THRESHOLD) {
        return {
            action: 'merge',
            reason: `similar to ${best.record.id} (${best.score.toFixed(2)})`,
            similarity: best.score,
            target: best.record,
            confidence,
        }
    }
    return { action: 'create', reason: 'new lesson', similarity: best?.score ?? 0, confidence }
}

/** Existing records worth comparing against (FTS first, recent records as backstop). */
function similarRecords(db: DatabaseSync, fts5: boolean, draft: CandidateDraft): MemoryRecord[] {
    const terms = extractTerms(`${draft.title} ${draft.body}`, 12)
    const hits = rawSearch(db, terms, fts5, { status: ['active', 'pending'], limit: 20 })
    const records = hits
        .map((hit) => getRecord(db, hit.id))
        .filter((record): record is MemoryRecord => record !== undefined)
    if (records.length > 0) return records
    // backstop: the slug may collide even when the text drifted
    const byId = getRecord(db, slugOf(draft.title))
    return byId === undefined ? [] : [byId]
}

function slugOf(title: string): string {
    return materialize({ title, body: 'x', layer: 'project', scopeKind: 'project' }).id
}

/** Merge a draft into an existing record, keeping the curated content intact. */
export function mergeRecord(existing: MemoryRecord, draft: CandidateDraft, now = new Date()): MemoryRecord {
    const timesSeen = existing.timesSeen + 1
    const base = Math.max(existing.confidence, draft.confidence)
    const updatedAt = now.toISOString()
    const confidence = nextConfidence({
        base,
        timesSeen,
        successAfterRecall: existing.successAfterRecall,
        failAfterRecall: existing.failAfterRecall,
        updatedAt,
        now,
    })
    const mergedEvidence = dedupeEvidence([...existing.evidence, ...(draft.evidence ?? [])])
    const body = draft.body.trim().length > existing.body.trim().length * 1.3 ? draft.body.trim() : existing.body
    const tags = [...new Set([...existing.tags, ...(draft.tags ?? [])])]
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
    }
}

function dedupeEvidence(items: readonly Evidence[]): Evidence[] {
    const seen = new Set<string>()
    const out: Evidence[] = []
    for (const item of items) {
        const key = `${item.kind}|${item.detail ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(item)
    }
    return out
}

export interface ApplyResult {
    action: GateAction
    recordId: string
    reason: string
    confidence: number
    record?: MemoryRecord
}

/**
 * Gate and persist a draft. `evidence` rows are written with the record, and a
 * merged record keeps its identity so links and usage history survive.
 */
export function applyDraft(
    db: DatabaseSync,
    scope: MemoryScope,
    fts5: boolean,
    draft: CandidateDraft,
    now = new Date(),
): ApplyResult {
    const decision = gateDraft(db, fts5, draft)
    if (decision.action === 'reject') {
        return { action: 'reject', recordId: '', reason: decision.reason, confidence: 0 }
    }
    const layer = scope.kind === 'project' ? 'project' : 'global'
    if (decision.action === 'merge' && decision.target !== undefined) {
        const merged = mergeRecord(decision.target, draft, now)
        upsertRecord(db, merged)
        return {
            action: 'merge',
            recordId: merged.id,
            reason: decision.reason,
            confidence: merged.confidence,
            record: merged,
        }
    }
    const record = materialize(
        {
            title: draft.title.trim(),
            body: draft.body.trim(),
            layer,
            scopeKind: scope.kind,
            ...(scope.repo !== undefined ? { repo: scope.repo } : {}),
            confidence: decision.confidence,
            ...(draft.expiresAt !== undefined ? { expiresAt: draft.expiresAt } : {}),
            ...(draft.tags !== undefined ? { tags: draft.tags } : {}),
            ...(draft.evidence !== undefined ? { evidence: draft.evidence } : {}),
            origin: draft.origin,
            ...(draft.source !== undefined ? { source: draft.source } : {}),
            ...(draft.status !== undefined ? { status: draft.status } : {}),
        },
        now.toISOString(),
    )
    upsertRecord(db, record)
    return { action: 'create', recordId: record.id, reason: decision.reason, confidence: record.confidence, record }
}
