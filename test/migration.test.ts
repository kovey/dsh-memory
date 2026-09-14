/**
 * Migration tests: a schema v1 store must survive being opened by this version.
 *
 * The v1→v2 step drops and recreates the external-content FTS index and then
 * backfills the new `cjk` column, so for a moment the index is empty while
 * `records` still gets UPDATEd. FTS5 answers that with
 * `database disk image is malformed`, which used to escape `openDatabase` and
 * leave `schema_version` at 1 — every later open failed the same way and the
 * only way out was deleting `memory.db` by hand. These tests build a real v1
 * database and pin the recoverable behaviour: the store opens, the data is
 * untouched, search works, and a store that genuinely cannot be opened is
 * reported as unavailable without damaging the file or locking the root.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { exportAll } from '../lib/store/export.js'
import { countRecords, extractTerms, getRecord, rawSearch } from '../lib/store/sqlite/records.js'
import { loadSqliteModule, probeSqlite } from '../lib/store/sqlite/db.js'
import { SCHEMA_VERSION } from '../lib/store/sqlite/schema.js'
import { StoreRegistry } from '../lib/store/store.js'
import type { MemoryScope } from '../lib/store/types.js'
import { tempDir } from './helpers.ts'

/** The v1 schema as it shipped: no `cjk` column, three-column FTS index. */
const V1_SCHEMA_SQL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  layer TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  repo TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL,
  expires_at TEXT,
  times_seen INTEGER NOT NULL DEFAULT 1,
  times_recalled INTEGER NOT NULL DEFAULT 0,
  success_after_recall INTEGER NOT NULL DEFAULT 0,
  fail_after_recall INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  origin TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT
);
CREATE VIRTUAL TABLE records_fts USING fts5(
  title, body, tags, content='records', content_rowid='rowid', tokenize='unicode61'
);
CREATE TRIGGER records_fts_ai AFTER INSERT ON records BEGIN
  INSERT INTO records_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;
CREATE TRIGGER records_fts_ad AFTER DELETE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, title, body, tags)
    VALUES ('delete', old.rowid, old.title, old.body, old.tags);
END;
CREATE TRIGGER records_fts_au AFTER UPDATE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, title, body, tags)
    VALUES ('delete', old.rowid, old.title, old.body, old.tags);
  INSERT INTO records_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;
