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
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import { rowInt, rowNum, rowStr, transact } from '../store/sqlite/db.js';
import { summarizeMetrics } from '../store/metrics.js';
/** Parse `baseline.md` (task list + metric table). Tolerant by design. */
export function parseBaseline(markdown) {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const out = { title: '', metrics: [], tasks: [], sections: [] };
    let section = '';
    let current;
    for (const raw of lines) {
        const line = raw.trimEnd();
        const heading = /^(#{1,3})\s+(.*)$/.exec(line);
        if (heading !== null) {
            const level = (heading[1] ?? '#').length;
            const text = (heading[2] ?? '').trim();
            if (level === 1 && out.title === '')
                out.title = text;
            else if (level === 2) {
                section = text;
                out.sections.push(text);
                current = undefined;
            }
            else if (/^\d+\./.test(text)) {
                const match = /^(\d+)\.\s+(.*)$/.exec(text);
                const name = match?.[2]?.trim() ?? text;
                const project = /\(([^)]+)\)\s*$/.exec(name)?.[1];
                current = {
                    index: Number(match?.[1] ?? out.tasks.length + 1),
                    name: project !== undefined ? name.replace(/\s*\([^)]+\)\s*$/, '') : name,
                    ...(project !== undefined ? { project } : {}),
                };
                out.tasks.push(current);
            }
            continue;
        }
        if (section.startsWith('指标定义') && line.startsWith('|')) {
            const cells = line
                .split('|')
                .slice(1, -1)
                .map((cell) => cell.trim());
            // Field names are written as `code` in the real document.
            const field = (cells[0] ?? '').replace(/[`*]/g, '').trim();
            if (cells.length >= 3 && field !== '' && !/^-+$/.test(field) && field !== '字段') {
                out.metrics.push({ field, meaning: cells[1] ?? '', collection: cells[2] ?? '' });
            }
            continue;
        }
        if (current !== undefined) {
            const requirement = /^[-*]\s*需求[:：]\s*(.*)$/.exec(line);
            if (requirement !== null) {
                current.requirement = requirement[1]?.trim();
                continue;
            }
            const acceptance = /^[-*]\s*验收[:：]\s*(.*)$/.exec(line);
            if (acceptance !== null) {
                current.acceptance = [...(current.acceptance ?? []), acceptance[1]?.trim() ?? ''];
                continue;
            }
            if (line.startsWith('-') && (current.acceptance?.length ?? 0) > 0 && line.startsWith('  ')) {
                current.acceptance?.push(line.trim().replace(/^[-*]\s*/, ''));
            }
        }
    }
    out.tasks = out.tasks.filter((task) => task.name !== '');
    return out;
}
/** Read and parse the baseline document of a scope, when it exists. */
export function readBaseline(scope) {
    const file = path.join(scope.root, 'baseline.md');
    try {
        return parseBaseline(fs.readFileSync(file, 'utf8'));
    }
    catch {
        return undefined;
    }
}
/** Compute the four gate metrics from the task ledger. */
export function snapshotMetrics(db, at = new Date(), note) {
    const summary = summarizeMetrics(db);
    const decided = summary.success + summary.partial + summary.failed;
    return {
        at: at.toISOString(),
        tasks: summary.tasks,
        successRate: decided > 0 ? round(summary.success / decided, 4) : null,
        avgDuration: summary.avgDurationMin === null ? null : round(summary.avgDurationMin, 2),
        avgDisturb: summary.avgDisturb === null ? null : round(summary.avgDisturb, 2),
        avgRework: summary.avgRework === null ? null : round(summary.avgRework, 2),
        ...(note !== undefined ? { note } : {}),
    };
}
/** Freeze the current metrics as the baseline to compare against. */
export function freezeBaseline(db, scopeLabel, note, at = new Date()) {
    const snapshot = snapshotMetrics(db, at, note);
    insertSnapshot(db, scopeLabel, snapshot, note);
    return snapshot;
}
/**
 * Write one snapshot row. Split out of `freezeBaseline` so the repair path can
 * insert the *exact* snapshot it already put through the quality gate: a write
 * that re-measured the ledger could land a different (unchecked) window in the
 * reference position.
 */
function insertSnapshot(db, scopeLabel, snapshot, note) {
    db.prepare('INSERT INTO baseline_snapshots (at, scope, tasks, success_rate, avg_duration, avg_disturb, avg_rework, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(snapshot.at, scopeLabel, snapshot.tasks, snapshot.successRate, snapshot.avgDuration, snapshot.avgDisturb, snapshot.avgRework, note ?? null);
}
/** Most recent snapshot, or undefined when the gate has no reference yet. */
export function latestBaseline(db) {
    const row = db.prepare('SELECT * FROM baseline_snapshots ORDER BY at DESC, id DESC LIMIT 1').get();
    if (row === undefined)
        return undefined;
    const note = rowStr(row, 'note');
    return {
        at: rowStr(row, 'at') ?? new Date().toISOString(),
        tasks: rowInt(row, 'tasks'),
        successRate: rowNum(row, 'success_rate') ?? null,
        avgDuration: rowNum(row, 'avg_duration') ?? null,
        avgDisturb: rowNum(row, 'avg_disturb') ?? null,
        avgRework: rowNum(row, 'avg_rework') ?? null,
        ...(note !== undefined ? { note } : {}),
    };
}
/**
 * Task-ledger rows that actually carry one of the four gate metrics.
 *
 * A row with only `task_id`/`date`/`summary` and no outcome, duration, disturb
 * or rework value cannot be compared by the gate, so it must not count towards
 * the "enough data to freeze" threshold: freezing on such rows would only
 * produce a snapshot whose four metrics are `null`, i.e. a permanently UNKNOWN
 * gate wearing the appearance of a calibrated one.
 */
export function metricTaskCount(db) {
    const row = db
        .prepare(`SELECT COUNT(*) AS n FROM tasks
             WHERE outcome IN ('success', 'partial', 'failed')
                OR duration_min IS NOT NULL OR disturb_count IS NOT NULL OR rework_rounds IS NOT NULL`)
        .get();
    return rowInt(row, 'n');
}
/**
 * Why the current window may not be frozen automatically, or `undefined` when it
 * is healthy enough.
 *
 * The frozen snapshot is what every later period is judged against, so freezing
 * a bad period inverts the gate: a 12% success rate with 6.1 rework rounds per
 * task becomes "normal", and every later — genuinely better — period reads as a
 * regression or a pass. DESIGN §11 makes a freeze a human calibration step after
 * a *good* period; an automatic freeze therefore has to prove the period is good.
 *
 * A metric that carries no data does not pass either: "no success rate recorded"
 * is not evidence of a healthy window, it is the absence of evidence.
 */
export function qualityGateFailure(snapshot, config) {
    const failures = gateFailures(snapshot, config, 'current');
    // Every failing side is named: a log that only reports the first one sends the
    // reader back for a second run to learn the other half.
    return failures.length > 0 ? failures.join(' and ') : undefined;
}
/**
 * The same quality gate, applied to whatever snapshot is passed in.
 *
 * `subject` labels the values in the message (`current` for the window about to
 * be frozen, `baseline` for a snapshot already in the table), so the two callers
 * can share one judgement without sharing one sentence.
 */
function gateFailures(snapshot, config, subject) {
    const minSuccess = config.eval.autoFreezeMinSuccessRate;
    const maxRework = config.eval.autoFreezeMaxRework;
    const failures = [];
    if (snapshot.successRate === null) {
        failures.push(`${subject} success n/a (eval.autoFreezeMinSuccessRate ${minSuccess})`);
    }
    else if (snapshot.successRate < minSuccess) {
        failures.push(`${subject} success ${snapshot.successRate} < eval.autoFreezeMinSuccessRate ${minSuccess}`);
    }
    if (snapshot.avgRework === null) {
        failures.push(`${subject} rework n/a (eval.autoFreezeMaxRework ${maxRework})`);
    }
    else if (snapshot.avgRework > maxRework) {
        failures.push(`${subject} rework ${snapshot.avgRework} > eval.autoFreezeMaxRework ${maxRework}`);
    }
    return failures;
}
/**
 * Freeze the first baseline automatically, when the user asked for it
 * (`eval.autoFreezeBaseline`), the ledger has enough comparable rows, and the
 * window passes the quality gate.
 *
 * This is the escape hatch from the gate's permanent-UNKNOWN state: with no
 * snapshot the gate can only ever answer UNKNOWN, which is exactly the state the
 * live store was in. Three guards matter:
 *
 *   - an existing snapshot is never replaced (idempotent) — refreezing is how a
 *     regression signal gets erased, and `setBaseline` already requires a human
 *     reason for that reason;
 *   - no data means no freeze, so the gate never pretends to have a reference;
 *   - a window that fails the quality gate is *not* written: the automatic path
 *     stays quiet and only hints, leaving the freeze to the human step it was
 *     always meant to be.
 *
 * Returns the frozen snapshot, or undefined when nothing was frozen.
 */
export function maybeFreezeBaseline(db, scope, config, now = new Date()) {
    if (config.eval.autoFreezeBaseline !== true)
        return undefined;
    if (latestBaseline(db) !== undefined)
        return undefined;
    const metricTasks = metricTaskCount(db);
    const threshold = Math.max(1, Math.floor(config.eval.proposeFreezeAfterTasks));
    if (metricTasks < threshold)
        return undefined;
    const label = baselineScopeLabel(scope);
    const windowDays = config.eval.windowDays;
    // The same snapshot `freezeBaseline` is about to write, taken *before* the
    // gate: no write may happen between the two reads.
    const current = snapshotMetrics(db, now);
    const failure = qualityGateFailure(current, config);
    if (failure !== undefined) {
        log('info', `memory: baseline auto-freeze skipped for ${label} — quality gate not met (${failure}); ` +
            `${metricTasks} task metric(s) ≥ threshold ${threshold}, but freezing a bad period would make the gate a rubber stamp. ` +
            `A human freeze is still possible: memory_stats({ setBaseline: true, baselineReason: "<who asked and what was verified>" })`);
        return undefined;
    }
    const snapshot = freezeBaseline(db, label, `auto-freeze (eval.autoFreezeBaseline): ${metricTasks} task metric(s), gate window ${windowDays}d`, now);
    log('info', `memory: baseline auto-frozen for ${label} — ${metricTasks} task metric(s) with outcome/cost data in the task ledger (threshold ${threshold}, gate window ${windowDays}d, success ${snapshot.successRate} / rework ${snapshot.avgRework})`);
    return snapshot;
}
/** Scope label written into a snapshot row (same shape as the human freeze path). */
function baselineScopeLabel(scope) {
    return scope.kind === 'project' ? `project:${scope.repo ?? scope.root}` : 'global';
}
function showMetric(value) {
    return value === null ? 'n/a' : String(value);
}
/**
 * How old a snapshot may get before the report calls it stale, as a multiple of
 * `eval.windowDays`. Three windows is the point where the reference describes a
 * system that no longer exists rather than a period that was measured.
 */
export const STALE_BASELINE_WINDOW_MULTIPLE = 3;
/**
 * Judge the snapshot the gate is comparing against.
 *
 * This is the gap the quality gate left open: it only ever looked at the window
 * *about to be frozen*. A snapshot that was already in the table — frozen before
 * the gate existed, or by hand — was never re-examined, so a period with a 12%
 * success rate could sit in the reference position forever and turn every later
 * comparison into a rubber stamp. Detection is read-only; replacing it is
 * `repairUnhealthyBaseline` and needs `eval.autoRepairUnhealthyBaseline`.
 *
 * A metric that carries no data does not pass here either: `null` on the
 * reference side means the gate cannot compare that metric at all.
 */
export function assessBaselineHealth(baseline, config, now = new Date()) {
    const failures = gateFailures(baseline, config, 'baseline');
    const staleAfterDays = Math.max(1, Math.floor(config.eval.windowDays)) * STALE_BASELINE_WINDOW_MULTIPLE;
    const parsed = Date.parse(baseline.at);
    const ageDays = Number.isNaN(parsed) ? null : Math.round((now.getTime() - parsed) / 86_400_000);
    return {
        healthy: failures.length === 0,
        failures,
        ageDays,
        stale: ageDays !== null && ageDays > staleAfterDays,
        staleAfterDays,
        windowDays: config.eval.windowDays,
        autoRepair: config.eval.autoRepairUnhealthyBaseline === true,
    };
}
/**
 * Replace a snapshot that fails the quality gate, when the user asked for it
 * (`eval.autoRepairUnhealthyBaseline`) *and* the current window is healthy.
 *
 * `maybeFreezeBaseline` is idempotent by design — an existing snapshot is never
 * replaced, because refreezing is how a regression signal gets erased. That left
 * the opposite hole: a snapshot frozen from a bad period (the live store had
 * `success_rate 0.122 / avg_rework 6.12`) had no detection and no repair path, so
 * the gate kept comparing against it and a genuine regression read as PASS.
 *
 * Three conditions, all required, in this order:
 *
 *   1. the snapshot in the table fails the same quality gate;
 *   2. the *current* window passes it — a repair must never freeze a bad window
 *      in place of a bad snapshot (that would just launder the same mistake);
 *   3. the ledger has at least `eval.proposeFreezeAfterTasks` task metrics, so the
 *      replacement is not a snapshot of noise either.
 *
 * Atomicity and concurrency: the retiring `DELETE` and the new `INSERT` run in one
 * `transact` block. `node:sqlite`'s `DatabaseSync` is synchronous, so no other
 * statement of this process can interleave; other processes are serialized by
 * SQLite's write lock (WAL + `busy_timeout`), and a failing `BEGIN`/`COMMIT`
 * leaves the old row exactly as it was. Every row is deleted rather than only the
 * newest one: `latestBaseline` reads the newest row, so leaving an older row
 * behind would silently promote an even staler snapshot into the reference
 * position. The retired values stay auditable — they are quoted in the new row's
 * `note` and in the log line.
 *
 * A write error is caught and reported as a skip: a stats read must not fail
 * because the audit trail could not be updated.
 */
export function repairUnhealthyBaseline(db, scope, config, now = new Date()) {
    const previous = latestBaseline(db);
    if (previous === undefined)
        return { replaced: false, skipped: 'no baseline snapshot to repair' };
    const failures = gateFailures(previous, config, 'baseline');
    if (failures.length === 0) {
        return {
            replaced: false,
            previous,
            skipped: `the baseline is healthy (success ${showMetric(previous.successRate)} / rework ${showMetric(previous.avgRework)})`,
        };
    }
    if (config.eval.autoRepairUnhealthyBaseline !== true) {
        return {
            replaced: false,
            previous,
            skipped: 'eval.autoRepairUnhealthyBaseline is off — replacing the gate reference stays a human decision ' +
                '(memory_stats({ setBaseline: true, baselineReason: "<who asked and what was verified>" }))',
        };
    }
    const label = baselineScopeLabel(scope);
    const metricTasks = metricTaskCount(db);
    const threshold = Math.max(1, Math.floor(config.eval.proposeFreezeAfterTasks));
    // The same snapshot the repair is about to write, taken *before* the gate: no
    // write may happen between the two reads.
    const current = snapshotMetrics(db, now);
    const failure = qualityGateFailure(current, config);
    if (failure !== undefined) {
        log('info', `memory: baseline auto-repair refused for ${label} — the current window does not pass the same quality gate (${failure}); ` +
            `the unhealthy baseline (${failures.join(' and ')}) is left in place, because replacing it now would freeze another bad period. ` +
            `A human freeze is still possible: memory_stats({ setBaseline: true, baselineReason: "<who asked and what was verified>" })`);
        return {
            replaced: false,
            previous,
            metricTasks,
            skipped: `the current window does not pass the same quality gate (${failure})`,
        };
    }
    if (metricTasks < threshold) {
        return {
            replaced: false,
            previous,
            metricTasks,
            skipped: `only ${metricTasks} task metric(s) < eval.proposeFreezeAfterTasks ${threshold}`,
        };
    }
    const note = `auto-repair: replaced an unhealthy baseline (was success ${showMetric(previous.successRate)} / rework ${showMetric(previous.avgRework)}) — ` +
        `failed the gate with ${failures.join(' and ')}; new window: ${metricTasks} task metric(s), ` +
        `success ${showMetric(current.successRate)} / rework ${showMetric(current.avgRework)}, gate window ${config.eval.windowDays}d`;
    try {
        transact(db, () => {
            db.prepare('DELETE FROM baseline_snapshots').run();
            insertSnapshot(db, label, current, note);
        });
    }
    catch (error) {
        log('warn', `memory: baseline auto-repair failed for ${label} — the unhealthy snapshot is unchanged:`, error);
        return { replaced: false, previous, metricTasks, skipped: `the write failed (${String(error)})` };
    }
    const snapshot = { ...current, note };
    log('info', `memory: baseline auto-repaired for ${label} — ${note}`);
    return { replaced: true, previous, snapshot, metricTasks };
}
/** Tolerance so noise in a small ledger does not read as a regression. */
export const TOLERANCE = { successRate: 0.05, duration: 0.15, disturb: 0.5, rework: 0.5 };
/**
 * Compare current metrics against the frozen baseline. The gate is asymmetric on
 * purpose: regressions fail it, improvements pass it, and missing data is
 * "unknown" rather than a silent pass.
 *
 * `pass` therefore needs at least one comparison that actually had data on both
 * sides; a baseline whose four metrics are all `null` (or a current window with
 * no metrics yet) is `unknown`, never `pass`.
 */
export function evaluateGate(current, baseline) {
    if (baseline === undefined || baseline.tasks === 0) {
        return { verdict: 'unknown', unknownReason: 'no-baseline', current, comparisons: [], regressed: [] };
    }
    const comparisons = [
        compare('successRate', '成功率', 'up', baseline.successRate, current.successRate, TOLERANCE.successRate),
        compare('avgDuration', '平均耗时(分钟)', 'down', baseline.avgDuration, current.avgDuration, TOLERANCE.duration, true),
        compare('avgDisturb', '平均打扰次数', 'down', baseline.avgDisturb, current.avgDisturb, TOLERANCE.disturb),
        compare('avgRework', '平均返工轮数', 'down', baseline.avgRework, current.avgRework, TOLERANCE.rework),
    ];
    const regressed = comparisons.filter((item) => item.verdict === 'worse').map((item) => item.label);
    if (regressed.length > 0) {
        return { verdict: 'regression', baseline, current, comparisons, regressed };
    }
    // Every metric had `null` on at least one side: nothing was compared, so
    // there is nothing to pass.
    if (comparisons.every((item) => item.verdict === 'unknown')) {
        return { verdict: 'unknown', unknownReason: 'no-comparable-metrics', baseline, current, comparisons, regressed: [] };
    }
    return { verdict: 'pass', baseline, current, comparisons, regressed: [] };
}
function compare(metric, label, direction, baseline, current, tolerance, relative = false) {
    if (baseline === null || current === null) {
        return { metric, label, direction, baseline, current, delta: null, verdict: 'unknown' };
    }
    const delta = round(current - baseline, 4);
    if (delta === 0)
        return { metric, label, direction, baseline, current, delta, verdict: 'same' };
    const improves = direction === 'up' ? delta > 0 : delta < 0;
    const threshold = relative ? Math.abs(baseline) * tolerance : tolerance;
    if (Math.abs(delta) <= threshold)
        return { metric, label, direction, baseline, current, delta, verdict: 'same' };
    return { metric, label, direction, baseline, current, delta, verdict: improves ? 'better' : 'worse' };
}
/** Memory-quality indicators (DESIGN §11 M5). */
export function healthDigest(db, sinceDays = 30) {
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    const usage = db
        .prepare(`SELECT COUNT(*) AS injections,
                    SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) AS attributed,
                    SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS ok,
                    SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS bad
             FROM usage WHERE injected_at >= ?`)
        .get(since);
    const records = db
        .prepare(`SELECT SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                    SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived,
                    SUM(CASE WHEN expires_at IS NOT NULL AND expires_at < ? THEN 1 ELSE 0 END) AS expired
             FROM records`)
        .get(new Date().toISOString().slice(0, 10));
    const distill = db
        .prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(timed_out), 0) AS timeouts,
                    COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)), 0) AS tokens
             FROM distill WHERE at >= ?`)
        .get(since);
    const conflicts = db.prepare('SELECT COUNT(*) AS n FROM conflicts').get();
    const proposals = db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'open'").get();
    const episodes = db.prepare('SELECT COUNT(*) AS n FROM signals WHERE at >= ?').get(since);
    const attributed = rowInt(usage, 'attributed');
    const success = rowInt(usage, 'ok');
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
    };
}
export function windowSummary(db, days, offsetDays = 0, now = new Date()) {
    const to = new Date(now.getTime() - offsetDays * 86_400_000);
    const from = new Date(to.getTime() - days * 86_400_000);
    const row = db
        .prepare(`SELECT COUNT(*) AS tasks,
                    SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success,
                    SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) AS partial,
                    SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
                    AVG(duration_min) AS avg_duration, AVG(disturb_count) AS avg_disturb,
                    AVG(rework_rounds) AS avg_rework, SUM(lessons) AS lessons
             FROM tasks WHERE date >= ? AND date < ?`)
        .get(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10));
    const num = (key) => rowNum(row, key) ?? 0;
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
    };
}
/** Render the gate + health report for `memory_stats`. */
export function renderEvaluation(gate, health, trend, baselineTasks, progress, baselineHealth) {
    const lines = [];
    lines.push('evaluation gate:');
    const noBaseline = gate.verdict === 'unknown' && (gate.baseline === undefined || gate.unknownReason === 'no-baseline');
    if (noBaseline) {
        lines.push(`  verdict: UNKNOWN — no baseline snapshot yet (tasks so far: ${gate.current.tasks})`);
        if (progress !== undefined) {
            const { metricTasks, threshold, windowDays, autoFreeze, autoFreezeBlocked } = progress;
            const remaining = Math.max(0, threshold - metricTasks);
            if (metricTasks >= threshold) {
                lines.push(`  ${metricTasks} task metric(s) accumulated (threshold ${threshold}, gate window ${windowDays}d) — enough to freeze a baseline`);
                lines.push('  freeze it: memory_stats({ setBaseline: true, baselineReason: "<who asked and what was verified>" })');
                lines.push(!autoFreeze
                    ? '  eval.autoFreezeBaseline is off, so nothing is frozen automatically — this stays a human decision'
                    : autoFreezeBlocked === undefined
                        ? '  eval.autoFreezeBaseline is on: the next memory_stats call freezes it without asking'
                        : `  eval.autoFreezeBaseline is on but the quality gate blocks it (${autoFreezeBlocked}) — nothing is frozen automatically until the window is healthy`);
            }
            else {
                lines.push(`  not enough task metrics yet: ${metricTasks} of ${threshold} required (eval.proposeFreezeAfterTasks) — ${remaining} more task(s) with an outcome/duration/disturb/rework value needed`);
            }
        }
        lines.push('  freeze one only after a good period and an explicit user request: memory_stats({ setBaseline: true, baselineReason: "<who asked and what was verified>" })');
    }
    else {
        // `unknown` is a decision *not* to decide: it must never print PASS.
        const label = gate.verdict === 'pass' ? 'PASS' : gate.verdict === 'regression' ? 'REGRESSION' : 'UNKNOWN（无数据）';
        const suffix = gate.verdict === 'unknown'
            ? ' — none of the four metrics has data on both sides, so the gate cannot judge this period'
            : '';
        lines.push(`  verdict: ${label}${suffix} (baseline ${gate.baseline?.at.slice(0, 19) ?? '?'} · ${gate.baseline?.tasks ?? 0} tasks → now ${gate.current.tasks} tasks)`);
        for (const item of gate.comparisons) {
            const base = item.baseline === null ? 'n/a' : String(item.baseline);
            const now = item.current === null ? 'n/a' : String(item.current);
            lines.push(`    ${item.verdict === 'worse' ? '✗' : item.verdict === 'better' ? '✓' : '·'} ${item.label}: ${base} → ${now} (${item.verdict})`);
        }
        if (gate.regressed.length > 0)
            lines.push(`  regressed: ${gate.regressed.join(', ')} — replay the baseline tasks before trusting the change`);
    }
    // A verdict is only as good as the reference it was computed against, so the
    // state of the snapshot is reported whether or not the gate could use it: a
    // row whose four metrics are all `null` leaves the gate permanently UNKNOWN
    // while wearing the appearance of a calibrated reference.
    if (baselineHealth !== undefined && !baselineHealth.healthy) {
        lines.push('  ⚠ the frozen baseline itself is UNHEALTHY — the gate compares every period against it, so the verdict above cannot be trusted:');
        for (const failure of baselineHealth.failures)
            lines.push(`      ${failure}`);
        lines.push(
        // Deliberately not spelled "PASS": the report must never carry the
        // verdict token for a period the gate could not actually judge
        // (see `the gate is three-state: no comparable data is UNKNOWN, never PASS`).
        '      a baseline frozen from a bad period turns the gate into a rubber stamp: a real regression then reads as a pass');
        lines.push('      re-freeze it after a healthy window: memory_stats({ setBaseline: true, baselineReason: "<who asked and what was verified>" })');
        lines.push(!baselineHealth.autoRepair
            ? '      or turn on automatic repair: eval.autoRepairUnhealthyBaseline: true — it replaces the snapshot only when the current window passes the same quality gate'
            : baselineHealth.autoRepairBlocked !== undefined
                ? `      eval.autoRepairUnhealthyBaseline is on but the reference was left untouched — ${baselineHealth.autoRepairBlocked}`
                : '      eval.autoRepairUnhealthyBaseline is on but the snapshot is still the old one — check the log for the refusal reason');
    }
    // Staleness is not badness: an old reference may still be the right one, it
    // just describes a system that has moved on.
    if (baselineHealth?.stale === true) {
        lines.push(`  note: baseline snapshot is ${baselineHealth.ageDays} day(s) old (> ${baselineHealth.staleAfterDays}d = ${STALE_BASELINE_WINDOW_MULTIPLE}× eval.windowDays ${baselineHealth.windowDays}) — it may no longer represent the current system; re-freeze after a good period if so`);
    }
    lines.push(`  trend: last ${trend.current.days}d ${trend.current.summary.tasks} task(s) (success ${trend.current.summary.success}) vs previous ${trend.previous.summary.tasks} task(s) (success ${trend.previous.summary.success})`);
    lines.push('memory health:');
    lines.push(`  records: active ${health.active} / pending ${health.pending} / archived ${health.archived} (expired ${health.expired})`);
    lines.push(`  recall: ${health.injections} injection(s), ${health.attributed} attributed — hit rate ${health.recallHitRate === null ? 'n/a' : `${(health.recallHitRate * 100).toFixed(0)}%`} (success ${health.successAfterRecall} / failure ${health.failureAfterRecall})`);
    lines.push(`  learning: ${health.episodes} episode signal(s), ${health.distillRuns} distillation(s) / ${health.distillTokens} tok${health.distillTimeouts > 0 ? ` (${health.distillTimeouts} timed out)` : ''}`);
    lines.push(`  open conflicts ${health.conflicts} · open proposals ${health.proposals}`);
    if (baselineTasks.length > 0) {
        lines.push(`  baseline task set (${baselineTasks.length}, for manual replay):`);
        for (const task of baselineTasks.slice(0, 10)) {
            lines.push(`    ${task.index}. ${task.name}${task.project !== undefined ? ` [${task.project}]` : ''}`);
        }
    }
    return lines;
}
function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
//# sourceMappingURL=baseline.js.map