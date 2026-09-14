/**
 * Record persistence and ranked lookup (DESIGN §5.2, §6).
 *
 * All access is synchronous behind a per-root connection; callers own
 * transaction boundaries via `transact()` when they write more than one row.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { cjkBigrams, cjkClause, hasCjk } from './cjk.js'
import { rowInt, rowReal, rowStr } from './db.js'
import type { Evidence, Layer, MemoryRecord, RecordStatus, ScopeKind } from '../types.js'

export interface RecordFilter {
    layers?: readonly Layer[]
    status?: readonly RecordStatus[]
    scopeKind?: ScopeKind
    repo?: string
    limit?: number
}

export interface RecordCounts {
    total: number
    active: number
    pending: number
    archived: number
    expired: number
    superseded: number
}

/**
 * Slug a title exactly like `~/.dsh/scripts/memory-lesson.sh`, so ids stay
 * stable across the file-based fallback and this plugin. Non-ASCII titles fall
 * back to `zh-<sha1 prefix>`, matching the script's behaviour.
 */
export function slugify(title: string): string {
    const slug = title
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
    if (slug !== '') return slug
    const digest = createHash('sha1').update(title).digest('hex').slice(0, 10)
    return `zh-${digest}`
}

/** Build a persistable record from a draft, filling ids, counters and stamps. */
export function materialize(
    draft: {
        title: string
        body: string
        layer: Layer
        scopeKind: ScopeKind
        repo?: string
        confidence?: number
        expiresAt?: string
        tags?: string[]
        evidence?: Evidence[]
        origin?: string
        source?: MemoryRecord['source']
        status?: RecordStatus
    },
    now: string = new Date().toISOString(),
): MemoryRecord {
    const confidence = clamp01(draft.confidence ?? 0.7)
    return {
        id: slugify(draft.title),
        layer: draft.layer,
        scopeKind: draft.scopeKind,
        ...(draft.repo !== undefined ? { repo: draft.repo } : {}),
        title: draft.title,
        body: draft.body,
        tags: draft.tags ?? [],
        confidence,
        ...(draft.expiresAt !== undefined && draft.expiresAt !== '' ? { expiresAt: draft.expiresAt } : {}),
        timesSeen: 1,
        timesRecalled: 0,
        successAfterRecall: 0,
        failAfterRecall: 0,
        status: draft.status ?? (confidence < 0.6 ? 'pending' : 'active'),
        ...(draft.origin !== undefined ? { origin: draft.origin } : {}),
        createdAt: now,
        updatedAt: now,
        ...(draft.source !== undefined ? { source: draft.source } : {}),
        evidence: draft.evidence ?? [],
    }
}

export function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0
    return Math.min(1, Math.max(0, value))
}

export function rowToRecord(row: Record<string, unknown> | undefined): MemoryRecord | undefined {
    if (row === undefined) return undefined
    const id = typeof row['id'] === 'string' ? row['id'] : undefined
    const title = typeof row['title'] === 'string' ? row['title'] : undefined
    if (id === undefined || title === undefined) return undefined
    const expiresAt = typeof row['expires_at'] === 'string' ? row['expires_at'] : undefined
    const repo = typeof row['repo'] === 'string' ? row['repo'] : undefined
    const supersededBy = typeof row['superseded_by'] === 'string' ? row['superseded_by'] : undefined
    const origin = typeof row['origin'] === 'string' ? row['origin'] : undefined
    return {
        id,
        layer: (row['layer'] as Layer | undefined) ?? 'project',
        scopeKind: (row['scope_kind'] as ScopeKind | undefined) ?? 'global',
        ...(repo !== undefined ? { repo } : {}),
        title,
        body: typeof row['body'] === 'string' ? row['body'] : '',
        tags: parseTags(row['tags']),
        confidence: typeof row['confidence'] === 'number' ? row['confidence'] : 0,
        ...(expiresAt !== undefined && expiresAt !== '' ? { expiresAt } : {}),
        timesSeen: intOf(row['times_seen'], 1),
        timesRecalled: intOf(row['times_recalled'], 0),
        successAfterRecall: intOf(row['success_after_recall'], 0),
        failAfterRecall: intOf(row['fail_after_recall'], 0),
        ...(supersededBy !== undefined ? { supersededBy } : {}),
        status: (row['status'] as RecordStatus | undefined) ?? 'active',
        ...(origin !== undefined ? { origin } : {}),
        createdAt: typeof row['created_at'] === 'string' ? row['created_at'] : new Date().toISOString(),
        updatedAt: typeof row['updated_at'] === 'string' ? row['updated_at'] : new Date().toISOString(),
        evidence: [],
    }
}

