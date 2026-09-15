/**
 * Core memory data model (docs/DESIGN.md §3, §5).
 *
 * A record's *layer* answers "what kind of memory is this"; its *scope* answers
 * "which memory root owns it". Project-scoped records live only under
 * `<repo>/.dsh/memory` and are never written to the global root (invariant 2/3).
 */
/** Memory layers (DESIGN §3). `episodic` records are derived, not authored. */
export type Layer = 'project' | 'global' | 'profile' | 'episodic';
/** Which memory root owns a record. Physical isolation: one DB per scope. */
export type ScopeKind = 'project' | 'global';
/** `pending` = distilled but not yet gated into the active set (conf <= 0.6). */
export type RecordStatus = 'active' | 'pending' | 'archived';
/** Objective pain signals; `self-report` is the weakest and never sufficient alone. */
export type EvidenceKind = 'tool-failure' | 'request-error' | 'user-correction' | 'rework' | 'permission-prompt' | 'test-failure' | 'user-statement' | 'self-report';
export interface Evidence {
    kind: EvidenceKind;
    detail?: string;
    turn?: number;
    /** ISO-8601 timestamp. */
    at: string;
}
export interface RecordSource {
    sessionId?: string;
    turn?: number;
    taskId?: string;
}
export interface MemoryRecord {
    /** Stable slug; mirrors `memory-lesson.sh` (title → slug, or `zh-<sha1>`). */
    id: string;
    layer: Layer;
    scopeKind: ScopeKind;
    /** Repository root, present iff `scopeKind === 'project'`. */
    repo?: string;
    title: string;
    body: string;
    tags: string[];
    /** 0..1. `<0.7` means hypothesis: surfaced, never executed. */
    confidence: number;
    /** `YYYY-MM-DD`, or undefined for permanent. */
    expiresAt?: string;
    timesSeen: number;
    timesRecalled: number;
    successAfterRecall: number;
    failAfterRecall: number;
    supersededBy?: string;
    status: RecordStatus;
    /** How the record entered the store: distilled | user | skill | imported. */
    origin?: string;
    createdAt: string;
    updatedAt: string;
    source?: RecordSource;
    evidence: Evidence[];
}
/** A record before persistence fills in ids, timestamps and counters. */
export interface DraftRecord {
    title: string;
    body: string;
    layer?: Layer;
    confidence?: number;
    expiresAt?: string;
    tags?: string[];
    evidence?: Evidence[];
    origin?: string;
    source?: RecordSource;
}
/** The resolved owner of a memory operation: one root, one DB, one scope kind. */
export interface MemoryScope {
    kind: ScopeKind;
    /** Repository root for project scopes. */
    repo?: string;
    /** Absolute memory root directory (`<dshHome>/memory` or `<repo>/.dsh/memory`). */
    root: string;
    /** Why this scope was chosen — surfaced in logs and `memory_stats`. */
    reason: 'session-cwd' | 'process-cwd' | 'no-project-context' | 'explicit-global';
}
/** Ranking weights per layer (DESIGN §6). */
export declare const LAYER_WEIGHT: Record<Layer, number>;
//# sourceMappingURL=types.d.ts.map