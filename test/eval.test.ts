/**
 * Evaluation-gate tests (DESIGN §11 M5): baseline parsing, metric snapshots,
 * regression verdicts, memory health and the assembled `memory_stats` report.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../dist/config.js'
import {
    assessBaselineHealth,
    evaluateGate,
    freezeBaseline,
    healthDigest,
    latestBaseline,
    maybeFreezeBaseline,
    metricTaskCount,
    parseBaseline,
    readBaseline,
    renderEvaluation,
    repairUnhealthyBaseline,
    snapshotMetrics,
    windowSummary,
} from '../dist/eval/baseline.js'
import { clearRepoCache } from '../dist/paths.js'
import { setLogFile } from '../dist/log.js'
import { ScopeResolver } from '../dist/scope/resolver.js'
import { loadSqliteModule } from '../dist/store/sqlite/db.js'
import { StoreRegistry } from '../dist/store/store.js'
import { AutoCommitter } from '../dist/sync/autocommit.js'
import { consolidateTool, forgetTool } from '../dist/tools/consolidate.js'
import { statsTool } from '../dist/tools/stats.js'
import { syncTool } from '../dist/tools/sync.js'
import { fakeRepo, memoryFixture, tempDir, useGlobalMemoryHome } from './helpers.ts'

const BASELINE_DOC = `# 任务回放基准 (Baseline)

## 指标定义 (metrics.jsonl 字段)

| 字段 | 含义 | 采集方式 |
|---|---|---|
| \`task_id\` | 任务标识 | memory-task-log.sh 生成 |
| \`outcome\` | success / partial / failed | 复盘时写 |
| \`duration_min\` | 交付耗时(分钟) | 复盘估算 |
| \`disturb_count\` | 打扰次数 | 复盘统计 |
| \`rework_rounds\` | 返工轮数 | 复盘估算 |

## 基线任务集 (源自真实历史)

### 1. show_cards_from_card_info (che_pack_php)
- 需求: 从 card_info 展示卡片
- 验收: 卡片列表正确渲染

### 2. bug-fix-develop 流程任务 (che_pack_php)
- 需求: 飞书监控群报错 → 分诊 → 修复
- 验收: 项目归属分诊正确

## 基准机制

- 每任务完成后记一行。
`

function insertTask(
    db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } },
    row: { id: string; date: string; outcome: string; duration?: number; disturb?: number; rework?: number },
): void {
    db.prepare(
        'INSERT INTO tasks (task_id, date, project, summary, outcome, duration_min, disturb_count, rework_rounds, lessons, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(row.id, row.date, 'demo', row.id, row.outcome, row.duration ?? 100, row.disturb ?? 1, row.rework ?? 1, 1, null)
}

async function harness(t: { skip: (reason: string) => void }, config: Record<string, unknown> = {}) {
    clearRepoCache()
    const repo = fakeRepo('m5-repo')
    const globalHome = memoryFixture('m5-global', {})
    useGlobalMemoryHome(globalHome.root)
    const resolved = resolveConfig(config)
    const registry = new StoreRegistry(resolved)
    const report = await registry.initialize(loadSqliteModule)
    if (!registry.available) {
        t.skip(`node:sqlite unavailable: ${report.probe.reason ?? 'unknown'}`)
        throw new Error('unreachable')
    }
    const resolver = new ScopeResolver(resolved)
    const agent = { session: { id: 'm5', header: { cwd: repo } } }
    const scope = resolver.resolve({ agent })
    const store = registry.open(scope)
    assert.ok(store)
    return { repo, resolved, registry, resolver, agent, scope, store, deps: { config: resolved, registry, resolver } }
}

// ---- baseline document ------------------------------------------------------

test('the baseline document parses into metric definitions and tasks', () => {
    const parsed = parseBaseline(BASELINE_DOC)
    assert.equal(parsed.title, '任务回放基准 (Baseline)')
    assert.equal(parsed.tasks.length, 2)
    assert.equal(parsed.tasks[0]?.name, 'show_cards_from_card_info')
    assert.equal(parsed.tasks[0]?.project, 'che_pack_php')
    assert.match(parsed.tasks[0]?.requirement ?? '', /card_info/)
    assert.deepEqual(parsed.tasks[0]?.acceptance, ['卡片列表正确渲染'])
    assert.ok(parsed.metrics.some((metric) => metric.field === 'outcome'))
    assert.ok(parsed.sections.includes('基线任务集 (源自真实历史)'))
})

test('an empty or unrelated document parses to nothing instead of throwing', () => {
    assert.deepEqual(parseBaseline('').tasks, [])
    assert.deepEqual(parseBaseline('# hello\n\nno sections here').tasks, [])
})

test('the real baseline document lists its task set when present', () => {
    const home = process.env['DSH_HOME'] ?? path.join(process.env['HOME'] ?? '', '.dsh')
    const file = path.join(home, 'memory', 'baseline.md')
    if (!fs.existsSync(file)) return
    const parsed = parseBaseline(fs.readFileSync(file, 'utf8'))
    assert.ok(parsed.tasks.length >= 5, `expected the baseline task set, got ${parsed.tasks.length}`)
    assert.ok(parsed.metrics.length >= 3)
})

// ---- snapshots and gate -----------------------------------------------------

test('metrics snapshot, freeze and reload round-trip', async (t) => {
    const h = await harness(t)
    insertTask(h.store.db, { id: 't1', date: '2026-09-01', outcome: 'success', duration: 100, disturb: 1, rework: 1 })
    insertTask(h.store.db, { id: 't2', date: '2026-09-02', outcome: 'failed', duration: 200, disturb: 3, rework: 4 })

    assert.equal(latestBaseline(h.store.db), undefined)
    const snapshot = snapshotMetrics(h.store.db, new Date('2026-09-10T00:00:00.000Z'), 'after first week')
    assert.equal(snapshot.tasks, 2)
    assert.equal(snapshot.successRate, 0.5)
    assert.equal(snapshot.avgDuration, 150)
    assert.equal(snapshot.avgDisturb, 2)
    assert.equal(snapshot.avgRework, 2.5)

    freezeBaseline(h.store.db, 'project:demo', 'after first week', new Date('2026-09-10T00:00:00.000Z'))
    const loaded = latestBaseline(h.store.db)
    assert.equal(loaded?.successRate, 0.5)
    assert.equal(loaded?.note, 'after first week')
    assert.equal(loaded?.tasks, 2)
})

test('the gate passes on ties and improvements, fails on regressions', () => {
    const base = { at: '2026-09-01T00:00:00.000Z', tasks: 4, successRate: 0.8, avgDuration: 100, avgDisturb: 1, avgRework: 1 }
    assert.equal(evaluateGate(base, undefined).verdict, 'unknown')
    assert.equal(evaluateGate(base, undefined).unknownReason, 'no-baseline')
    assert.equal(evaluateGate(base, { ...base, tasks: 0 }).verdict, 'unknown')
    assert.equal(evaluateGate(base, { ...base, tasks: 0 }).unknownReason, 'no-baseline')
    assert.equal(evaluateGate({ ...base, tasks: 8 }, base).verdict, 'pass')

    const dropSuccess = evaluateGate({ ...base, tasks: 8, successRate: 0.5 }, base)
    assert.equal(dropSuccess.verdict, 'regression')
    assert.deepEqual(dropSuccess.regressed, ['成功率'])

    const slower = evaluateGate({ ...base, tasks: 8, avgDuration: 140 }, base)
    assert.equal(slower.verdict, 'regression')
    assert.deepEqual(slower.regressed, ['平均耗时(分钟)'])

    const noisier = evaluateGate({ ...base, tasks: 8, avgDisturb: 2, avgRework: 3 }, base)
    assert.equal(noisier.verdict, 'regression')
    assert.deepEqual(noisier.regressed.sort(), ['平均打扰次数', '平均返工轮数'])

    // small drift inside the tolerance is noise, not a regression
    assert.equal(evaluateGate({ ...base, tasks: 8, successRate: 0.78, avgDuration: 108, avgDisturb: 1.2 }, base).verdict, 'pass')
    const unknown = evaluateGate({ ...base, tasks: 8, avgDuration: null }, base)
    assert.equal(unknown.comparisons.find((item) => item.metric === 'avgDuration')?.verdict, 'unknown')
})

test('the gate is three-state: no comparable data is UNKNOWN, never PASS', () => {
    const empty = {
        at: '2026-09-01T00:00:00.000Z',
        tasks: 3,
        successRate: null,
        avgDuration: null,
        avgDisturb: null,
        avgRework: null,
    }
    // a baseline that exists but carries no metric at all
    const allNull = evaluateGate(empty, { ...empty, tasks: 2 })
    assert.equal(allNull.verdict, 'unknown', 'four null metrics must not read as a pass')
    assert.equal(allNull.unknownReason, 'no-comparable-metrics')
    assert.deepEqual(allNull.regressed, [])
    assert.ok(allNull.comparisons.every((item) => item.verdict === 'unknown'))
    assert.equal(allNull.baseline?.tasks, 2)

    // a current window with no metrics yet, against a full baseline: same state
    const noCurrentData = evaluateGate({ ...empty, tasks: 9 }, { ...empty, tasks: 2, successRate: 0.8, avgDuration: 100 })
    assert.equal(noCurrentData.verdict, 'unknown')
    assert.equal(noCurrentData.unknownReason, 'no-comparable-metrics')

    // one comparable metric is enough to decide — and only if it does not regress
    const oneMetric = { ...empty, tasks: 4, successRate: 0.9 }
    assert.equal(evaluateGate({ ...oneMetric, tasks: 8 }, oneMetric).verdict, 'pass')
    assert.equal(evaluateGate({ ...oneMetric, tasks: 8, successRate: 1 }, oneMetric).verdict, 'pass')
    assert.equal(evaluateGate({ ...oneMetric, tasks: 8, successRate: 0.5 }, oneMetric).verdict, 'regression')
})

test('the rendered gate prints UNKNOWN（无数据）rather than PASS when nothing is comparable', async (t) => {
    const h = await harness(t)
    h.store.db
        .prepare('INSERT INTO baseline_snapshots (at, scope, tasks, success_rate, avg_duration, avg_disturb, avg_rework, note) VALUES (?,?,?,?,?,?,?,?)')
        .run('2026-09-01T00:00:00.000Z', 'project:demo', 2, null, null, null, null, null)
    const gate = evaluateGate(snapshotMetrics(h.store.db), latestBaseline(h.store.db))
    assert.equal(gate.verdict, 'unknown')
    const trend = { current: windowSummary(h.store.db, 30), previous: windowSummary(h.store.db, 30, 30) }
    const text = renderEvaluation(gate, healthDigest(h.store.db), trend, []).join('\n')
    assert.match(text, /verdict: UNKNOWN（无数据）/)
    assert.doesNotMatch(text, /PASS/)

    // the tool surface says the same thing
    const report = String(await statsTool(h.deps).execute({} as never, { agent: h.agent } as never))
    assert.match(report, /verdict: UNKNOWN（无数据）/)
    assert.doesNotMatch(report, /PASS/)
})

test('success rate ignores tasks with no outcome and reports n/a without data', async (t) => {
    const h = await harness(t)
    assert.equal(snapshotMetrics(h.store.db).successRate, null)
    insertTask(h.store.db, { id: 'a', date: '2026-09-01', outcome: 'success' })
    h.store.db.prepare('INSERT INTO tasks (task_id, date, project, summary, outcome) VALUES (?, ?, ?, ?, ?)').run('b', '2026-09-02', 'demo', 'pending task', null)
    const snapshot = snapshotMetrics(h.store.db)
    assert.equal(snapshot.tasks, 2)
    assert.equal(snapshot.successRate, 1, 'the undecided task is not counted as a failure')
})

// ---- health and trends ------------------------------------------------------

test('health digest reports recall hit rate, backlog and learning cost', async (t) => {
    const h = await harness(t)
    const now = new Date().toISOString()
    h.store.db.prepare('INSERT INTO records (id, layer, scope_kind, title, body, tags, confidence, times_seen, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run('r1', 'project', 'project', 'active one', 'body', '[]', 0.9, 1, 'active', now, now)
    h.store.db.prepare('INSERT INTO records (id, layer, scope_kind, title, body, tags, confidence, times_seen, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run('r2', 'project', 'project', 'pending one', 'body', '[]', 0.4, 1, 'pending', now, now)
    const usage = h.store.db.prepare('INSERT INTO usage (record_id, session_id, turn, step, score, injected_at, outcome) VALUES (?,?,?,?,?,?,?)')
    usage.run('r1', 's1', 1, 1, 0.9, now, 'success')
    usage.run('r1', 's1', 2, 1, 0.9, now, 'failure')
    usage.run('r2', 's1', 3, 1, 0.5, now, null)
    h.store.db.prepare('INSERT INTO distill (session_id, turn, model, prompt_hash, tokens_in, tokens_out, created_count, timed_out, at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run('s1', 1, 'm', 'h', 100, 50, 1, 1, now)

    const health = healthDigest(h.store.db)
    assert.equal(health.injections, 3)
    assert.equal(health.attributed, 2)
    assert.equal(health.successAfterRecall, 1)
    assert.equal(health.failureAfterRecall, 1)
    assert.equal(health.recallHitRate, 0.5)
    assert.equal(health.active, 1)
    assert.equal(health.pending, 1)
    assert.equal(health.distillTokens, 150)
    assert.equal(health.distillTimeouts, 1)
})

test('trend windows separate the current period from the previous one', async (t) => {
    const h = await harness(t)
    const now = new Date('2026-09-14T00:00:00.000Z')
    insertTask(h.store.db, { id: 'recent', date: '2026-09-10', outcome: 'success' })
    insertTask(h.store.db, { id: 'older', date: '2026-08-20', outcome: 'failed' })
    const current = windowSummary(h.store.db, 14, 0, now)
    const previous = windowSummary(h.store.db, 14, 14, now)
    assert.equal(current.summary.tasks, 1)
    assert.equal(current.summary.success, 1)
    assert.equal(previous.summary.tasks, 1)
    assert.equal(previous.summary.failed, 1)
})

test('the rendered report states the verdict and the baseline task list', async (t) => {
    const h = await harness(t)
    insertTask(h.store.db, { id: 't1', date: '2026-09-01', outcome: 'success' })
    freezeBaseline(h.store.db, 'project:demo')
    insertTask(h.store.db, { id: 't2', date: '2026-09-02', outcome: 'failed', duration: 400, disturb: 4, rework: 5 })
    const gate = evaluateGate(snapshotMetrics(h.store.db), latestBaseline(h.store.db))
    const lines = renderEvaluation(gate, healthDigest(h.store.db), { current: windowSummary(h.store.db, 30), previous: windowSummary(h.store.db, 30, 30) }, parseBaseline(BASELINE_DOC).tasks)
    const text = lines.join('\n')
    assert.match(text, /REGRESSION/)
    assert.match(text, /baseline task set \(2, for manual replay\)/)
    assert.match(text, /show_cards_from_card_info/)

    const empty = renderEvaluation(evaluateGate(snapshotMetrics(h.store.db), undefined), healthDigest(h.store.db), { current: windowSummary(h.store.db, 30), previous: windowSummary(h.store.db, 30, 30) }, [])
    assert.match(empty.join('\n'), /no baseline snapshot yet/)
})

// ---- tool surface -----------------------------------------------------------

test('memory_stats freezes a baseline and then reports the regression', async (t) => {
    const h = await harness(t)
    insertTask(h.store.db, { id: 'good', date: '2026-09-01', outcome: 'success', duration: 100, disturb: 1, rework: 1 })
    fs.writeFileSync(path.join(h.scope.root, 'baseline.md'), BASELINE_DOC)

    const tool = statsTool(h.deps)
    const frozen = String(
        await tool.execute({ setBaseline: true, baselineReason: 'user asked after a good week', note: 'good week' } as never, {
            agent: h.agent,
        } as never),
    )
    assert.match(frozen, /baseline frozen: 1 task/)
    assert.match(frozen, /verdict: PASS/)

    insertTask(h.store.db, { id: 'bad', date: '2026-09-05', outcome: 'failed', duration: 300, disturb: 5, rework: 6 })
    const after = String(await tool.execute({} as never, { agent: h.agent } as never))
    assert.match(after, /verdict: REGRESSION/)
    assert.match(after, /regressed:/)
    assert.match(after, /baseline task set \(2, for manual replay\)/)
    assert.match(after, /memory health:/)

    const readBack = readBaseline(h.scope)
    assert.equal(readBack?.tasks.length, 2)
})

// ---- baseline freezing is a human-review step --------------------------------

test('memory_stats refuses setBaseline without a reason, and refuses subagents entirely', async (t) => {
    const h = await harness(t)
    insertTask(h.store.db, { id: 'good', date: '2026-09-01', outcome: 'success' })
    const tool = statsTool(h.deps)
    const snapshots = (): unknown => h.store.db.prepare('SELECT COUNT(*) AS n FROM baseline_snapshots').get()?.['n']

    const noReason = String(await tool.execute({ setBaseline: true } as never, { agent: h.agent } as never))
    assert.match(noReason, /refused/)
    assert.match(noReason, /human-review/)
    assert.match(noReason, /baselineReason/)
    assert.equal(snapshots(), 0, 'a refused freeze must not write a snapshot')

    const blankReason = String(
        await tool.execute({ setBaseline: true, baselineReason: '   ' } as never, { agent: h.agent } as never),
    )
    assert.match(blankReason, /refused/)
    assert.equal(snapshots(), 0)

    const subagent = { session: { id: 'm5-sub', header: { cwd: h.repo, origin: 'subagent' } } }
    const asSubagent = String(
        await tool.execute({ setBaseline: true, baselineReason: 'the subagent felt like it' } as never, {
            agent: subagent,
        } as never),
    )
    assert.match(asSubagent, /refused/)
    assert.match(asSubagent, /subagentWrite/)
    assert.equal(snapshots(), 0, 'a subagent must not freeze the gate reference')

    // reading the report is still allowed for the same subagent
    const readOnly = String(await tool.execute({} as never, { agent: subagent } as never))
    assert.doesNotMatch(readOnly, /refused/)
})

test('a permitted freeze is logged with its reason and the calling session id', async (t) => {
    const h = await harness(t)
    insertTask(h.store.db, { id: 'good', date: '2026-09-01', outcome: 'success' })
    const logFile = path.join(tempDir('m5-log'), 'memory.log')
    setLogFile(logFile)

    const output = String(
        await statsTool(h.deps).execute(
            { setBaseline: true, baselineReason: 'user: 冻结基线，M5 验收通过' } as never,
            { agent: h.agent } as never,
        ),
    )
    assert.match(output, /baseline frozen: 1 task/)
    assert.match(output, /reason: user: 冻结基线，M5 验收通过/)
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM baseline_snapshots').get()?.['n'], 1)

    const logged = fs.readFileSync(logFile, 'utf8')
    assert.match(logged, /baseline frozen/)
    assert.match(logged, /session m5/, 'the log must name the calling session')
    assert.match(logged, /user: 冻结基线，M5 验收通过/, 'the log must carry the reason')
})

// ---- automatic freeze (eval.autoFreezeBaseline) -------------------------------

/** Snapshot rows in the scope's own database. */
function snapshotCount(h: { store: { db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } } } }): unknown {
    return h.store.db.prepare('SELECT COUNT(*) AS n FROM baseline_snapshots').get()?.['n']
}