function intOf(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
    if (typeof value === 'bigint') return Number(value)
    return fallback
}

function parseTags(value: unknown): string[] {
    if (typeof value !== 'string' || value === '') return []
    try {
        const parsed: unknown = JSON.parse(value)
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
    } catch {
        return []
    }
}

/** Insert or replace a record, keeping its evidence rows in sync. */
export function upsertRecord(db: DatabaseSync, record: MemoryRecord): void {
    db.prepare(
        `INSERT INTO records (
            id, layer, scope_kind, repo, title, body, tags, confidence, expires_at,
            times_seen, times_recalled, success_after_recall, fail_after_recall,
            superseded_by, status, origin, created_at, updated_at, source, cjk
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            layer = excluded.layer,
            scope_kind = excluded.scope_kind,
            repo = excluded.repo,
            title = excluded.title,
            body = excluded.body,
            tags = excluded.tags,
            confidence = excluded.confidence,
            expires_at = excluded.expires_at,
            times_seen = excluded.times_seen,
            times_recalled = excluded.times_recalled,
            success_after_recall = excluded.success_after_recall,
            fail_after_recall = excluded.fail_after_recall,
            superseded_by = excluded.superseded_by,
            status = excluded.status,
            origin = excluded.origin,
            updated_at = excluded.updated_at,
            source = excluded.source,
            cjk = excluded.cjk`,
    ).run(
        record.id,
        record.layer,
        record.scopeKind,
        record.repo ?? null,
        record.title,
        record.body,
        JSON.stringify(record.tags),
        record.confidence,
        record.expiresAt ?? null,
        record.timesSeen,
        record.timesRecalled,
        record.successAfterRecall,
        record.failAfterRecall,
        record.supersededBy ?? null,
        record.status,
        record.origin ?? null,
        record.createdAt,
        record.updatedAt,
        record.source !== undefined ? JSON.stringify(record.source) : null,
        cjkBigrams(`${record.title} ${record.body} ${record.tags.join(' ')}`),
    )
    if (record.evidence.length > 0) {
        const insert = db.prepare('INSERT INTO evidence (record_id, kind, detail, turn, at) VALUES (?, ?, ?, ?, ?)')
        for (const item of record.evidence) {
            insert.run(record.id, item.kind, item.detail ?? null, item.turn ?? null, item.at)
        }
    }
}

export function getRecord(db: DatabaseSync, id: string): MemoryRecord | undefined {
    const record = rowToRecord(db.prepare('SELECT * FROM records WHERE id = ?').get(id))
    if (record === undefined) return undefined
    record.evidence = listEvidence(db, id)
    return record
}

export function listEvidence(db: DatabaseSync, recordId: string): Evidence[] {
    const rows = db
        .prepare('SELECT kind, detail, turn, at FROM evidence WHERE record_id = ? ORDER BY at ASC')
        .all(recordId)
    return rows.map((row) => {
        const kind = rowStr(row, 'kind') ?? 'self-report'
        const detail = rowStr(row, 'detail')
        const turn = rowInt(row, 'turn', Number.NaN)
        return {
            kind: kind as Evidence['kind'],
            ...(detail !== undefined ? { detail } : {}),
            ...(Number.isFinite(turn) ? { turn } : {}),
            at: rowStr(row, 'at') ?? new Date().toISOString(),
        }
    })
}

