import type { DatabaseSync } from 'node:sqlite';
import type { MemoryScope } from './types.js';
export interface RebuildResult {
    root: string;
    imported: number;
    removed: number;
    metrics: number;
    episodes: number;
    errors: string[];
    /** Rows carried across the rebuild because the text view cannot reproduce them. */
    preserved: Record<string, number>;
}
/** Import `<root>/sessions/*.jsonl` rows into the `signals` table. */
export declare function importEpisodes(db: DatabaseSync, scope: MemoryScope): number;
/**
 * Rebuild one scope from disk: import lessons and metrics, drop records whose
 * lesson file no longer exists, restore episodes, and refresh the search index.
 */
export declare function rebuildScope(db: DatabaseSync, scope: MemoryScope, fts5: boolean): RebuildResult;
/**
 * Compare two roots' records for equivalence — used to prove that a rebuild
 * from the text view reproduces the same memory (M4 acceptance).
 */
export interface RecordFingerprint {
    id: string;
    title: string;
    confidence: number;
    timesSeen: number;
    expiresAt?: string;
    bodyHash: number;
}
export declare function fingerprint(db: DatabaseSync): RecordFingerprint[];
/** Stable 32-bit hash for body comparison; collisions are irrelevant here. */
export declare function hash(text: string): number;
//# sourceMappingURL=rebuild.d.ts.map