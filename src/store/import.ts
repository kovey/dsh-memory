/**
 * Text view → SQLite (DESIGN §5.3).
 *
 * The plugin never requires a manual migration: when a memory root's database
 * is empty it is bootstrapped from the lessons already on disk, which is how
 * the pre-existing `~/.dsh/memory/lessons/*.md` corpus enters the store.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { log } from '../log.js'
import { expiresToIso, parseLesson } from './frontmatter.js'
import type { ParsedLesson } from './frontmatter.js'
import { materialize, upsertRecord } from './sqlite/records.js'
import { transact } from './sqlite/db.js'
import type { Layer, MemoryRecord, MemoryScope, RecordStatus } from './types.js'

export interface ImportResult {
    root: string
    scanned: number
    imported: number
    skipped: number
    errors: string[]
}

export interface ImportOptions {
    /** Replace the records table content instead of upserting into it. */
    rebuild?: boolean
}

/** True when the records table holds nothing yet. */
export function isRecordsEmpty(db: DatabaseSync): boolean {
    const row = db.prepare('SELECT COUNT(*) AS n FROM records').get()
    const n = row?.['n']
    if (typeof n === 'number') return n === 0
    if (typeof n === 'bigint') return n === 0n
    return true
}

/** Import on first open only: an existing database is never overwritten. */
export function bootstrapImport(db: DatabaseSync, scope: MemoryScope): ImportResult | undefined {
    if (!isRecordsEmpty(db)) return undefined
    return importLessons(db, scope)
}

/** Import every `<root>/lessons/*.md` document into the scope's database. */
export function importLessons(db: DatabaseSync, scope: MemoryScope, options: ImportOptions = {}): ImportResult {
    const result: ImportResult = { root: scope.root, scanned: 0, imported: 0, skipped: 0, errors: [] }
    const dir = path.join(scope.root, 'lessons')
    let entries: string[]
    try {
        entries = fs.readdirSync(dir).filter((name) => name.endsWith('.md'))
    } catch {
        return result
    }

    const layer: Layer = scope.kind === 'project' ? 'project' : 'global'
    transact(db, () => {
        if (options.rebuild === true) db.prepare('DELETE FROM records').run()
        for (const name of entries) {
            result.scanned += 1
            const file = path.join(dir, name)
            try {
                const parsed = parseLesson(fs.readFileSync(file, 'utf8'))
                if (parsed === undefined) {
                    result.skipped += 1
                    continue
                }
                upsertRecord(db, recordFromLesson(parsed, layer, scope, path.basename(name, '.md')))
                result.imported += 1
            } catch (error) {
                result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
    })
    log('info', `imported ${result.imported}/${result.scanned} lessons from ${dir}`)
    return result
}

/**
 * Convert one parsed lesson document into a record. The file name is
 * authoritative for identity: legacy slugs (including `zh-<sha1>` fallbacks)
 * must survive a round trip unchanged.
 */
export function recordFromLesson(
    parsed: ParsedLesson,
    layer: Layer,
    scope: MemoryScope,
    fileSlug: string,
): MemoryRecord {
    const { frontmatter, body } = parsed
    const expiresAt = expiresToIso(frontmatter.expires)
    const record = materialize(
        {
            title: frontmatter.title,
            body,
            layer,
            scopeKind: scope.kind,
            ...(scope.repo !== undefined ? { repo: scope.repo } : {}),
            confidence: frontmatter.confidence,
            ...(expiresAt !== undefined ? { expiresAt } : {}),
            ...(frontmatter.tags !== undefined ? { tags: frontmatter.tags } : {}),
            origin: 'imported',
            ...(frontmatter.status !== undefined ? { status: frontmatter.status as RecordStatus } : {}),
        },
        `${frontmatter.updated}T00:00:00.000Z`,
    )
    record.id = fileSlug
    record.timesSeen = frontmatter.timesSeen
    record.timesRecalled = frontmatter.timesRecalled ?? 0
    record.successAfterRecall = frontmatter.successAfterRecall ?? 0
    record.failAfterRecall = frontmatter.failAfterRecall ?? 0
    if (frontmatter.supersededBy !== undefined) record.supersededBy = frontmatter.supersededBy
    if (frontmatter.created !== undefined) record.createdAt = `${frontmatter.created}T00:00:00.000Z`
    return record
}
