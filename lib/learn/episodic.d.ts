import type { DatabaseSync } from 'node:sqlite';
import type { MemoryScope } from '../store/types.js';
import type { Signal } from './signals.js';
import type { RedactPolicy } from './redact.js';
export interface EpisodeInput {
    sessionId: string;
    turn: number;
    signals: readonly Signal[];
    verdict: 'failure' | 'success' | 'neutral';
    /** Recalled record ids for this turn, for later attribution. */
    recalled?: readonly string[];
    /**
     * How much of the user's own words to keep (`episodic.captureUserText`).
     * `none` stores the signal kind and tool but drops the detail entirely.
     */
    captureUserText?: RedactPolicy;
}
/** Directory holding episode logs for one scope. */
export declare function sessionsDir(scope: MemoryScope): string;
/** Episode file name: date-stamped and session-scoped. */
export declare function sessionFilePath(scope: MemoryScope, sessionId: string, now?: Date): string;
/** Persist one turn's signals: JSONL view + `signals` rows. */
export declare function recordEpisode(db: DatabaseSync, scope: MemoryScope, input: EpisodeInput, now?: Date): number;
export interface EpisodeDigest {
    sessions: number;
    signals: number;
    byKind: Record<string, number>;
}
/** Aggregate episode signals for `memory_stats`. */
export declare function episodeDigest(db: DatabaseSync, sinceDays?: number): EpisodeDigest;
/**
 * Delete `signals` rows older than the retention window.
 *
 * The pending-distillation window is 14 days, so anything past the retention
 * period can no longer be recovered and only costs space. Rows are deleted only
 * when they have already been distilled *or* are far past recovery age — a debt
 * is never silently dropped.
 */
export declare function pruneSignals(db: DatabaseSync, retentionDays: number, now?: Date): number;
/** Signals older than this are never recovered, so they may be pruned. */
export declare const PENDING_RETENTION_DAYS = 14;
/** Delete episode files older than the retention window (D5: 90 days). */
export declare function pruneEpisodes(scope: MemoryScope, retentionDays: number, now?: Date): number;
//# sourceMappingURL=episodic.d.ts.map