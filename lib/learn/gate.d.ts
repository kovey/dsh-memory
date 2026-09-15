/**
 * Write gate (DESIGN §8): nothing enters the active store without passing the
 * same door, whether it came from the model (`memory_save`) or from automatic
 * distillation.
 *
 * The gate rejects noise, merges near-duplicates instead of piling up variants,
 * and caps confidence for claims that carry no evidence.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Evidence, MemoryRecord, MemoryScope } from '../store/types.js';
export interface CandidateDraft {
    title: string;
    body: string;
    confidence: number;
    tags?: string[];
    evidence?: Evidence[];
    origin: string;
    source?: MemoryRecord['source'];
    /** Caller-supplied expiry (`YYYY-MM-DD`); undefined means permanent. */
    expiresAt?: string;
    /** Force the record status (used by tests and explicit user saves). */
    status?: 'active' | 'pending';
}
export type GateAction = 'create' | 'merge' | 'reject';
export interface GateDecision {
    action: GateAction;
    reason: string;
    similarity: number;
    target?: MemoryRecord;
    /** Confidence actually stored (evidence caps applied). */
    confidence: number;
}
/** Similarity threshold above which two records are considered the same lesson. */
export declare const MERGE_THRESHOLD = 0.7;
/** Token set for similarity: ASCII words plus CJK bigrams. */
export declare function tokens(text: string): Set<string>;
export declare function jaccard(a: Set<string>, b: Set<string>): number;
/** Similarity between a draft and an existing record (title weighted double). */
export declare function similarity(draft: CandidateDraft, existing: MemoryRecord): number;
/** True when the text looks like a vague platitude rather than a lesson. */
export declare function looksGeneric(body: string): boolean;
/** Cap confidence for claims that carry no evidence (DESIGN §8). */
export declare function evidenceCappedConfidence(confidence: number, evidenceCount: number): number;
/** Decide what to do with a draft; does not write anything. */
export declare function gateDraft(db: DatabaseSync, fts5: boolean, draft: CandidateDraft): GateDecision;
/** Merge a draft into an existing record, keeping the curated content intact. */
export declare function mergeRecord(existing: MemoryRecord, draft: CandidateDraft, now?: Date): MemoryRecord;
export interface ApplyResult {
    action: GateAction;
    recordId: string;
    reason: string;
    confidence: number;
    record?: MemoryRecord;
}
/**
 * Gate and persist a draft. `evidence` rows are written with the record, and a
 * merged record keeps its identity so links and usage history survive.
 */
export declare function applyDraft(db: DatabaseSync, scope: MemoryScope, fts5: boolean, draft: CandidateDraft, now?: Date): ApplyResult;
//# sourceMappingURL=gate.d.ts.map