test('autoFreezeBaseline never freezes on too little data, and says how much is missing', async (t) => {
    const h = await harness(t, { eval: { autoFreezeBaseline: true, proposeFreezeAfterTasks: 5 } })
    insertTask(h.store.db, { id: 't1', date: '2026-09-01', outcome: 'success' })
    insertTask(h.store.db, { id: 't2', date: '2026-09-02', outcome: 'failed' })

    assert.equal(metricTaskCount(h.store.db), 2)
    assert.equal(
        maybeFreezeBaseline(h.store.db, h.scope, h.deps.config),
        undefined,
        'freezing without enough data would create a reference that judges nothing',
    )
    assert.equal(snapshotCount(h), 0)

    const report = String(await statsTool(h.deps).execute({} as never, { agent: h.agent } as never))
    assert.match(report, /verdict: UNKNOWN/)
    assert.match(report, /not enough task metrics yet: 2 of 5 required/)
    assert.match(report, /3 more task\(s\)/)
    assert.doesNotMatch(report, /enough to freeze a baseline/)

    // A ledger row that carries no gate metric is not data: freezing on such
    // rows would only produce a snapshot whose four metrics are all null.
    h.store.db
        .prepare('INSERT INTO tasks (task_id, date, project, summary, outcome) VALUES (?,?,?,?,?)')
        .run('t3', '2026-09-03', 'demo', 'no metrics yet', null)
    assert.equal(metricTaskCount(h.store.db), 2, 'a row with no metric does not count')
    assert.equal(maybeFreezeBaseline(h.store.db, h.scope, h.deps.config), undefined)
    assert.equal(snapshotCount(h), 0)
})

