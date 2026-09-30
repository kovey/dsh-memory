/**
 * Consolidation (DESIGN §8, §11 M3): decay, archive, contradiction handling and
 * promotion proposals in one auditable pass.
 *
 * Split by confidence in the mechanism: deterministic work (expiry, staleness,
 * confidence halving) applies automatically, while judgement calls (superseding
 * a contradicting lesson, promoting a lesson into a skill) are recorded as
 * proposals and only carried out when a caller explicitly asks — or a human
 * approves through the `memory-merge` skill.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryRecord, MemoryScope } from '../store/types.js';
export interface ConsolidateOptions {
    dryRun?: boolean;
    /** Write a reviewable `proposals/<id>.SKILL.md` for each promotion (default true). */
    writeSkillDrafts?: boolean;
    resolveConflicts?: boolean;
    now?: Date;
    /** Promotion floor: repetitions required (DESIGN §8: >= 3). */
    promotionMinSeen?: number;
    /** Promotion floor: confidence required (DESIGN §8: >= 0.9). */
    promotionMinConfidence?: number;
    /** Recalls needed before a `pending` record is promoted by use. */
    promotionMinRecalls?: number;
    /** Net-positive recall ratio needed for that promotion. */
    promotionMinSuccessRatio?: number;
}
export interface ProposalDraft {
    kind: 'promote-skill';
    recordId: string;
    title: string;
    rationale: string;
}
export interface ConsolidateReport {
    scope: string;
    dryRun: boolean;
    /** Confidence factor applied to survivors this run. */
    decayFactor: number;
    decayed: number;
    archived: number;
    archivedIds: string[];
    conflictsFound: number;
    conflictsRecorded: number;
    conflictsResolved: number;
    proposals: ProposalDraft[];
    /** Files written for the promotion proposals (empty in a dry run). */
    skillDrafts: string[];
    /** `pending` records promoted to `active` because they were recalled and survived. */
    promotedByUse: string[];
    errors: string[];
}
/** Lessons that have proven themselves often enough to become a skill. */
export declare function promotionCandidates(db: DatabaseSync, options?: ConsolidateOptions): MemoryRecord[];
/**
 * Promote `pending` records that have proven themselves *in use*.
 *
 * DESIGN §7 puts model-distilled candidates in pending so unreviewed output is
 * never injected as fact — but it provided no way out, and the live store drifted
 * to 55 pending of 94 records. The missing half is evidence of use: a candidate
 * that keeps being recalled into turns that end well has earned `active`.
 *
 * Deliberately needs *recalls* (not just age or repetition): existence is not
 * evidence, being retrieved and surviving is.
 */
export declare function promoteByUse(db: DatabaseSync, options?: {
    minRecalls?: number;
    minSuccessRatio?: number;
    now?: Date;
    dryRun?: boolean;
}): MemoryRecord[];
/** Record promotion proposals (idempotent: one open proposal per record). */
export declare function recordProposals(db: DatabaseSync, proposals: readonly ProposalDraft[], now?: Date): number;
export interface OpenProposal {
    kind: string;
    recordId: string;
    title: string;
    rationale: string;
    at: string;
}
export declare function openProposals(db: DatabaseSync, limit?: number): OpenProposal[];
export declare function resolveProposal(db: DatabaseSync, recordId: string, status: 'accepted' | 'rejected'): number;
/** Run one consolidation pass for a scope. */
export declare function consolidate(db: DatabaseSync, scope: MemoryScope, _fts5: boolean, options?: ConsolidateOptions): ConsolidateReport;
/** Render a consolidation report for a tool result. */
export declare function renderReport(report: ConsolidateReport): string;
//# sourceMappingURL=consolidate.d.ts.map