/**
 * `metrics.jsonl` — the task-metric ledger shared with the pre-existing
 * file-based workflow (`memory-task-log.sh`) and `baseline.md` (DESIGN §5.3).
 *
 * The SQLite table is authoritative at runtime; the JSONL file stays the
 * git-tracked view so history keeps diffing like it always did.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { ensureDir } from '../paths.js'
import { assertInsideScope } from './guard.js'
import { writeAtomic } from './export.js'
import { transact } from './sqlite/db.js'
import type { MemoryScope } from './types.js'

export interface TaskMetric {
    task_id: string
    date?: string
    project?: string
    summary?: string
    outcome?: string
    duration_min?: number | null
    disturb_count?: number | null
    rework_rounds?: number | null
    lessons?: number | null
    tokens?: number | null
}

export function metricsFile(scope: MemoryScope): string {
    return path.join(scope.root, 'metrics.jsonl')
}

/** Load a JSONL metric ledger into the database (idempotent by task_id). */
export function importMetrics(db: DatabaseSync, scope: MemoryScope): number {
    const file = metricsFile(scope)
    let text: string
    try {
        text = fs.readFileSync(file, 'utf8')
    } catch {
        return 0
    }
    const rows: TaskMetric[] = []
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
            const parsed: unknown = JSON.parse(trimmed)
            if (parsed !== null && typeof parsed === 'object' && typeof (parsed as TaskMetric).task_id === 'string') {
                rows.push(parsed as TaskMetric)
            }
        } catch {
            // a corrupt line must not invalidate the rest of the ledger
        }
    }
    if (rows.length === 0) return 0
    transact(db, () => {
        const stmt = db.prepare(
            `INSERT INTO tasks (task_id, date, project, summary, outcome, duration_min, disturb_count, rework_rounds, lessons, tokens)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(task_id) DO UPDATE SET
                date = excluded.date, project = excluded.project, summary = excluded.summary,
                outcome = excluded.outcome, duration_min = excluded.duration_min,
                disturb_count = excluded.disturb_count, rework_rounds = excluded.rework_rounds,
                lessons = excluded.lessons, tokens = excluded.tokens`,
        )
        for (const row of rows) {
            stmt.run(
                row.task_id,
                row.date ?? null,
                row.project ?? null,
                row.summary ?? null,
                row.outcome ?? null,
                row.duration_min ?? null,
                row.disturb_count ?? null,
                row.rework_rounds ?? null,
                row.lessons ?? null,
                row.tokens ?? null,
            )
        }
    })
    return rows.length
}

/**
 * Append one metric row to both the database and the JSONL view.
 *
 * The view is upserted by `task_id` rather than appended blindly: the same task
 * is reported more than once (a session is resumed, a ledger row is refreshed),
 * and an append-only file grew one line per report for the same task.
 */
export function appendMetric(db: DatabaseSync, scope: MemoryScope, metric: TaskMetric): void {
    transact(db, () => {
        db.prepare(
            `INSERT INTO tasks (task_id, date, project, summary, outcome, duration_min, disturb_count, rework_rounds, lessons, tokens)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(task_id) DO UPDATE SET
                outcome = excluded.outcome, duration_min = excluded.duration_min,
                disturb_count = excluded.disturb_count, rework_rounds = excluded.rework_rounds,
                lessons = excluded.lessons, tokens = excluded.tokens`,
        ).run(
            metric.task_id,
            metric.date ?? null,
            metric.project ?? null,
            metric.summary ?? null,
            metric.outcome ?? null,
            metric.duration_min ?? null,
            metric.disturb_count ?? null,
            metric.rework_rounds ?? null,
            metric.lessons ?? null,
            metric.tokens ?? null,
        )
    })
    exportMetrics(db, scope)
}

/**
 * Rewrite the JSONL view from the database, deduplicated by `task_id`.
 *
 * One line per task: a database row replaces the line it supersedes *in place*
 * (so the file keeps its history order and produces a one-line diff), rows the
 * file does not have are appended, and a line whose `task_id` the database does
 * not know — written by hand, or by another machine's ledger that has not been
 * imported yet — is kept verbatim. Losing those would turn an export into a
 * silent delete of somebody else's record.
 */
