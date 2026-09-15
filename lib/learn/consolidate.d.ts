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
    errors: string[];
}
/** Lessons that have proven themselves often enough to become a skill. */
export declare function promotionCandidates(db: DatabaseSync, options?: ConsolidateOptions): MemoryRecord[];
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