/**
 * Store registry: one open database per memory root, shared by every session
 * that resolves to the same scope (DESIGN §5.2).
 *
 * Sessions are the scope source, so on a host with nvim-tui, web and headless
 * surfaces running at once several roots can be open simultaneously; each root
 * keeps exactly one connection and one writer queue.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryConfig } from '../config.js';
import type { SqliteProbe } from './sqlite/db.js';
import type { RecordCounts } from './sqlite/records.js';
import type { MemoryScope } from './types.js';
type SqliteModule = typeof import('node:sqlite');
export interface ScopeStore {
    scope: MemoryScope;
    db: DatabaseSync;
    fts5: boolean;
    openedAt: string;
    /** Last time this root was opened or used; `closeIdle` releases the oldest. */
    lastUsedAt: string;
}
export interface OpenReport {
    probe: SqliteProbe;
    opened: number;
    errors: string[];
}
export declare class StoreRegistry {
    private readonly config;
    private readonly stores;
    private probe;
    private module;
    constructor(config: MemoryConfig);
    /** Load the driver and probe capabilities once; safe to call repeatedly. */
    initialize(loadModule: () => Promise<SqliteModule | undefined>): Promise<OpenReport>;
    get available(): boolean;
    get capabilities(): SqliteProbe;
    /** Open (or reuse) the database for `scope`. Returns undefined when unavailable. */
    open(scope: MemoryScope): ScopeStore | undefined;
    /**
     * Open one root's database, surviving a failed schema migration.
     *
     * A migration that throws used to be fatal in the worst possible way: the
     * exception escaped through `openDatabase`, `schema_version` stayed at its old
     * value, and every later open repeated the same half-applied migration — the
     * store was locked until somebody deleted `memory.db` by hand. Now the failure
     * is logged with its version and original error, the derived FTS index is
     * rebuilt and the migration retried once; only if that also fails is the root
     * reported as unavailable (the text view keeps working meanwhile).
     */
    private openDatabaseFor;
    /** First-open bootstrap: import the text view, then load the metric ledger. */
    private bootstrap;
    /** Store for `scope`, marked as used (the LRU order of `closeIdle`). */
    private lookup;
    private touch;
    /** Re-import the text view into an already-open store. */
    reimport(scope: MemoryScope): number;
    /** Export the store's records back to the git-tracked text view. */
    exportScope(scope: MemoryScope): boolean;
    exportIndexOnly(scope: MemoryScope): boolean;
    counts(scope: MemoryScope): RecordCounts | undefined;
    listOpen(): ScopeStore[];
    /** Close one root (used when a scope's work is finished). */
    close(root: string): void;
    /**
     * Release least-recently-used roots until at most `maxOpen` stay open.
     *
     * The host keeps several projects alive at once and `session/disposed` fires
     * per session, so this is the API that actually releases a root while the
     * process runs (`closeAll` only runs at plugin dispose). Closing is safe
     * between operations: the next `open` for that root reopens the database and
     * re-reads whatever the text view has. Returns the roots that were closed.
     */
    closeIdle(maxOpen: number): string[];
    closeAll(): void;
}
export {};
//# sourceMappingURL=store.d.ts.map