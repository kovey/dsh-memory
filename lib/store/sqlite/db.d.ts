/**
 * SQLite access layer (DESIGN §5.2).
 *
 * `node:sqlite` is loaded lazily and probed once per process: the module, the
 * driver and FTS5 support are all treated as optional capabilities, because the
 * plugin's declared engine range (`^22.19 || >=24`) predates the unflagged
 * module. A missing capability degrades cleanly instead of crashing a session.
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
type SqliteModule = typeof import('node:sqlite');
export interface SqliteProbe {
    available: boolean;
    /** Why the driver is unavailable, when it is. */
    reason?: string;
    sqliteVersion?: string;
    /** Whether this SQLite build supports FTS5 (needed for ranked search). */
    fts5: boolean;
}
/**
 * Load `node:sqlite` once. Resolves to `undefined` when the module cannot be
 * imported (older Node without the flag), recording the reason for the probe.
 */
export declare function loadSqliteModule(): Promise<SqliteModule | undefined>;
/** Test an in-memory database for driver + FTS5 support. */
export declare function probeSqlite(mod: SqliteModule): SqliteProbe;
export interface OpenDbOptions {
    file: string;
    journalMode: 'wal' | 'delete';
    busyTimeoutMs: number;
    fts5: boolean;
}
/** Open (and migrate) one memory database. Throws only on a genuine DB error. */
export declare function openDatabase(mod: SqliteModule, options: OpenDbOptions): DatabaseSync;
/** Apply or upgrade the schema. Idempotent; safe to call on every open. */
export declare function migrate(db: DatabaseSync, fts5: boolean): void;
/** Fill the CJK bigram column for rows that predate schema v2. */
export declare function backfillCjk(db: DatabaseSync): number;
/** Rebuild the FTS index from `records` (repair after bulk writes or corruption). */
export declare function rebuildFts(db: DatabaseSync, fts5: boolean): void;
export declare function getMeta(db: DatabaseSync, key: string): string | undefined;
export declare function setMeta(db: DatabaseSync, key: string, value: string): void;
/** Run `body` inside a transaction, rolling back on any throw. */
export declare function transact<T>(db: DatabaseSync, body: () => T): T;
export declare function rowStr(row: Record<string, SQLOutputValue> | undefined, key: string): string | undefined;
export declare function rowNum(row: Record<string, SQLOutputValue> | undefined, key: string): number | undefined;
export declare function rowInt(row: Record<string, SQLOutputValue> | undefined, key: string, fallback?: number): number;
export declare function rowReal(row: Record<string, SQLOutputValue> | undefined, key: string, fallback?: number): number;
export {};
//# sourceMappingURL=db.d.ts.map