test('enough data with the knob off asks the human to freeze, and freezes nothing itself', async (t) => {
    const h = await harness(t, { eval: { autoFreezeBaseline: false, proposeFreezeAfterTasks: 3 } })
    for (const [index, outcome] of ['success', 'success', 'failed'].entries()) {
        insertTask(h.store.db, { id: `t${index}`, date: `2026-09-0${index + 1}`, outcome })
    }

    assert.equal(metricTaskCount(h.store.db), 3)
    assert.equal(maybeFreezeBaseline(h.store.db, h.scope, h.deps.config), undefined)

    const report = String(await statsTool(h.deps).execute({} as never, { agent: h.agent } as never))
    assert.match(report, /verdict: UNKNOWN/)
    assert.match(report, /3 task metric\(s\) accumulated \(threshold 3, gate window 30d\) — enough to freeze a baseline/)
    assert.match(
        report,
        /memory_stats\(\{ setBaseline: true, baselineReason: "<who asked and what was verified>" \}\)/,
        'the report must hand over a copyable freeze command',
    )
    assert.match(report, /eval\.autoFreezeBaseline is off/)
    assert.equal(snapshotCount(h), 0, 'a hint must never freeze anything by itself')
})

test('autoFreezeBaseline freezes once (idempotent) and turns the verdict real', async (t) => {
    const h = await harness(t, { eval: { autoFreezeBaseline: true, proposeFreezeAfterTasks: 3 } })
    for (let index = 0; index < 4; index += 1) {
        insertTask(h.store.db, {
            id: `t${index}`,
            date: `2026-09-0${index + 1}`,
            outcome: 'success',
            duration: 100,
            disturb: 1,
            rework: 1,
        })
    }

    const frozen = maybeFreezeBaseline(h.store.db, h.scope, h.deps.config, new Date('2026-09-10T00:00:00.000Z'))
    assert.ok(frozen, 'four metric rows clear the threshold of three')
    assert.equal(frozen.tasks, 4)
    assert.equal(frozen.successRate, 1)
    assert.match(frozen.note ?? '', /auto-freeze \(eval\.autoFreezeBaseline\): 4 task metric\(s\), gate window 30d/)
    assert.equal(snapshotCount(h), 1)

    // An existing snapshot is the reference the gate compares against; a second
    // call must not replace it (that is how a regression gets erased).
    assert.equal(maybeFreezeBaseline(h.store.db, h.scope, h.deps.config, new Date('2026-09-20T00:00:00.000Z')), undefined)
    assert.equal(snapshotCount(h), 1)
    assert.equal(latestBaseline(h.store.db)?.at, '2026-09-10T00:00:00.000Z')

    // The tool path renders a real verdict now instead of UNKNOWN, and a stats
    // call does not refreeze what is already there.
    const report = String(await statsTool(h.deps).execute({} as never, { agent: h.agent } as never))
    assert.match(report, /verdict: PASS/)
    assert.doesNotMatch(report, /UNKNOWN/)
    assert.equal(snapshotCount(h), 1)

    insertTask(h.store.db, { id: 'bad', date: '2026-09-11', outcome: 'failed', duration: 400, disturb: 5, rework: 6 })
    const after = String(await statsTool(h.deps).execute({} as never, { agent: h.agent } as never))
    assert.match(after, /verdict: REGRESSION/)
    assert.equal(snapshotCount(h), 1, 'a regression must not be washed away by a refreeze')
})