export function exportMetrics(db: DatabaseSync, scope: MemoryScope): number {
    const file = metricsFile(scope)
    assertInsideScope(scope, file)
    ensureDir(path.dirname(file))

    const entries: { taskId?: string; line: string }[] = []
    const at = new Map<string, number>()
    for (const line of readLines(file)) {
        const taskId = taskIdOf(line)
        const existing = taskId === undefined ? undefined : at.get(taskId)
        if (existing !== undefined) {
            // duplicate of a task already in the file: last write wins
            entries[existing] = { taskId, line }
            continue
        }
        if (taskId !== undefined) at.set(taskId, entries.length)
        entries.push(taskId === undefined ? { line } : { taskId, line })
    }

    let written = 0
    for (const row of db.prepare('SELECT * FROM tasks ORDER BY date ASC, task_id ASC').all()) {
        const metric = metricOf(row)
        const taskId = metric['task_id']
        if (typeof taskId !== 'string') continue
        const line = JSON.stringify(metric)
        written += 1
        const index = at.get(taskId)
        if (index === undefined) {
            at.set(taskId, entries.length)
            entries.push({ taskId, line })
        } else {
            entries[index] = { taskId, line }
        }
    }

    // An empty ledger is not worth a new file in the memory repository; an
    // existing one is still truncated so a removed task disappears from the view.
    if (entries.length === 0 && !fs.existsSync(file)) return written
    writeAtomic(file, entries.length > 0 ? `${entries.map((entry) => entry.line).join('\n')}\n` : '')
    return written
}

function readLines(file: string): string[] {
    let text: string
    try {
        text = fs.readFileSync(file, 'utf8')
    } catch {
        return []
    }
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
}

/** The `task_id` of a ledger line, or undefined when it is not one of ours. */
function taskIdOf(line: string): string | undefined {
    try {
        const parsed: unknown = JSON.parse(line)
        if (parsed === null || typeof parsed !== 'object') return undefined
        const taskId = (parsed as TaskMetric).task_id
        return typeof taskId === 'string' && taskId !== '' ? taskId : undefined
    } catch {
        return undefined
    }
}

/** Serialize a database row with a stable key order and no empty fields. */
function metricOf(row: Record<string, unknown>): Record<string, unknown> {
    const metric: Record<string, unknown> = {}
    for (const key of [
        'task_id',
        'date',
        'project',
        'summary',
        'outcome',
        'duration_min',
        'disturb_count',
        'rework_rounds',
        'lessons',
        'tokens',
    ]) {
        const value = row[key]
        if (value === null || value === undefined || value === '') continue
        metric[key] = value
    }
    return metric
}

export interface MetricSummary {
    tasks: number
    success: number
    partial: number
    failed: number
    avgDurationMin: number | null
    avgDisturb: number | null
    avgRework: number | null
    lessons: number
}

/** Aggregate the ledger for `memory_stats` (DESIGN §11 M5). */
export function summarizeMetrics(db: DatabaseSync): MetricSummary {
    const row = db
        .prepare(
            `SELECT COUNT(*) AS tasks,
                    SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success,
                    SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) AS partial,
                    SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
                    AVG(duration_min) AS avg_duration,
                    AVG(disturb_count) AS avg_disturb,
                    AVG(rework_rounds) AS avg_rework,
                    SUM(lessons) AS lessons
             FROM tasks`,
        )
        .get()
    const num = (key: string): number | null => {
        const value = row?.[key]
        return typeof value === 'number' && Number.isFinite(value) ? value : null
    }
    const int = (key: string): number => num(key) ?? 0
    return {
        tasks: int('tasks'),
        success: int('success'),
        partial: int('partial'),
        failed: int('failed'),
        avgDurationMin: num('avg_duration'),
        avgDisturb: num('avg_disturb'),
        avgRework: num('avg_rework'),
        lessons: int('lessons'),
    }
}