INSERT INTO meta(key, value) VALUES ('schema_version', '1');
INSERT INTO records (id, layer, scope_kind, title, body, tags, confidence, times_seen, status, origin, created_at, updated_at)
  VALUES ('legacy-one', 'global', 'global', '中文教训 legacy', '写入被沙箱拒绝时降级到项目本地。', '[]', 0.8, 3, 'active', 'imported',
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
`

interface V1Fixture {
    scope: MemoryScope
    file: string
    registry: StoreRegistry
}

async function v1Fixture(t: { skip: (reason: string) => void }, label: string): Promise<V1Fixture> {
    const root = tempDir(label)
    const file = path.join(root, 'memory.db')
    const mod = await loadSqliteModule()
    const probe = mod === undefined ? undefined : probeSqlite(mod)
    if (mod === undefined || probe?.available !== true) {
        t.skip('node:sqlite unavailable')
        throw new Error('unreachable')
    }
    if (!probe.fts5) {
        // The v1 schema itself is an FTS5 index; without FTS5 there is no
        // migration to lose.
        t.skip('this SQLite build lacks FTS5')
        throw new Error('unreachable')
    }
    const db = new mod.DatabaseSync(file)
    db.exec(V1_SCHEMA_SQL)
    db.close()
    const registry = new StoreRegistry(resolveConfig({}))
    await registry.initialize(loadSqliteModule)
    if (!registry.available) {
        t.skip('node:sqlite unavailable')
        throw new Error('unreachable')
    }
    return { scope: { kind: 'global', root, reason: 'no-project-context' }, file, registry }
}

function metaVersion(file: string, mod: typeof import('node:sqlite')): string | undefined {
    const db = new mod.DatabaseSync(file, { readOnly: true })
    try {
        const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
        return typeof row?.['value'] === 'string' ? row['value'] : undefined
    } finally {
        db.close()
    }
}

test('opens a schema v1 store: migration failure is recovered, data intact', async (t) => {
    const { scope, file, registry } = await v1Fixture(t, 'migration-v1')
    const mod = await loadSqliteModule()
    assert.ok(mod)

    // Sanity: the fixture really is a v1 database whose FTS index is empty.
    assert.equal(metaVersion(file, mod), '1')

    const store = registry.open(scope)
    assert.ok(store, 'a v1 store must open instead of failing forever')
    assert.equal(countRecords(store.db).total, 1, 'the record survived the migration')

    const record = getRecord(store.db, 'legacy-one')
    assert.ok(record)
    assert.equal(record.title, '中文教训 legacy')
    assert.equal(record.body, '写入被沙箱拒绝时降级到项目本地。')
    assert.equal(record.timesSeen, 3)
    assert.equal(record.status, 'active')

    assert.equal(metaVersion(file, mod), String(SCHEMA_VERSION), 'the schema is stamped only after a complete migration')

    // The CJK bigram column is what the v1→v2 step exists for: mid-run CJK
    // search must work on the migrated store.
    const hits = rawSearch(store.db, extractTerms('沙箱'), store.fts5)
    assert.deepEqual(hits.map((hit) => hit.id), ['legacy-one'])
})

test('a recovered store is writable: export and a second open both work', async (t) => {
    const { scope, file, registry } = await v1Fixture(t, 'migration-writable')
    const store = registry.open(scope)
    assert.ok(store)

    // Writing exercises the FTS triggers that the broken migration poisoned;
    // an UPDATE against an index that was never rebuilt raises
    // "database disk image is malformed".
    store.db
        .prepare('UPDATE records SET body = ?, confidence = ? WHERE id = ?')
        .run('写入被沙箱拒绝时降级到项目本地。补充：先读后写。', 0.9, 'legacy-one')
    const exported = exportAll(store.db, scope)
    assert.deepEqual(exported.errors, [])
    const lesson = fs.readFileSync(path.join(scope.root, 'lessons', 'legacy-one.md'), 'utf8')
    assert.match(lesson, /title: 中文教训 legacy/)

    registry.closeAll()
    const reopened = registry.open(scope)
    assert.ok(reopened, 'reopening a recovered store must not re-run the broken migration')
    assert.equal(getRecord(reopened.db, 'legacy-one')?.confidence, 0.9)
    assert.equal(metaVersion(file, (await loadSqliteModule())!), String(SCHEMA_VERSION))
})

test('a store that cannot be opened degrades instead of locking the root', async (t) => {
    const { scope, file, registry } = await v1Fixture(t, 'migration-unopenable')
    // A read-only database cannot be migrated (nor repaired); opening it must
    // report "unavailable" without throwing and without burning the root.
    fs.chmodSync(file, 0o444)
    try {
        const store = registry.open(scope)
        assert.equal(store, undefined, 'an unmigratable store is reported, not guessed at')
        assert.equal(registry.listOpen().length, 0)
    } finally {
        fs.chmodSync(file, 0o644)
    }

    // The failure is a degradation, not a death sentence: once the file is
    // writable again the same root opens and still holds its data.
    const recovered = registry.open(scope)
    assert.ok(recovered)
    assert.equal(countRecords(recovered.db).total, 1)
})

test('a corrupt database file is refused without throwing', async (t) => {
    const root = tempDir('migration-corrupt')
    const file = path.join(root, 'memory.db')
    fs.writeFileSync(file, 'this is not a sqlite database\n')
    const registry = new StoreRegistry(resolveConfig({}))
    await registry.initialize(loadSqliteModule)
    if (!registry.available) {
        t.skip('node:sqlite unavailable')
        return
    }
    const scope: MemoryScope = { kind: 'global', root, reason: 'no-project-context' }
    assert.equal(registry.open(scope), undefined)
    assert.equal(fs.readFileSync(file, 'utf8'), 'this is not a sqlite database\n', 'the file is left alone')
})
