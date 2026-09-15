import { log } from '../log.js';
import { ensureDir } from '../paths.js';
import { exportAll, exportIndex } from './export.js';
import { bootstrapImport, importLessons } from './import.js';
import { importMetrics } from './metrics.js';
import { backfillCjk, getMeta, openDatabase, probeSqlite, rebuildFts, rowStr, setMeta } from './sqlite/db.js';
import { countRecords } from './sqlite/records.js';
import { CORE_TABLES_SQL, FTS_REBUILD_SQL, FTS_SQL, SCHEMA_VERSION } from './sqlite/schema.js';
/**
 * Drop the derived FTS index so it can be created and repopulated from scratch.
 *
 * Mirrors the FTS half of `MIGRATE_V2_SQL` (schema.ts owns the index definition;
 * this is the repair path for a store that a broken migration left behind).
 * Only derived data is lost — `records` itself is never touched.
 */
const DROP_FTS_INDEX_SQL = `
DROP TRIGGER IF EXISTS records_fts_ai;
DROP TRIGGER IF EXISTS records_fts_ad;
DROP TRIGGER IF EXISTS records_fts_au;
DROP TABLE IF EXISTS records_fts;
`;
export class StoreRegistry {
    config;
    stores = new Map();
    probe = { available: false, reason: 'not probed', fts5: false };
    module;
    constructor(config) {
        this.config = config;
    }
    /** Load the driver and probe capabilities once; safe to call repeatedly. */
    async initialize(loadModule) {
        const report = { probe: this.probe, opened: 0, errors: [] };
        this.module = await loadModule();
        if (this.module === undefined) {
            this.probe = { available: false, reason: 'node:sqlite could not be imported', fts5: false };
            report.probe = this.probe;
            return report;
        }
        this.probe = probeSqlite(this.module);
        report.probe = this.probe;
        if (!this.probe.available) {
            return report;
        }
        if (!this.probe.fts5) {
            log('warn', 'memory: SQLite build lacks FTS5 — ranked search degrades to LIKE matching');
        }
        return report;
    }
    get available() {
        return this.module !== undefined && this.probe.available;
    }
    get capabilities() {
        return this.probe;
    }
    /** Open (or reuse) the database for `scope`. Returns undefined when unavailable. */
    open(scope) {
        const existing = this.stores.get(scope.root);
        if (existing !== undefined) {
            this.touch(existing);
            return existing;
        }
        if (this.module === undefined || !this.probe.available)
            return undefined;
        if (!ensureDir(scope.root)) {
            log('warn', `memory: cannot create memory root ${scope.root} (sandbox denial?)`);
            return undefined;
        }
        const db = this.openDatabaseFor(scope);
        if (db === undefined)
            return undefined;
        const now = new Date().toISOString();
        const store = { scope, db, fts5: this.probe.fts5, openedAt: now, lastUsedAt: now };
        this.stores.set(scope.root, store);
        this.bootstrap(store);
        return store;
    }
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
    openDatabaseFor(scope) {
        const mod = this.module;
        if (mod === undefined)
            return undefined;
        const options = {
            file: `${scope.root}/memory.db`,
            journalMode: this.config.sqlite.journalMode,
            busyTimeoutMs: this.config.sqlite.busyTimeoutMs,
            fts5: this.probe.fts5,
        };
        try {
            return openDatabase(mod, options);
        }
        catch (error) {
            const version = readSchemaVersion(mod, options.file);
            log('error', `memory: schema migration failed for ${options.file} (schema_version=${version ?? 'unknown'}): ${describe(error)}`);
            if (!repairFtsIndex(mod, options)) {
                log('error', `memory: ${options.file} is unavailable; memory stays read-only from the text view`);
                return undefined;
            }
            try {
                const db = openDatabase(mod, options);
                log('warn', `memory: recovered ${options.file} — rebuilt the FTS index and re-ran the migration`);
                return db;
            }
            catch (retry) {
                log('error', `memory: ${options.file} still unusable after the FTS repair: ${describe(retry)}`);
                return undefined;
            }
        }
    }
    /** First-open bootstrap: import the text view, then load the metric ledger. */
    bootstrap(store) {
        try {
            const imported = bootstrapImport(store.db, store.scope);
            if (imported !== undefined && imported.imported > 0) {
                log('info', `memory: bootstrapped ${imported.imported} records for ${store.scope.root}`);
            }
            const metrics = importMetrics(store.db, store.scope);
            if (metrics > 0)
                log('info', `memory: imported ${metrics} task metrics for ${store.scope.root}`);
        }
        catch (error) {
            log('warn', 'memory: bootstrap import failed:', error);
        }
    }
    /** Store for `scope`, marked as used (the LRU order of `closeIdle`). */
    lookup(scope) {
        const store = this.stores.get(scope.root);
        if (store !== undefined)
            this.touch(store);
        return store;
    }
    touch(store) {
        store.lastUsedAt = new Date().toISOString();
    }
    /** Re-import the text view into an already-open store. */
    reimport(scope) {
        const store = this.open(scope);
        if (store === undefined)
            return 0;
        const result = importLessons(store.db, store.scope);
        rebuildFts(store.db, store.fts5);
        return result.imported;
    }
    /** Export the store's records back to the git-tracked text view. */
    exportScope(scope) {
        const store = this.lookup(scope);
        if (store === undefined)
            return false;
        try {
            const result = exportAll(store.db, store.scope);
            if (result.errors.length > 0)
                log('warn', 'memory: export reported errors:', result.errors);
            return result.errors.length === 0;
        }
        catch (error) {
            log('error', 'memory: export failed:', error);
            return false;
        }
    }
    exportIndexOnly(scope) {
        const store = this.lookup(scope);
        if (store === undefined)
            return false;
        try {
            exportIndex(store.db, store.scope);
            return true;
        }
        catch (error) {
            log('warn', 'memory: index export failed:', error);
            return false;
        }
    }
    counts(scope) {
        const store = this.lookup(scope);
        return store === undefined ? undefined : countRecords(store.db);
    }
    listOpen() {
        return [...this.stores.values()];
    }
    /** Close one root (used when a scope's work is finished). */
    close(root) {
        const store = this.stores.get(root);
        if (store === undefined)
            return;
        try {
            store.db.close();
        }
        catch (error) {
            log('warn', `memory: closing ${root} failed:`, error);
        }
        this.stores.delete(root);
    }
    /**
     * Release least-recently-used roots until at most `maxOpen` stay open.
     *
     * The host keeps several projects alive at once and `session/disposed` fires
     * per session, so this is the API that actually releases a root while the
     * process runs (`closeAll` only runs at plugin dispose). Closing is safe
     * between operations: the next `open` for that root reopens the database and
     * re-reads whatever the text view has. Returns the roots that were closed.
     */
    closeIdle(maxOpen) {
        const limit = Math.max(0, Math.floor(maxOpen));
        const closed = [];
        while (this.stores.size > limit) {
            let oldest;
            for (const store of this.stores.values()) {
                if (oldest === undefined || store.lastUsedAt < oldest.lastUsedAt)
                    oldest = store;
            }
            if (oldest === undefined)
                break;
            this.close(oldest.scope.root);
            closed.push(oldest.scope.root);
        }
        return closed;
    }
    closeAll() {
        for (const root of [...this.stores.keys()])
            this.close(root);
    }
}
/** `schema_version` of a database file, or undefined when it cannot be read. */
function readSchemaVersion(mod, file) {
    let db;
    try {
        db = new mod.DatabaseSync(file, { readOnly: true });
        return getMeta(db, 'schema_version');
    }
    catch {
        return undefined;
    }
    finally {
        try {
            db?.close();
        }
        catch {
            // the caller's error is the useful one
        }
    }
}
/**
 * Repair a store whose migration failed: recreate the derived FTS index from
 * `records` *before* anything updates a row, then apply the v1→v2 backfill.
 *
 * Order is the whole point. `records_fts` is an external-content index, so an
 * UPDATE on `records` fires the trigger's `'delete'` command; against an index
 * that is still empty (exactly what "rebuild the schema, then backfill" leaves
 * behind) SQLite answers `database disk image is malformed`. Filling the index
 * first makes the same backfill legal, and it never touches `records` content.
 */
