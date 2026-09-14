/**
 * SQLite schema v1 (DESIGN §5.2).
 *
 * Every memory root (global, project) owns one database with this exact shape.
 * `records_fts` is an external-content FTS5 index kept in sync by triggers;
 * FTS5 availability is probed before the schema is applied, and the schema
 * degrades to a plain-table index when the SQLite build lacks it.
 */

export const SCHEMA_VERSION = 2

export const CORE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS records (
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
  source TEXT,
  -- Space-joined CJK bigrams of title+body+tags. The unicode61 tokenizer does
  -- not segment CJK, so a run like 被沙箱拒绝 is one token and a query for 沙箱
  -- could never match it; the bigram column (schema v2) restores mid-run recall.
  cjk TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS records_layer_idx ON records(layer, status);
CREATE INDEX IF NOT EXISTS records_updated_idx ON records(updated_at DESC);

CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  detail TEXT,
  turn INTEGER,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_record_idx ON evidence(record_id);

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  session_id TEXT,
  turn INTEGER,
  step INTEGER,
  score REAL,
  injected_at TEXT NOT NULL,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS usage_record_idx ON usage(record_id);
CREATE INDEX IF NOT EXISTS usage_session_idx ON usage(session_id);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn INTEGER,
  step INTEGER,
  kind TEXT NOT NULL,
  tool TEXT,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signals_session_idx ON signals(session_id, turn);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  date TEXT,
  project TEXT,
  summary TEXT,
  outcome TEXT,
  duration_min REAL,
  disturb_count INTEGER,
  rework_rounds INTEGER,
  lessons INTEGER,
  tokens INTEGER
);

CREATE TABLE IF NOT EXISTS distill (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  turn INTEGER,
  model TEXT,
  prompt_hash TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_count INTEGER,
  timed_out INTEGER,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS distill_at_idx ON distill(at DESC);

CREATE TABLE IF NOT EXISTS conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  winner_id TEXT,
  loser_id TEXT,
  reason TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consolidate_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  project TEXT,
  archived INTEGER,
  decayed INTEGER,
  conflicts INTEGER,
  proposals INTEGER,
  note TEXT
);
`

export const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
  title, body, tags, cjk,
  content='records',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS records_fts_ai AFTER INSERT ON records BEGIN
  INSERT INTO records_fts(rowid, title, body, tags, cjk)
    VALUES (new.rowid, new.title, new.body, new.tags, new.cjk);
END;

CREATE TRIGGER IF NOT EXISTS records_fts_ad AFTER DELETE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, title, body, tags, cjk)
    VALUES ('delete', old.rowid, old.title, old.body, old.tags, old.cjk);
END;

CREATE TRIGGER IF NOT EXISTS records_fts_au AFTER UPDATE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, title, body, tags, cjk)
    VALUES ('delete', old.rowid, old.title, old.body, old.tags, old.cjk);
  INSERT INTO records_fts(rowid, title, body, tags, cjk)
    VALUES (new.rowid, new.title, new.body, new.tags, new.cjk);
END;
`

/** v1 → v2: add the CJK bigram column and rebuild the FTS table around it. */
export const MIGRATE_V2_SQL = `
DROP TRIGGER IF EXISTS records_fts_ai;
DROP TRIGGER IF EXISTS records_fts_ad;
DROP TRIGGER IF EXISTS records_fts_au;
DROP TABLE IF EXISTS records_fts;
ALTER TABLE records ADD COLUMN cjk TEXT NOT NULL DEFAULT '';
`

/** Rebuild the FTS index from the content table (repair / after bulk import). */
export const FTS_REBUILD_SQL = `INSERT INTO records_fts(records_fts) VALUES('rebuild');`