test('a stats call freezes the first baseline by itself when the knob is on', async (t) => {
    const h = await harness(t, { eval: { autoFreezeBaseline: true, proposeFreezeAfterTasks: 2 } })
    insertTask(h.store.db, { id: 't1', date: '2026-09-01', outcome: 'success' })
    insertTask(h.store.db, { id: 't2', date: '2026-09-02', outcome: 'success' })

    const report = String(await statsTool(h.deps).execute({} as never, { agent: h.agent } as never))
    assert.match(report, /baseline auto-frozen — auto-freeze \(eval\.autoFreezeBaseline\): 2 task metric\(s\), gate window 30d/)
    assert.match(report, /verdict: PASS/)
    assert.equal(snapshotCount(h), 1)
})

test('a subagent reading memory_stats cannot trigger the auto-freeze', async (t) => {
    const h = await harness(t, { eval: { autoFreezeBaseline: true, proposeFreezeAfterTasks: 2 } })
    insertTask(h.store.db, { id: 't1', date: '2026-09-01', outcome: 'success' })
    insertTask(h.store.db, { id: 't2', date: '2026-09-02', outcome: 'success' })
    const subagent = { session: { id: 'm5-sub', header: { cwd: h.repo, origin: 'subagent' } } }

    const report = String(await statsTool(h.deps).execute({} as never, { agent: subagent } as never))
    assert.doesNotMatch(report, /refused/)
    assert.equal(snapshotCount(h), 0, 'freezing the gate reference stays with the top-level session')
    assert.match(report, /eval\.autoFreezeBaseline is on/)

    const topLevel = String(await statsTool(h.deps).execute({} as never, { agent: h.agent } as never))
    assert.match(topLevel, /baseline auto-frozen/)
    assert.equal(snapshotCount(h), 1)
})