function repairFtsIndex(mod, options) {
    let db;
    try {
        db = new mod.DatabaseSync(options.file, { enableForeignKeyConstraints: true });
        db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs))}`);
        db.exec(CORE_TABLES_SQL);
        if (!hasColumn(db, 'records', 'cjk')) {
            db.exec("ALTER TABLE records ADD COLUMN cjk TEXT NOT NULL DEFAULT ''");
        }
        if (options.fts5) {
            db.exec(DROP_FTS_INDEX_SQL);
            db.exec(FTS_SQL);
            db.exec(FTS_REBUILD_SQL);
        }
        backfillCjk(db);
        if (options.fts5)
            db.exec(FTS_REBUILD_SQL);
        setMeta(db, 'schema_version', String(SCHEMA_VERSION));
        setMeta(db, 'schema_updated_at', new Date().toISOString());
        return true;
    }
    catch (error) {
        log('error', `memory: FTS repair of ${options.file} failed: ${describe(error)}`);
        return false;
    }
    finally {
        try {
            db?.close();
        }
        catch {
            // the caller's error is the useful one
        }
    }
}
function hasColumn(db, table, column) {
    const rows = db.prepare('SELECT name FROM pragma_table_info(?)').all(table);
    return rows.some((row) => rowStr(row, 'name') === column);
}
function describe(error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
//# sourceMappingURL=store.js.map