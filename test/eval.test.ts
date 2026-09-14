/**
 * Evaluation-gate tests (DESIGN §11 M5): baseline parsing, metric snapshots,
 * regression verdicts, memory health and the assembled `memory_stats` report.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import {
    evaluateGate,
    freezeBaseline,
    healthDigest,
    latestBaseline,
    parseBaseline,
    readBaseline,
    renderEvaluation,
    snapshotMetrics,
    windowSummary,
} from '../lib/eval/baseline.js'
import { clearRepoCache } from '../lib/paths.js'
import { ScopeResolver } from '../lib/scope/resolver.js'
import { loadSqliteModule } from '../lib/store/sqlite/db.js'
import { StoreRegistry } from '../lib/store/store.js'
import { statsTool } from '../lib/tools/stats.js'
import { fakeRepo, memoryFixture, useGlobalMemoryHome } from './helpers.ts'

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
    assert.equal(evaluateGate(base, undefined).verdict, 'no-baseline')
    assert.equal(evaluateGate(base, { ...base, tasks: 0 }).verdict, 'no-baseline')
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
    const frozen = String(await tool.execute({ setBaseline: true, note: 'good week' } as never, { agent: h.agent } as never))
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