// ---- write authorization for subagent sessions -------------------------------

test('a subagent cannot archive, reindex or sync memory, and nothing is written', async (t) => {
    const h = await harness(t)
    const now = new Date().toISOString()
    h.store.db
        .prepare('INSERT INTO records (id, layer, scope_kind, title, body, tags, confidence, times_seen, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run('keep-me', 'project', 'project', 'a lesson', 'body', '[]', 0.9, 1, 'active', now, now)
    const subagent = { session: { id: 'm5-sub', header: { cwd: h.repo, origin: 'subagent' } } }
    const statusOf = (): unknown => h.store.db.prepare('SELECT status FROM records WHERE id = ?').get('keep-me')?.['status']

    const forget = forgetTool({ config: h.resolved, registry: h.registry, resolver: h.resolver })
    const refused = String(await forget.execute({ id: 'keep-me', reason: 'subagent tries to archive' } as never, { agent: subagent } as never))
    assert.match(refused, /refused/)
    assert.match(refused, /subagent sessions do not write memory by default/)
    assert.match(refused, /routing\.subagentWrite/)
    assert.equal(statusOf(), 'active', 'a refused forget must leave the record untouched')
    assert.ok(!fs.existsSync(path.join(h.scope.root, 'archive', 'lessons', 'keep-me.md')))

    const consolidate = consolidateTool({ config: h.resolved, registry: h.registry, resolver: h.resolver })
    const applied = String(await consolidate.execute({ dryRun: false } as never, { agent: subagent } as never))
    assert.match(applied, /refused/)
    const decided = String(await consolidate.execute({ acceptProposal: 'keep-me' } as never, { agent: subagent } as never))
    assert.match(decided, /refused/)
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM consolidate_runs').get()?.['n'], 0, 'no pass may have run')
    // the read-only shapes of the same tool stay available to a subagent
    const dryRun = String(await consolidate.execute({} as never, { agent: subagent } as never))
    assert.doesNotMatch(dryRun, /refused/)
    const proposals = String(await consolidate.execute({ listProposals: true } as never, { agent: subagent } as never))
    assert.doesNotMatch(proposals, /refused/)

    const sync = syncTool({
        config: h.resolved,
        registry: h.registry,
        resolver: h.resolver,
        committer: new AutoCommitter(h.resolved),
    })
    const syncRefused = String(await sync.execute({ push: true } as never, { agent: subagent } as never))
    assert.match(syncRefused, /refused/)
    assert.ok(!fs.existsSync(path.join(h.scope.root, '.git')), 'a refused sync must not even git-init the memory root')

    // the same write from the top-level session still goes through
    const allowed = String(await forget.execute({ id: 'keep-me', reason: 'user asked to retire it' } as never, { agent: h.agent } as never))
    assert.doesNotMatch(allowed, /refused/)
    assert.match(allowed, /retired: keep-me/)
    assert.equal(statusOf(), 'archived')
})

// ---- the auto-freeze quality gate --------------------------------------------

test('auto-freeze refuses an unhealthy window and says why, without writing a snapshot', async (t) => {
    // The bug: the only condition was "enough metric rows". A period with a 12%
    // success rate and 6.1 rework rounds per task was frozen as the reference,
    // which turns the gate into a rubber stamp (DESIGN §11: a freeze is a human
    // calibration step, and only after a *good* period).
    const h = await harness(t, { eval: { autoFreezeBaseline: true, proposeFreezeAfterTasks: 3 } })
    for (let index = 0; index < 4; index += 1) {
        insertTask(h.store.db, {
            id: `bad${index}`,
            date: `2026-09-0${index + 1}`,
            outcome: 'failed',
            duration: 300,
            disturb: 4,
            rework: 6,
        })
    }
    const logFile = path.join(tempDir('m5-freeze-gate-log'), 'memory.log')
    setLogFile(logFile)
    try {
        assert.equal(
            maybeFreezeBaseline(h.store.db, h.scope, h.deps.config, new Date('2026-09-10T00:00:00.000Z')),
            undefined,
            'an unhealthy window must not become the gate reference',
        )
        assert.equal(snapshotCount(h), 0, 'nothing was frozen')
        const logged = fs.readFileSync(logFile, 'utf8')
        assert.match(logged, /\[info\][^\n]*quality gate not met/, 'the refusal is explained, not silent')
        assert.match(logged, /current success 0 < eval\.autoFreezeMinSuccessRate 0\.5/, 'it names the rate and its threshold')
        assert.match(logged, /current rework 6 > eval\.autoFreezeMaxRework 3/, 'and the rework side too')
    } finally {
        setLogFile(undefined)
    }

    // The stats hint must not promise a freeze the gate would refuse.
    const hint = String(await statsTool(h.deps).execute({} as never, { agent: h.agent } as never))
    assert.doesNotMatch(hint, /the next memory_stats call freezes it without asking/)
    assert.match(hint, /eval\.autoFreezeBaseline is on but the quality gate blocks it/)
    assert.match(hint, /current success 0 < eval\.autoFreezeMinSuccessRate 0\.5/)
    assert.equal(snapshotCount(h), 0, 'reading the report still must not freeze anything')

    // The human path still works, and a healthy window freezes normally.
    const healthy = await harness(t, { eval: { autoFreezeBaseline: true, proposeFreezeAfterTasks: 3 } })
    for (let index = 0; index < 4; index += 1) {
        insertTask(healthy.store.db, {
            id: `good${index}`,
            date: `2026-09-0${index + 1}`,
            outcome: 'success',
            duration: 60,
            disturb: 0,
            rework: 1,
        })
    }
    const frozen = maybeFreezeBaseline(healthy.store.db, healthy.scope, healthy.deps.config, new Date('2026-09-10T00:00:00.000Z'))
    assert.ok(frozen, 'a healthy window still freezes')
    assert.equal(frozen.successRate, 1)
    // and the snapshot stays a one-off (idempotence is unchanged)
    assert.equal(maybeFreezeBaseline(healthy.store.db, healthy.scope, healthy.deps.config, new Date('2026-09-20T00:00:00.000Z')), undefined)
    assert.equal(snapshotCount(healthy), 1)
})

test('the quality gate reads its thresholds from eval config', async (t) => {
    const h = await harness(t, {
        eval: { autoFreezeBaseline: true, proposeFreezeAfterTasks: 2, autoFreezeMinSuccessRate: 0.9, autoFreezeMaxRework: 0 },
    })
    insertTask(h.store.db, { id: 'a', date: '2026-09-01', outcome: 'success', duration: 60, disturb: 0, rework: 1 })
    insertTask(h.store.db, { id: 'b', date: '2026-09-02', outcome: 'failed', duration: 60, disturb: 0, rework: 1 })

    // success 0.5 < the configured 0.9: refused
    assert.equal(maybeFreezeBaseline(h.store.db, h.scope, h.deps.config), undefined)
    assert.equal(snapshotCount(h), 0)

    // the same window with the *default* thresholds (0.5 / 3) is healthy
    const lenient = { ...h.deps.config, eval: { ...h.deps.config.eval, autoFreezeMinSuccessRate: 0.5, autoFreezeMaxRework: 3 } }
    assert.ok(maybeFreezeBaseline(h.store.db, h.scope, lenient, new Date('2026-09-10T00:00:00.000Z')))
    assert.equal(snapshotCount(h), 1)
})

// ---- an unhealthy frozen baseline: detect always, repair only on request ------
//
// The quality gate above stops a *bad freeze* from happening. It cannot undo one
// that already happened: the live store had `success_rate 0.122 / avg_rework 6.12`
// frozen as the reference, and every later period was compared against it, so a
// genuine regression read as PASS. The frozen row is human-owned data (DESIGN §11)
// — detection therefore only reports, and replacement needs an explicit knob.

/** The shape of the live accident: a bad period that somehow became the reference. */
function insertBadWindow(
    h: { store: { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } } },
    count = 3,
): void {
    for (let index = 0; index < count; index += 1) {
        insertTask(h.store.db, {
            id: `bad${index}`,
            date: `2026-09-0${index + 1}`,
            outcome: 'failed',
            duration: 300,
            disturb: 4,
            rework: 6,
        })
    }
}