export function listRecords(db: DatabaseSync, filter: RecordFilter = {}): MemoryRecord[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (filter.layers !== undefined && filter.layers.length > 0) {
        where.push(`layer IN (${filter.layers.map(() => '?').join(', ')})`)
        params.push(...filter.layers)
    }
    if (filter.status !== undefined && filter.status.length > 0) {
        where.push(`status IN (${filter.status.map(() => '?').join(', ')})`)
        params.push(...filter.status)
    }
    if (filter.scopeKind !== undefined) {
        where.push('scope_kind = ?')
        params.push(filter.scopeKind)
    }
    if (filter.repo !== undefined) {
        where.push('repo = ?')
        params.push(filter.repo)
    }
    const limit = filter.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(filter.limit))}` : ''
    const sql = `SELECT * FROM records${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC${limit}`
    return db
        .prepare(sql)
        .all(...params)
        .map((row) => rowToRecord(row))
        .filter((record): record is MemoryRecord => record !== undefined)
}

export function countRecords(db: DatabaseSync, now: Date = new Date()): RecordCounts {
    const today = now.toISOString().slice(0, 10)
    const row = db
        .prepare(
            `SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived,
                SUM(CASE WHEN expires_at IS NOT NULL AND expires_at < ? THEN 1 ELSE 0 END) AS expired,
                SUM(CASE WHEN superseded_by IS NOT NULL THEN 1 ELSE 0 END) AS superseded
             FROM records`,
        )
        .get(today)
    return {
        total: rowInt(row, 'total'),
        active: rowInt(row, 'active'),
        pending: rowInt(row, 'pending'),
        archived: rowInt(row, 'archived'),
        expired: rowInt(row, 'expired'),
        superseded: rowInt(row, 'superseded'),
    }
}

export interface RawHit {
    id: string
    /** Raw FTS5 bm25 value (negative is better) or a LIKE fallback score. */
    raw: number
}

/**
 * Query the FTS index for `terms`, falling back to LIKE when FTS5 is missing.
 * The caller owns scoring and ranking (see `recall/rank.ts`).
 */
export function rawSearch(
    db: DatabaseSync,
    terms: readonly string[],
    fts5: boolean,
    filter: RecordFilter = {},
): RawHit[] {
    if (terms.length === 0) return []
    const filters: string[] = []
    const params: (string | number)[] = []
    if (filter.layers !== undefined && filter.layers.length > 0) {
        filters.push(`r.layer IN (${filter.layers.map(() => '?').join(', ')})`)
        params.push(...filter.layers)
    }
    if (filter.status !== undefined && filter.status.length > 0) {
        filters.push(`r.status IN (${filter.status.map(() => '?').join(', ')})`)
        params.push(...filter.status)
    }
    if (filter.scopeKind !== undefined) {
        filters.push('r.scope_kind = ?')
        params.push(filter.scopeKind)
    }
    const tail = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(500, filter.limit ?? 200))

    if (fts5) {
        const match = buildMatchQuery(terms)
        if (match !== undefined) {
            try {
                const rows = db
                    .prepare(
                        `SELECT r.id AS id, bm25(records_fts, 6.0, 2.0, 3.0, 0.5) AS raw
                         FROM records_fts JOIN records r ON r.rowid = records_fts.rowid
                         WHERE records_fts MATCH ?${tail}
                         ORDER BY raw ASC LIMIT ${limit}`,
                    )
                    .all(match, ...params)
                return rows
                    .map((row) => ({ id: rowStr(row, 'id') ?? '', raw: rowReal(row, 'raw') }))
                    .filter((hit) => hit.id !== '')
            } catch {
                // fall through to LIKE: a malformed query must not lose the call
            }
        }
    }

    const like = terms.map(() => '(r.title LIKE ? OR r.body LIKE ? OR r.tags LIKE ?)').join(' OR ')
    const likeParams = terms.flatMap((term) => [`%${term}%`, `%${term}%`, `%${term}%`])
    const rows = db
        .prepare(
            `SELECT r.id AS id, r.title AS title FROM records r
             WHERE (${like})${tail} ORDER BY r.updated_at DESC LIMIT ${limit}`,
        )
        .all(...likeParams, ...params)
    return rows.map((row) => ({ id: rowStr(row, 'id') ?? '', raw: 0 })).filter((hit) => hit.id !== '')
}

/**
 * Build an FTS5 MATCH expression from free text. Every term becomes a quoted
 * prefix query so CJK text (which `unicode61` does not segment) still matches
 * inside longer tokens.
 */
export function buildMatchQuery(terms: readonly string[]): string | undefined {
    const parts: string[] = []
    for (const term of terms) {
        const cleaned = term.replace(/["*]/g, '').trim()
        if (cleaned === '') continue
        if (hasCjk(cleaned)) {
            const clause = cjkClause(cleaned)
            if (clause !== undefined) parts.push(clause)
            continue
        }
        parts.push(`"${cleaned}"*`)
    }
    if (parts.length === 0) return undefined
    return parts.join(' OR ')
}

/** Split free text into search terms; CJK runs stay whole, ASCII words lowercase. */
export function extractTerms(text: string, max = 12): string[] {
    const matches = text.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu)
    if (matches === null) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const match of matches) {
        if (match.length > 64) continue
        if (seen.has(match)) continue
        seen.add(match)
        out.push(match)
        if (out.length >= max) break
    }
    return out
}
