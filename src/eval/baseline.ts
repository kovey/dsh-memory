/**
 * Evaluation gate (DESIGN §8, §11 M5).
 *
 * What the plugin can and cannot do here matters:
 *   - It *can* track the four baseline metrics, freeze a snapshot, compare a
 *     later window against it, and flag a regression automatically.
 *   - It *cannot* replay the baseline tasks: they are real-world tasks from
 *     other repositories. So the gate reports the task list for a human replay
 *     and judges the metrics that the task log actually carries.
 *
 * `baseline.md` stays a human-owned document and is never rewritten — snapshots
 * live in the database.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { rowInt, rowNum, rowStr } from '../store/sqlite/db.js'
import { summarizeMetrics } from '../store/metrics.js'
import type { MetricSummary } from '../store/metrics.js'
import type { MemoryScope } from '../store/types.js'

/** One entry of the "基线任务集" section of baseline.md. */
export interface BaselineTask {
    index: number
    name: string
    project?: string
    requirement?: string
    acceptance?: string[]
}

export interface ParsedBaseline {
    title: string
    metrics: { field: string; meaning: string; collection: string }[]
    tasks: BaselineTask[]
    /** Section names found, so a caller can tell a wrong file from an empty one. */
    sections: string[]
}

/** Parse `baseline.md` (task list + metric table). Tolerant by design. */
export function parseBaseline(markdown: string): ParsedBaseline {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n')
    const out: ParsedBaseline = { title: '', metrics: [], tasks: [], sections: [] }
    let section = ''
    let current: BaselineTask | undefined
    for (const raw of lines) {
        const line = raw.trimEnd()
        const heading = /^(#{1,3})\s+(.*)$/.exec(line)
        if (heading !== null) {
            const level = (heading[1] ?? '#').length
            const text = (heading[2] ?? '').trim()
            if (level === 1 && out.title === '') out.title = text
            else if (level === 2) {
                section = text
                out.sections.push(text)
                current = undefined
            } else if (/^\d+\./.test(text)) {
                const match = /^(\d+)\.\s+(.*)$/.exec(text)
                const name = match?.[2]?.trim() ?? text
                const project = /\(([^)]+)\)\s*$/.exec(name)?.[1]
                current = {
                    index: Number(match?.[1] ?? out.tasks.length + 1),
                    name: project !== undefined ? name.replace(/\s*\([^)]+\)\s*$/, '') : name,
                    ...(project !== undefined ? { project } : {}),
                }
                out.tasks.push(current)
            }
            continue
        }
        if (section.startsWith('指标定义') && line.startsWith('|')) {
            const cells = line
                .split('|')
                .slice(1, -1)
                .map((cell) => cell.trim())
            // Field names are written as `code` in the real document.
            const field = (cells[0] ?? '').replace(/[`*]/g, '').trim()
            if (cells.length >= 3 && field !== '' && !/^-+$/.test(field) && field !== '字段') {
                out.metrics.push({ field, meaning: cells[1] ?? '', collection: cells[2] ?? '' })
            }
            continue
        }
        if (current !== undefined) {
            const requirement = /^[-*]\s*需求[:：]\s*(.*)$/.exec(line)
            if (requirement !== null) {
                current.requirement = requirement[1]?.trim()
                continue
            }
            const acceptance = /^[-*]\s*验收[:：]\s*(.*)$/.exec(line)
            if (acceptance !== null) {
                current.acceptance = [...(current.acceptance ?? []), acceptance[1]?.trim() ?? '']
                continue
            }
            if (line.startsWith('-') && (current.acceptance?.length ?? 0) > 0 && line.startsWith('  ')) {
                current.acceptance?.push(line.trim().replace(/^[-*]\s*/, ''))
            }
        }
    }
    out.tasks = out.tasks.filter((task) => task.name !== '')
    return out
}

/** Read and parse the baseline document of a scope, when it exists. */
export function readBaseline(scope: MemoryScope): ParsedBaseline | undefined {
    const file = path.join(scope.root, 'baseline.md')
    try {
        return parseBaseline(fs.readFileSync(file, 'utf8'))
    } catch {
        return undefined
    }
}

export interface MetricSnapshot {
    at: string
    tasks: number
    successRate: number | null
    avgDuration: number | null
    avgDisturb: number | null
    avgRework: number | null
    note?: string
}

/** Compute the four gate metrics from the task ledger. */
export function snapshotMetrics(db: DatabaseSync, at = new Date(), note?: string): MetricSnapshot {
    const summary: MetricSummary = summarizeMetrics(db)
    const decided = summary.success + summary.partial + summary.failed
    return {
        at: at.toISOString(),
        tasks: summary.tasks,
        successRate: decided > 0 ? round(summary.success / decided, 4) : null,
        avgDuration: summary.avgDurationMin === null ? null : round(summary.avgDurationMin, 2),
        avgDisturb: summary.avgDisturb === null ? null : round(summary.avgDisturb, 2),
        avgRework: summary.avgRework === null ? null : round(summary.avgRework, 2),
        ...(note !== undefined ? { note } : {}),
    }
}

/** Freeze the current metrics as the baseline to compare against. */
export function freezeBaseline(db: DatabaseSync, scopeLabel: string, note?: string, at = new Date()): MetricSnapshot {
    const snapshot = snapshotMetrics(db, at, note)
    db.prepare(
        'INSERT INTO baseline_snapshots (at, scope, tasks, success_rate, avg_duration, avg_disturb, avg_rework, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
        snapshot.at,
        scopeLabel,
        snapshot.tasks,
        snapshot.successRate,
        snapshot.avgDuration,
        snapshot.avgDisturb,
        snapshot.avgRework,
        note ?? null,
    )
    return snapshot
}

/** Most recent snapshot, or undefined when the gate has no reference yet. */
export function latestBaseline(db: DatabaseSync): MetricSnapshot | undefined {
    const row = db.prepare('SELECT * FROM baseline_snapshots ORDER BY at DESC, id DESC LIMIT 1').get()
    if (row === undefined) return undefined
    const note = rowStr(row, 'note')
    return {
        at: rowStr(row, 'at') ?? new Date().toISOString(),
        tasks: rowInt(row, 'tasks'),
        successRate: rowNum(row, 'success_rate') ?? null,
        avgDuration: rowNum(row, 'avg_duration') ?? null,
        avgDisturb: rowNum(row, 'avg_disturb') ?? null,
        avgRework: rowNum(row, 'avg_rework') ?? null,
        ...(note !== undefined ? { note } : {}),
    }
}

export type MetricVerdict = 'better' | 'same' | 'worse' | 'unknown'
export type GateVerdict = 'pass' | 'regression' | 'no-baseline'

export interface MetricComparison {
    metric: 'successRate' | 'avgDuration' | 'avgDisturb' | 'avgRework'
    label: string
    /** `up` means a higher value is better. */
    direction: 'up' | 'down'
    baseline: number | null
    current: number | null
    delta: number | null
    verdict: MetricVerdict
}

export interface GateReport {
    verdict: GateVerdict
    baseline?: MetricSnapshot
    current: MetricSnapshot
    comparisons: MetricComparison[]
    regressed: string[]
}

/** Tolerance so noise in a small ledger does not read as a regression. */
export const TOLERANCE = { successRate: 0.05, duration: 0.15, disturb: 0.5, rework: 0.5 }

/**
 * Compare current metrics against the frozen baseline. The gate is asymmetric on
 * purpose: regressions fail it, improvements pass it, and missing data is
 * "unknown" rather than a silent pass.
 */
export function evaluateGate(current: MetricSnapshot, baseline: MetricSnapshot | undefined): GateReport {
    if (baseline === undefined || baseline.tasks === 0) {
        return { verdict: 'no-baseline', current, comparisons: [], regressed: [] }
    }
    const comparisons: MetricComparison[] = [
        compare('successRate', '成功率', 'up', baseline.successRate, current.successRate, TOLERANCE.successRate),
        compare('avgDuration', '平均耗时(分钟)', 'down', baseline.avgDuration, current.avgDuration, TOLERANCE.duration, true),
        compare('avgDisturb', '平均打扰次数', 'down', baseline.avgDisturb, current.avgDisturb, TOLERANCE.disturb),
        compare('avgRework', '平均返工轮数', 'down', baseline.avgRework, current.avgRework, TOLERANCE.rework),
    ]
    const regressed = comparisons.filter((item) => item.verdict === 'worse').map((item) => item.label)
    return {
        verdict: regressed.length > 0 ? 'regression' : 'pass',
        baseline,
        current,
        comparisons,
        regressed,
    }
}

function compare(
    metric: MetricComparison['metric'],
    label: string,
    direction: 'up' | 'down',
    baseline: number | null,
    current: number | null,
    tolerance: number,
    relative = false,
): MetricComparison {
    if (baseline === null || current === null) {
        return { metric, label, direction, baseline, current, delta: null, verdict: 'unknown' }
    }
    const delta = round(current - baseline, 4)
    if (delta === 0) return { metric, label, direction, baseline, current, delta, verdict: 'same' }
    const improves = direction === 'up' ? delta > 0 : delta < 0
    const threshold = relative ? Math.abs(baseline) * tolerance : tolerance
    if (Math.abs(delta) <= threshold) return { metric, label, direction, baseline, current, delta, verdict: 'same' }
    return { metric, label, direction, baseline, current, delta, verdict: improves ? 'better' : 'worse' }
}

export interface HealthDigest {
    injections: number
    attributed: number
    successAfterRecall: number
    failureAfterRecall: number
    /** Share of attributed recalls that ended in a successful turn. */
    recallHitRate: number | null
    pending: number
    active: number
    archived: number
    expired: number
    conflicts: number
    proposals: number
    episodes: number
    distillRuns: number
    distillTokens: number
    distillTimeouts: number
}

/** Memory-quality indicators (DESIGN §11 M5). */
export function healthDigest(db: DatabaseSync, sinceDays = 30): HealthDigest {
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString()
    const usage = db
        .prepare(
            `SELECT COUNT(*) AS injections,
                    SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) AS attributed,
                    SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS ok,
                    SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS bad
             FROM usage WHERE injected_at >= ?`,
        )
        .get(since)
    const records = db
        .prepare(
            `SELECT SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                    SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived,
                    SUM(CASE WHEN expires_at IS NOT NULL AND expires_at < ? THEN 1 ELSE 0 END) AS expired
             FROM records`,
        )
        .get(new Date().toISOString().slice(0, 10))
    const distill = db
        .prepare(
            `SELECT COUNT(*) AS runs, COALESCE(SUM(timed_out), 0) AS timeouts,
                    COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)), 0) AS tokens
             FROM distill WHERE at >= ?`,
        )
        .get(since)
    const conflicts = db.prepare('SELECT COUNT(*) AS n FROM conflicts').get()
    const proposals = db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'open'").get()
    const episodes = db.prepare('SELECT COUNT(*) AS n FROM signals WHERE at >= ?').get(since)

    const attributed = rowInt(usage, 'attributed')
    const success = rowInt(usage, 'ok')
    return {
        injections: rowInt(usage, 'injections'),
        attributed,
        successAfterRecall: success,
        failureAfterRecall: rowInt(usage, 'bad'),
        recallHitRate: attributed > 0 ? round(success / attributed, 4) : null,
        active: rowInt(records, 'active'),
        pending: rowInt(records, 'pending'),
        archived: rowInt(records, 'archived'),
        expired: rowInt(records, 'expired'),
        conflicts: rowInt(conflicts, 'n'),
        proposals: rowInt(proposals, 'n'),
        episodes: rowInt(episodes, 'n'),
        distillRuns: rowInt(distill, 'runs'),
        distillTokens: rowInt(distill, 'tokens'),
        distillTimeouts: rowInt(distill, 'timeouts'),
    }
}

/** Which metric the trend covers. */
export interface TrendWindow {
    days: number
    from: string
    to: string
    summary: MetricSummary
}

export function windowSummary(db: DatabaseSync, days: number, offsetDays = 0, now = new Date()): TrendWindow {
    const to = new Date(now.getTime() - offsetDays * 86_400_000)
    const from = new Date(to.getTime() - days * 86_400_000)
    const row = db
        .prepare(
            `SELECT COUNT(*) AS tasks,
                    SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success,
                    SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) AS partial,
                    SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
                    AVG(duration_min) AS avg_duration, AVG(disturb_count) AS avg_disturb,
                    AVG(rework_rounds) AS avg_rework, SUM(lessons) AS lessons
             FROM tasks WHERE date >= ? AND date < ?`,
        )
        .get(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10))
    const num = (key: string): number => rowNum(row, key) ?? 0
    return {
        days,
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        summary: {
            tasks: num('tasks'),
            success: num('success'),
            partial: num('partial'),
            failed: num('failed'),
            avgDurationMin: rowNum(row, 'avg_duration') ?? null,
            avgDisturb: rowNum(row, 'avg_disturb') ?? null,
            avgRework: rowNum(row, 'avg_rework') ?? null,
            lessons: num('lessons'),
        },
    }
}

/** Render the gate + health report for `memory_stats`. */
export function renderEvaluation(
    gate: GateReport,
    health: HealthDigest,
    trend: { current: TrendWindow; previous: TrendWindow },
    baselineTasks: readonly BaselineTask[],
): string[] {
    const lines: string[] = []
    lines.push('evaluation gate:')
    if (gate.verdict === 'no-baseline') {
        lines.push(
            `  no baseline snapshot yet — run memory_stats({ setBaseline: true }) after a good period to freeze one (tasks so far: ${gate.current.tasks})`,
        )
    } else {
        lines.push(
            `  verdict: ${gate.verdict === 'pass' ? 'PASS' : 'REGRESSION'} (baseline ${gate.baseline?.at.slice(0, 19) ?? '?'} · ${gate.baseline?.tasks ?? 0} tasks → now ${gate.current.tasks} tasks)`,
        )
        for (const item of gate.comparisons) {
            const base = item.baseline === null ? 'n/a' : String(item.baseline)
            const now = item.current === null ? 'n/a' : String(item.current)
            lines.push(`    ${item.verdict === 'worse' ? '✗' : item.verdict === 'better' ? '✓' : '·'} ${item.label}: ${base} → ${now} (${item.verdict})`)
        }
        if (gate.regressed.length > 0) lines.push(`  regressed: ${gate.regressed.join(', ')} — replay the baseline tasks before trusting the change`)
    }
    lines.push(
        `  trend: last ${trend.current.days}d ${trend.current.summary.tasks} task(s) (success ${trend.current.summary.success}) vs previous ${trend.previous.summary.tasks} task(s) (success ${trend.previous.summary.success})`,
    )
    lines.push('memory health:')
    lines.push(
        `  records: active ${health.active} / pending ${health.pending} / archived ${health.archived} (expired ${health.expired})`,
    )
    lines.push(
        `  recall: ${health.injections} injection(s), ${health.attributed} attributed — hit rate ${health.recallHitRate === null ? 'n/a' : `${(health.recallHitRate * 100).toFixed(0)}%`} (success ${health.successAfterRecall} / failure ${health.failureAfterRecall})`,
    )
    lines.push(
        `  learning: ${health.episodes} episode signal(s), ${health.distillRuns} distillation(s) / ${health.distillTokens} tok${health.distillTimeouts > 0 ? ` (${health.distillTimeouts} timed out)` : ''}`,
    )
    lines.push(`  open conflicts ${health.conflicts} · open proposals ${health.proposals}`)
    if (baselineTasks.length > 0) {
        lines.push(`  baseline task set (${baselineTasks.length}, for manual replay):`)
        for (const task of baselineTasks.slice(0, 10)) {
            lines.push(`    ${task.index}. ${task.name}${task.project !== undefined ? ` [${task.project}]` : ''}`)
        }
    }
    return lines
}

function round(value: number, digits: number): number {
    const factor = 10 ** digits
    return Math.round(value * factor) / factor
}