/** A healthy period after the bad freeze: success 1, one rework round per task. */
function insertGoodWindow(
    h: { store: { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } } },
    count = 3,
): void {
    for (let index = 0; index < count; index += 1) {
        insertTask(h.store.db, {
            id: `good${index}`,
            date: `2026-09-1${index}`,
            outcome: 'success',
            duration: 60,
            disturb: 0,
            rework: 1,
        })
    }
}

/** Freeze the bad period the way the pre-gate auto-freeze did, then let the ledger recover. */
function freezeBadSnapshot(h: Awaited<ReturnType<typeof harness>>, note = 'the bad freeze'): void {
    insertBadWindow(h, 1)
    freezeBaseline(h.store.db, 'project:demo', note, new Date('2026-09-02T00:00:00.000Z'))
}

test('an unhealthy frozen baseline is reported with a remedy and is never rewritten with the knob off', async (t) => {
    const h = await harness(t, { eval: { autoRepairUnhealthyBaseline: false, proposeFreezeAfterTasks: 3 } })
    freezeBadSnapshot(h)
    insertGoodWindow(h, 3)
    const before = latestBaseline(h.store.db)

    const report = String(await statsTool(h.deps).execute({} as never, { agent: h.agent } as never))
    assert.match(report, /the frozen baseline itself is UNHEALTHY/, 'the reference is called out, not silently trusted')
    assert.match(report, /baseline success 0 < eval\.autoFreezeMinSuccessRate 0\.5/, 'it names the value and its threshold')
    assert.match(report, /baseline rework 6 > eval\.autoFreezeMaxRework 3/, 'and the rework side too')
    assert.match(report, /the verdict above cannot be trusted/, 'a gate comparing against a bad reference judges nothing')
    assert.match(
        report,
        /memory_stats\(\{ setBaseline: true, baselineReason: "<who asked and what was verified>" \}\)/,
        'the human remedy is copyable',
    )
    assert.match(report, /eval\.autoRepairUnhealthyBaseline/, 'and the automatic knob is named as the alternative')

    assert.deepEqual(latestBaseline(h.store.db), before, 'default is report-only: the human-owned reference stays')
    assert.equal(latestBaseline(h.store.db)?.note, 'the bad freeze')
    assert.equal(snapshotCount(h), 1)
})

