import { log } from '../../log.js';
import { cjkBigrams } from './cjk.js';
import { CORE_TABLES_SQL, FTS_REBUILD_SQL, FTS_SQL, MIGRATE_V2_SQL, SCHEMA_VERSION } from './schema.js';
let modulePromise;
let loadError;
/**
 * Load `node:sqlite` once. Resolves to `undefined` when the module cannot be
 * imported (older Node without the flag), recording the reason for the probe.
 */
export function loadSqliteModule() {
    modulePromise ??= (async () => {
        try {
            const mod = (await import('node:sqlite'));
            return mod;
        }
        catch (error) {
            loadError = error instanceof Error ? error.message : String(error);
            return undefined;
        }
    })();
    return modulePromise;
}
/** Test an in-memory database for driver + FTS5 support. */
export function probeSqlite(mod) {
    let db;
    try {
        db = new mod.DatabaseSync(':memory:');
        const version = rowStr(db.prepare('select sqlite_version() as v').get(), 'v') ?? 'unknown';
        let fts5 = false;
        try {
            db.exec('CREATE VIRTUAL TABLE probe_fts USING fts5(x)');
            fts5 = true;
        }
        catch {
            fts5 = false;
        }
        return { available: true, sqliteVersion: version, fts5 };
    }
    catch (error) {
        return {
            available: false,
            reason: error instanceof Error ? error.message : String(error),
            fts5: false,
        };
    }
    finally {
        try {
            db?.close();
        }
        catch {
            // ignore
        }
    }
}
/** Open (and migrate) one memory database. Throws only on a genuine DB error. */
export function openDatabase(mod, options) {
    const db = new mod.DatabaseSync(options.file, { enableForeignKeyConstraints: true });
    db.exec(`PRAGMA journal_mode = ${options.journalMode === 'wal' ? 'WAL' : 'DELETE'}`);
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs))}`);
    db.exec('PRAGMA synchronous = NORMAL');
    migrate(db, options.fts5);
    return db;
}
/** Apply or upgrade the schema. Idempotent; safe to call on every open. */
export function migrate(db, fts5) {
    db.exec(CORE_TABLES_SQL);
    const current = Number(getMeta(db, 'schema_version') ?? '0');
    const needsV2 = Number.isFinite(current) && current > 0 && current < 2;
    if (needsV2) {
        try {
            db.exec(MIGRATE_V2_SQL);
        }
        catch (error) {
            log('warn', 'memory: v1→v2 migration failed:', error);
        }
    }
    if (fts5) {
        try {
            db.exec(FTS_SQL);
        }
        catch (error) {
            log('warn', 'memory: FTS schema failed, falling back to LIKE search:', error);
        }
    }
    if (needsV2) {
        // Order matters: `backfillCjk` UPDATEs every row, and with an *empty*
        // external-content FTS index the update triggers the `'delete'` command
        // against rows the index never had — node:sqlite then reports
        // `database disk image is malformed` (errcode 267) and the database can
        // never be opened again. Filling the index first (or dropping it) makes
        // the same UPDATE harmless.
        if (fts5) {
            try {
                db.exec('DROP TABLE IF EXISTS records_fts');
                db.exec(FTS_SQL);
                db.exec(FTS_REBUILD_SQL);
            }
            catch (error) {
                log('warn', 'memory: preparing the FTS index before backfill failed:', error);
            }
        }
        backfillCjk(db);
        rebuildFts(db, fts5);
    }
    if (!Number.isFinite(current) || current < SCHEMA_VERSION) {
        setMeta(db, 'schema_version', String(SCHEMA_VERSION));
        setMeta(db, 'schema_updated_at', new Date().toISOString());
    }
}
/** Fill the CJK bigram column for rows that predate schema v2. */
export function backfillCjk(db) {
    const rows = db.prepare("SELECT id, title, body, tags FROM records WHERE cjk = ''").all();
    if (rows.length === 0)
        return 0;
    const update = db.prepare('UPDATE records SET cjk = ? WHERE id = ?');
    let filled = 0;
    for (const row of rows) {
        const id = rowStr(row, 'id');
        if (id === undefined)
            continue;
        const text = `${rowStr(row, 'title') ?? ''} ${rowStr(row, 'body') ?? ''} ${rowStr(row, 'tags') ?? ''}`;
        update.run(cjkBigrams(text), id);
        filled += 1;
    }
    log('info', `memory: backfilled CJK bigrams for ${filled} record(s)`);
    return filled;
}
/** Rebuild the FTS index from `records` (repair after bulk writes or corruption). */
export function rebuildFts(db, fts5) {
    if (!fts5)
        return;
    try {
        db.exec(FTS_REBUILD_SQL);
    }
    catch (error) {
        log('warn', 'memory: FTS rebuild failed:', error);
    }
}
export function getMeta(db, key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return rowStr(row, 'value');
}
export function setMeta(db, key, value) {
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
/** Run `body` inside a transaction, rolling back on any throw. */
export function transact(db, body) {
    db.exec('BEGIN');
    try {
        const result = body();
        db.exec('COMMIT');
        return result;
    }
    catch (error) {
        try {
            db.exec('ROLLBACK');
        }
        catch {
            // ignore: the original error is the useful one
        }
        throw error;
    }
}
// ---- row coercion -----------------------------------------------------------
// `node:sqlite` returns `Record<string, SQLOutputValue>`; these helpers keep the
// mapping code honest under `strict` + `noUncheckedIndexedAccess`.
export function rowStr(row, key) {
    const value = row?.[key];
    return typeof value === 'string' ? value : undefined;
}
export function rowNum(row, key) {
    const value = row?.[key];
    if (typeof value === 'number')
        return value;
    if (typeof value === 'bigint')
        return Number(value);
    return undefined;
}
export function rowInt(row, key, fallback = 0) {
    return rowNum(row, key) ?? fallback;
}
export function rowReal(row, key, fallback = 0) {
    return rowNum(row, key) ?? fallback;
}
//# sourceMappingURL=db.js.map