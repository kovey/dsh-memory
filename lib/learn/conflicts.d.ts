/**
 * Contradiction handling (DESIGN §8).
 *
 * Two lessons can both be true observations and still give opposite advice; when
 * that happens the store must not keep both as equals. Detection is deliberately
 * conservative and explainable — same topic, opposite directive polarity, shared
 * object — because a false positive silently buries a valid lesson.
 *
 * Detection always runs; *resolution* is opt-in (`memory_consolidate` with
 * `resolveConflicts`), so an automatic pass can only propose, never overwrite.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryRecord } from '../store/types.js';
/** Topic similarity above which two records are considered the same subject. */
export declare const TOPIC_THRESHOLD = 0.6;
export interface ConflictCandidate {
    winner: MemoryRecord;
    loser: MemoryRecord;
    topicSimilarity: number;
    reason: string;
}
/**
 * -1 (prohibitive), +1 (prescriptive), 0 (mixed / no directive).
 *
 * A prohibition often contains the very verb it forbids ("不要使用 X"), so the
 * negated span is blanked out before prescriptive markers are counted.
 */
export declare function directivePolarity(body: string): -1 | 0 | 1;
/** The object a directive is about: domain tokens shared by both bodies. */
export declare function sharedObjects(a: string, b: string): string[];
/** Detect contradictions among active records. Pure read. */
export declare function detectConflicts(records: readonly MemoryRecord[]): ConflictCandidate[];
/**
 * The more recent, better-evidenced record wins; ties fall back to confidence
 * (DESIGN §8: "keep the newer / stronger evidence").
 */
export declare function pickWinner(a: MemoryRecord, b: MemoryRecord): MemoryRecord;
export interface ConflictRecord extends ConflictCandidate {
    recorded: boolean;
    resolved: boolean;
}
/** Record detected conflicts; resolution only marks the loser as superseded. */
export declare function applyConflicts(db: DatabaseSync, candidates: readonly ConflictCandidate[], options?: {
    resolve?: boolean;
    now?: Date;
}): ConflictRecord[];
/** Conflict rows for `memory_stats`. */
export declare function conflictCount(db: DatabaseSync): number;
/** Active records, newest first — the input set for conflict detection. */
export declare function activeRecords(db: DatabaseSync, limit?: number): MemoryRecord[];
//# sourceMappingURL=conflicts.d.ts.map