test('autoRepairUnhealthyBaseline replaces the bad snapshot with a healthy window', async (t) => {
    const h = await harness(t, { eval: { autoRepairUnhealthyBaseline: true, proposeFreezeAfterTasks: 3 } })
    freezeBadSnapshot(h)
    insertGoodWindow(h, 3)
    assert.equal(latestBaseline(h.store.db)?.successRate, 0)
    assert.equal(latestBaseline(h.store.db)?.avgRework, 6)

    const logFile = path.join(tempDir('m5-repair-log'), 'memory.log')
    setLogFile(logFile)
    let report: string
    try {
        report = String(await statsTool(h.deps).execute({} as never, { agent: h.agent } as never))
        const logged = fs.readFileSync(logFile, 'utf8')
        assert.match(logged, /\[info\][^\n]*baseline auto-repaired/, 'the replacement is auditable in the log')
        assert.match(logged, /was success 0 \/ rework 6/, 'the log names what was retired')
    } finally {
        setLogFile(undefined)
    }

    assert.equal(snapshotCount(h), 1, 'the bad row is replaced, not appended to')
    const repaired = latestBaseline(h.store.db)
    assert.match(
        repaired?.note ?? '',
        /auto-repair: replaced an unhealthy baseline \(was success 0 \/ rework 6\)/,
        'the note says this was a self-repair and why',
    )
    const current = snapshotMetrics(h.store.db)
    assert.equal(repaired?.tasks, current.tasks)
    assert.equal(repaired?.successRate, current.successRate, 'the new reference is the healthy window itself')
    assert.equal(repaired?.successRate, 0.75)
    assert.equal(repaired?.avgRework, current.avgRework)
    assert.equal(repaired?.avgRework, 2.25)

    assert.match(report, /baseline auto-repaired — auto-repair: replaced an unhealthy baseline/)
    assert.doesNotMatch(report, /UNHEALTHY/, 'after the repair the reference is healthy again')
    assert.match(report, /verdict: PASS/)
})

test('auto-repair refuses while the current window is unhealthy and logs the reason', async (t) => {
    const h = await harness(t, { eval: { autoRepairUnhealthyBaseline: true, proposeFreezeAfterTasks: 3 } })
    insertBadWindow(h, 3)
    freezeBaseline(h.store.db, 'project:demo', 'the bad freeze', new Date('2026-09-02T00:00:00.000Z'))
    const before = latestBaseline(h.store.db)

    const logFile = path.join(tempDir('m5-repair-refuse-log'), 'memory.log')
    setLogFile(logFile)
    let report: string
    try {
        report = String(await statsTool(h.deps).execute({} as never, { agent: h.agent } as never))
        const logged = fs.readFileSync(logFile, 'utf8')
        assert.match(logged, /\[info\][^\n]*baseline auto-repair refused/, 'the refusal is explained, not silent')
        assert.match(logged, /current success 0 < eval\.autoFreezeMinSuccessRate 0\.5/)
        assert.match(logged, /current rework 6 > eval\.autoFreezeMaxRework 3/)
    } finally {
        setLogFile(undefined)
    }

    assert.deepEqual(latestBaseline(h.store.db), before, 'a bad window must never be frozen as the new reference')
    assert.equal(latestBaseline(h.store.db)?.note, 'the bad freeze')
    assert.equal(snapshotCount(h), 1)
    assert.match(report, /eval\.autoRepairUnhealthyBaseline is on but the reference was left untouched/)
    assert.match(report, /does not pass the same quality gate/)
})

