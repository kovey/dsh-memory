/**
 * SQLite → text view (DESIGN §5.3).
 *
 * Every mutation is followed by a one-way export so the git-tracked view
 * (`lessons/*.md`, `MEMORY.md`, `metrics.jsonl`) always reflects the store and
 * a clone can rebuild the database with `memory_import --rebuild`.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { log } from '../log.js'
import { ensureDir } from '../paths.js'
import { assertInsideScope } from './guard.js'
import { isoToExpires, renderLesson } from './frontmatter.js'
import { countRecords, listRecords } from './sqlite/records.js'
import type { MemoryRecord, MemoryScope } from './types.js'

export interface ExportResult {
    root: string
    written: number
    removed: number
    errors: string[]
}

/** Write every record of a root back to `lessons/<id>.md`, pruning stale files. */
export function exportLessons(db: DatabaseSync, scope: MemoryScope): ExportResult {
    const result: ExportResult = { root: scope.root, written: 0, removed: 0, errors: [] }
    const dir = path.join(scope.root, 'lessons')
    if (!ensureDir(dir)) {
        result.errors.push(`cannot create ${dir}`)
        return result
    }
    const records = listRecords(db).filter((record) => record.status !== 'archived')
    const expected = new Set(records.map((record) => `${record.id}.md`))

    for (const record of records) {
        const file = path.join(dir, `${record.id}.md`)
        try {
            assertInsideScope(scope, file)
            writeAtomic(file, renderRecord(record))
            result.written += 1
        } catch (error) {
            result.errors.push(`${record.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    try {
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.md') || expected.has(name)) continue
            const file = path.join(dir, name)
            assertInsideScope(scope, file)
            fs.rmSync(file)
            result.removed += 1
        }
    } catch (error) {
        result.errors.push(`prune: ${error instanceof Error ? error.message : String(error)}`)
    }
    return result
}

/** One lesson document, frontmatter compatible with `memory-lesson.sh`. */
export function renderRecord(record: MemoryRecord): string {
    return renderLesson(
        {
            title: record.title,
            confidence: record.confidence,
            expires: isoToExpires(record.expiresAt),
            timesSeen: record.timesSeen,
            updated: record.updatedAt.slice(0, 10),
            tags: record.tags,
            status: record.status,
            origin: record.origin,
            timesRecalled: record.timesRecalled,
            successAfterRecall: record.successAfterRecall,
            failAfterRecall: record.failAfterRecall,
            ...(record.supersededBy !== undefined ? { supersededBy: record.supersededBy } : {}),
            created: record.createdAt.slice(0, 10),
        },
        record.body,
    )
}

/** Regenerate the `MEMORY.md` index for a scope root. */
export function exportIndex(db: DatabaseSync, scope: MemoryScope): string {
    const counts = countRecords(db)
    const records = listRecords(db, { status: ['active', 'pending'] }).slice(0, 60)
    const lines: string[] = []
    lines.push(`# MEMORY — ${scope.kind === 'project' ? `项目记忆 (${scope.repo ?? scope.root})` : 'DSH 全局记忆'}`)
    lines.push('')
    lines.push('> 本文件由 dsh-memory 插件自动生成（文本视图），勿手工编辑结构；内容真源为同目录 `memory.db`。')
    lines.push(`> 生成时间: ${new Date().toISOString()} · 条目: ${counts.total} (active ${counts.active} / pending ${counts.pending} / archived ${counts.archived})`)
    lines.push('')
    lines.push('| 标题 | 置信度 | 复现 | 到期 | 文件 |')
    lines.push('|---|---|---|---|---|')
    for (const record of records) {
        const file = record.status === 'archived' ? `archive/lessons/${record.id}.md` : `lessons/${record.id}.md`
        lines.push(
            `| ${escapeCell(record.title)} | ${record.confidence.toFixed(2)} | ${record.timesSeen} | ${record.expiresAt ?? 'permanent'} | [${record.id}](${file}) |`,
        )
    }
    lines.push('')
    const file = path.join(scope.root, 'MEMORY.md')
    assertInsideScope(scope, file)
    writeAtomic(file, `${lines.join('\n')}\n`)
    return file
}

function escapeCell(value: string): string {
    return value.replace(/\|/g, '\\|')
}

/** Atomic write: temp file in the same directory, then rename. */
export function writeAtomic(file: string, content: string): void {
    const dir = path.dirname(file)
    ensureDir(dir)
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`)
    fs.writeFileSync(tmp, content)
    fs.renameSync(tmp, file)
}

/** Full text-view export for one root. */
export function exportAll(db: DatabaseSync, scope: MemoryScope): ExportResult {
    const result = exportLessons(db, scope)
    try {
        exportIndex(db, scope)
    } catch (error) {
        result.errors.push(`index: ${error instanceof Error ? error.message : String(error)}`)
        log('warn', 'memory: MEMORY.md export failed:', error)
    }
    return result
}