test('auto-repair waits until the current window has enough task metrics', async (t) => {
    // A baseline is unhealthy on one side alone: success 0 is enough here, while
    // rework 0 keeps the *current* window (success 0.5 / rework 0.5) healthy.
    const h = await harness(t, { eval: { autoRepairUnhealthyBaseline: true, proposeFreezeAfterTasks: 5 } })
    insertTask(h.store.db, { id: 'bad', date: '2026-09-01', outcome: 'failed', duration: 10, disturb: 1, rework: 0 })
    freezeBaseline(h.store.db, 'project:demo', 'the bad freeze', new Date('2026-09-02T00:00:00.000Z'))
    insertTask(h.store.db, { id: 'good', date: '2026-09-03', outcome: 'success', duration: 60, disturb: 0, rework: 1 })

    const report = String(await statsTool(h.deps).execute({} as never, { agent: h.agent } as never))
    assert.equal(latestBaseline(h.store.db)?.note, 'the bad freeze', 'too little data: nothing is rewritten')
    assert.equal(snapshotCount(h), 1)
    assert.match(report, /eval\.autoRepairUnhealthyBaseline is on but the reference was left untouched/)
    assert.match(report, /only 2 task metric\(s\) < eval\.proposeFreezeAfterTasks 5/)
})

test('auto-repair leaves a healthy baseline alone', async (t) => {
    const h = await harness(t, { eval: { autoRepairUnhealthyBaseline: true, proposeFreezeAfterTasks: 2 } })
    insertTask(h.store.db, { id: 'good', date: '2026-09-01', outcome: 'success', duration: 60, disturb: 0, rework: 1 })
    freezeBaseline(h.store.db, 'project:demo', 'good week', new Date('2026-09-02T00:00:00.000Z'))
    insertTask(h.store.db, { id: 'good2', date: '2026-09-03', outcome: 'success', duration: 60, disturb: 0, rework: 1 })

    const report = String(await statsTool(h.deps).execute({} as never, { agent: h.agent } as never))
    assert.equal(latestBaseline(h.store.db)?.note, 'good week', 'a healthy reference is not churned')
    assert.equal(snapshotCount(h), 1)
    assert.doesNotMatch(report, /UNHEALTHY/)
    assert.doesNotMatch(report, /auto-repaired/)

    const declined = repairUnhealthyBaseline(h.store.db, h.scope, h.deps.config, new Date('2026-09-10T00:00:00.000Z'))
    assert.equal(declined.replaced, false)
    assert.match(declined.skipped ?? '', /baseline is healthy/)
})

test('a subagent reading memory_stats cannot trigger the auto-repair', async (t) => {
    const h = await harness(t, { eval: { autoRepairUnhealthyBaseline: true, proposeFreezeAfterTasks: 3 } })
    freezeBadSnapshot(h)
    insertGoodWindow(h, 3)
    const subagent = { session: { id: 'm5-sub', header: { cwd: h.repo, origin: 'subagent' } } }

    const report = String(await statsTool(h.deps).execute({} as never, { agent: subagent } as never))
    assert.equal(latestBaseline(h.store.db)?.note, 'the bad freeze', 'a subagent must not rewrite the gate reference')
    assert.equal(snapshotCount(h), 1)
    assert.match(report, /the frozen baseline itself is UNHEALTHY/, 'the warning itself is read-only')
    assert.match(report, /a subagent session never writes memory/)

    // the same call from the top-level session repairs the very same snapshot
    const fixed = String(await statsTool(h.deps).execute({} as never, { agent: h.agent } as never))
    assert.match(fixed, /baseline auto-repaired/)
    assert.equal(snapshotCount(h), 1)
    assert.match(latestBaseline(h.store.db)?.note ?? '', /auto-repair: replaced an unhealthy baseline/)
})

test('a baseline with no metric data counts as unhealthy, not as unknown-but-fine', () => {
    // The judge behind the warning. A `null` on the reference side means the gate
    // cannot compare that metric at all, so "no success rate recorded" is not
    // evidence of a healthy reference — it is the absence of evidence.
    const config = resolveConfig({})
    const empty = assessBaselineHealth(
        { at: new Date().toISOString(), tasks: 2, successRate: null, avgDuration: null, avgDisturb: null, avgRework: null },
        config,
    )
    assert.equal(empty.healthy, false)
    assert.deepEqual(empty.failures, [
        'baseline success n/a (eval.autoFreezeMinSuccessRate 0.5)',
        'baseline rework n/a (eval.autoFreezeMaxRework 3)',
    ])
    assert.equal(empty.stale, false, 'a fresh snapshot is not stale, whatever its metrics say')

    // One failing side is enough — that is the live accident's shape (0.122 / 6.12).
    const badRate = assessBaselineHealth(
        { at: new Date().toISOString(), tasks: 9, successRate: 0.122, avgDuration: 90, avgDisturb: 2, avgRework: 1 },
        config,
    )
    assert.equal(badRate.healthy, false)
    assert.deepEqual(badRate.failures, ['baseline success 0.122 < eval.autoFreezeMinSuccessRate 0.5'])

    const healthy = assessBaselineHealth(
        { at: new Date().toISOString(), tasks: 9, successRate: 0.75, avgDuration: 90, avgDisturb: 2, avgRework: 2.25 },
        config,
    )
    assert.equal(healthy.healthy, true)
    assert.deepEqual(healthy.failures, [])
})

test('a stale snapshot is flagged as old without being called unhealthy', async (t) => {
    const h = await harness(t, { eval: { autoRepairUnhealthyBaseline: false, windowDays: 30, proposeFreezeAfterTasks: 5 } })
    insertTask(h.store.db, { id: 'good', date: '2026-01-01', outcome: 'success', duration: 60, disturb: 0, rework: 1 })
    freezeBaseline(
        h.store.db,
        'project:demo',
        'frozen long ago',
        new Date(Date.now() - 120 * 86_400_000 - 60_000),
    )

    const report = String(await statsTool(h.deps).execute({} as never, { agent: h.agent } as never))
    assert.match(report, /baseline snapshot is 120 day\(s\) old/, 'staleness gets its own line')
    assert.match(report, /3× eval\.windowDays 30/)
    assert.doesNotMatch(report, /UNHEALTHY/, 'old is not the same as bad')
})
