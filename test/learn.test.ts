/**
 * Learning-loop tests (DESIGN §7, §8): signal detection, redaction, the write
 * gate, confidence arithmetic, L1 episodes and bounded distillation.
 *
 * The LLM is faked with a realistic chunk stream, so the distillation path is
 * exercised end to end (prompt → stream → parse → gate → store → audit).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from '../lib/config.js'
import { recoverPendingDistillations, registerLearnHooks } from '../lib/hooks/learn.js'
import { materialize, upsertRecord } from '../lib/store/sqlite/records.js'
import { recall } from '../lib/recall/engine.js'
import { candidateConfidence, nextConfidence, statusFor } from '../lib/learn/confidence.js'
import { buildPrompt, dailyDistillTokens, distillAllowed, distillTurn, parseCandidates, resolveDistillRoute } from '../lib/learn/distill.js'
import { episodeDigest, pruneEpisodes, pruneSignals, recordEpisode, sessionsDir } from '../lib/learn/episodic.js'
import { loadGroupSignals, pendingDistillations } from '../lib/learn/pending.js'
import { buildLedgerRow, recordSessionMetric, sessionStats, withLearningCounters } from '../lib/learn/task-metrics.js'
import { applyDraft, gateDraft, jaccard, looksGeneric, mergeRecord, similarity, tokens } from '../lib/learn/gate.js'
import { TurnLedger } from '../lib/learn/ledger.js'
import { redact } from '../lib/learn/redact.js'
import { runDistillation } from '../lib/learn/distill-runner.js'
import { SignalBuffer, detectCorrection, detectResultFailure, looksLikeTestFailure, summarize } from '../lib/learn/signals.js'
import type { Signal } from '../lib/learn/signals.js'
import { clearRepoCache } from '../lib/paths.js'
import { SessionState } from '../lib/recall/session-state.js'
import { ScopeResolver } from '../lib/scope/resolver.js'
import { listEvidence, countRecords, getRecord } from '../lib/store/sqlite/records.js'
import { loadSqliteModule } from '../lib/store/sqlite/db.js'
import { StoreRegistry } from '../lib/store/store.js'
import type { ScopeStore } from '../lib/store/store.js'
import type { Evidence } from '../lib/store/types.js'
import { fakeRepo, lessonDoc, memoryFixture, useGlobalMemoryHome } from './helpers.ts'

const LESSON_JSON = JSON.stringify([
    {
        title: 'pnpm 无 TTY 安装中止',
        body: '触发场景：无 TTY 环境执行 pnpm install 报 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY。正确做法：用 CI=true pnpm install 重试。',
        confidence: 0.8,
        tags: ['pnpm', 'ci'],
    },
])

function fakeCtx(text: string, options: { delayMs?: number; throws?: boolean } = {}): Context {
    const stream = async function* (callOptions: { signal?: AbortSignal } = {}) {
        if (options.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
        // The harness normalizes cancellation into a terminal failure; mirror it.
        if (callOptions.signal?.aborted === true) throw new Error('aborted')
        if (options.throws === true) throw new Error('llm unavailable')
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
    }
    return { llm: { stream } } as unknown as Context
}

function evidence(kind: Evidence['kind'], detail = 'observed'): Evidence {
    return { kind, detail, at: new Date().toISOString() }
}

async function harness(t: { skip: (reason: string) => void }, config: Record<string, unknown> = {}) {
    clearRepoCache()
    const repo = fakeRepo('learn-repo')
    const globalHome = memoryFixture('learn-global', {})
    useGlobalMemoryHome(globalHome.root)
    const lessonsDir = path.join(repo, '.dsh', 'memory', 'lessons')
    fs.mkdirSync(lessonsDir, { recursive: true })
    fs.writeFileSync(
        path.join(lessonsDir, 'existing-lesson.md'),
        lessonDoc({ title: 'existing lesson', body: 'A concrete trigger: run the thing, then do the fix.', confidence: 0.9 }),
    )
    const resolved = resolveConfig(config)
    const registry = new StoreRegistry(resolved)
    const report = await registry.initialize(loadSqliteModule)
    if (!registry.available) {
        t.skip(`node:sqlite unavailable: ${report.probe.reason ?? 'unknown'}`)
        throw new Error('unreachable')
    }
    const resolver = new ScopeResolver(resolved)
    const agent = { options: { provider: 'test-provider', model: 'test-model' }, session: { id: 'sess-learn', header: { cwd: repo } } }
    const scope = resolver.resolve({ agent })
    const store = registry.open(scope)
    assert.ok(store)
    return { repo, resolved, registry, resolver, agent, scope, store: store as ScopeStore }
}

// ---- signals ----------------------------------------------------------------

test('detects correction markers and test failures', () => {
    assert.equal(detectCorrection('不对，我说的是另一个目录'), '我说的是')
    assert.equal(detectCorrection('please redo this'), 'redo')
    assert.equal(detectCorrection('继续下一步'), undefined)
    assert.equal(looksLikeTestFailure('AssertionError: expected 1'), true)
    assert.equal(looksLikeTestFailure('all good'), false)
    assert.equal(summarize('a\n\n  b   c'), 'a b c')
})

test('signal buffer drains per turn, forgets sessions and caps size', () => {
    const buffer = new SignalBuffer(2, 3)
    const make = (sessionId: string, turn: number, kind: Signal['kind']): Signal => ({
        sessionId,
        turn,
        kind,
        at: new Date().toISOString(),
    })
    buffer.add(make('a', 1, 'tool-failure'))
    buffer.add(make('a', 1, 'request-error'))
    buffer.add(make('a', 2, 'user-correction'))
    assert.equal(buffer.peek('a', 1).length, 2)
    assert.equal(buffer.take('a', 1).signals.length, 2)
    assert.equal(buffer.peek('a', 1).length, 0, 'take must drain')
    assert.equal(buffer.peek('a', 2).length, 1)

    buffer.add(make('b', 1, 'tool-failure'))
    buffer.add(make('c', 1, 'tool-failure'))
    assert.ok(buffer.size <= 2, 'session cap holds')
    buffer.forget('c')
    assert.equal(buffer.count('c'), 0)
})

// ---- redaction --------------------------------------------------------------

test('redaction masks secrets and home paths, and truncates', () => {
    assert.equal(redact('key sk-abcdefghijklmnop ok'), 'key sk-*** ok')
    assert.match(redact('path /Users/zhangyong/work/x'), /~\/work\/x/)
    assert.equal(redact('Bearer abcdefghijklmno', 'redacted'), 'Bearer ***')
    assert.equal(redact('token=abcdefghijkl', 'redacted'), 'token: ***')
    assert.equal(redact('anything', 'none'), '')
    const long = redact('x'.repeat(500), 'full', 50)
    assert.equal(long.length, 51)
    assert.equal(redact('plain text', 'full'), 'plain text')
})

// ---- gate -------------------------------------------------------------------

test('gate rejects vague or empty drafts and creates real ones', async (t) => {
    const h = await harness(t)
    assert.equal(gateDraft(h.store.db, h.store.fts5, { title: 'ab', body: 'x'.repeat(30), confidence: 0.9, origin: 'user' }).action, 'reject')
    assert.equal(gateDraft(h.store.db, h.store.fts5, { title: 'short body', body: 'too short', confidence: 0.9, origin: 'user' }).action, 'reject')
    assert.equal(looksGeneric('要注意安全'), true)
    assert.equal(looksGeneric('触发场景：无 TTY 时 pnpm install 中止；正确做法：CI=true 重试。'), false)

    const created = applyDraft(h.store.db, h.scope, h.store.fts5, {
        title: 'CI 变量绕过无 TTY 限制',
        body: '触发场景：无 TTY 下 pnpm install 中止。正确做法：设置 CI=true 后重试安装命令。',
        confidence: 0.85,
        evidence: [evidence('tool-failure', 'pnpm install aborted')],
        origin: 'distilled',
    })
    assert.equal(created.action, 'create')
    // DESIGN §7: a model-distilled candidate is a hypothesis, not a fact — it
    // enters `pending` capped below the human threshold. Repetition promotes it.
    assert.equal(created.confidence, 0.6)
    assert.equal(getRecord(h.store.db, created.recordId)?.status, 'pending')
    assert.equal(countRecords(h.store.db).total, 2)
    assert.equal(getRecord(h.store.db, created.recordId)?.evidence.length, 1)

    // a human-authored draft of the same shape is still taken at face value
    const byHand = applyDraft(h.store.db, h.scope, h.store.fts5, {
        title: '人工确认的教训',
        body: '触发场景：无 TTY 下 pnpm install 中止。正确做法：设置 CI=true 后重试安装命令。',
        confidence: 0.85,
        evidence: [evidence('user-statement', '用户确认')],
        origin: 'user',
    })
    assert.equal(byHand.confidence, 0.85)
    assert.equal(getRecord(h.store.db, byHand.recordId)?.status, 'active')
})

test('gate merges near-duplicates instead of piling up variants', async (t) => {
    const h = await harness(t)
    const draft = {
        title: 'CI 变量绕过无 TTY 限制',
        body: '触发场景：无 TTY 下 pnpm install 中止。正确做法：设置 CI=true 后重试安装命令。',
        confidence: 0.8,
        evidence: [evidence('tool-failure', 'first')],
        origin: 'distilled',
    }
    const first = applyDraft(h.store.db, h.scope, h.store.fts5, draft)
    const second = applyDraft(h.store.db, h.scope, h.store.fts5, {
        ...draft,
        body: `${draft.body} 补充：也可以在 CI 配置里显式声明。`,
        evidence: [evidence('user-correction', 'second')],
    })
    assert.equal(second.action, 'merge')
    assert.equal(second.recordId, first.recordId)
    const merged = getRecord(h.store.db, first.recordId)
    assert.ok(merged)
    assert.equal(merged.timesSeen, 2)
    assert.ok(merged.confidence > 0.8, 'repetition raises confidence')
    assert.equal(countRecords(h.store.db).total, 2, 'no duplicate row')
    assert.equal(listEvidence(h.store.db, first.recordId).length, 2)
})

test('claims without evidence are capped and stored as pending', async (t) => {
    const h = await harness(t)
    const result = applyDraft(h.store.db, h.scope, h.store.fts5, {
        title: '可能是缓存导致的问题',
        body: '触发场景：偶发失败。正确做法：清理缓存后重试，具体原因待确认。',
        confidence: 0.9,
        origin: 'user',
    })
    assert.equal(result.action, 'create')
    assert.ok(result.confidence <= 0.55)
    assert.equal(result.record?.status, 'pending')
})

test('similarity helpers behave on CJK and ASCII text', () => {
    assert.ok(jaccard(tokens('pnpm install 无 TTY'), tokens('pnpm install 无 TTY 中止')) > 0.5)
    assert.equal(jaccard(tokens('abc'), tokens('')), 0)
    assert.ok(
        similarity(
            {
                title: 'CI 变量绕过无 TTY 限制',
                body: '触发场景：无 TTY 下 pnpm install 中止。正确做法：设置 CI=true 后重试安装命令。',
                confidence: 0.8,
                origin: 'distilled',
            },
            {
                id: 'x',
                layer: 'project',
                scopeKind: 'project',
                title: 'CI 变量绕过无 TTY 限制',
                body: '触发场景：无 TTY 下 pnpm install 中止。正确做法：设置 CI=true 后重试安装命令。',
                tags: [],
                confidence: 0.8,
                timesSeen: 1,
                timesRecalled: 0,
                successAfterRecall: 0,
                failAfterRecall: 0,
                status: 'active',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                evidence: [],
            },
        ) === 1,
    )
})

// ---- confidence -------------------------------------------------------------

test('confidence rises with repetition and falls after failed recalls', () => {
    const now = new Date('2026-09-14T00:00:00.000Z')
    const base = { base: 0.8, updatedAt: '2026-09-13T00:00:00.000Z', now }
    const once = nextConfidence({ ...base, timesSeen: 1, successAfterRecall: 0, failAfterRecall: 0 })
    const thrice = nextConfidence({ ...base, timesSeen: 3, successAfterRecall: 0, failAfterRecall: 0 })
    assert.ok(thrice > once)
    const failed = nextConfidence({ ...base, timesSeen: 3, successAfterRecall: 0, failAfterRecall: 3 })
    assert.ok(failed < thrice, 'failed recalls must lower confidence')
    const stale = nextConfidence({ base: 0.8, timesSeen: 1, successAfterRecall: 0, failAfterRecall: 0, updatedAt: '2024-01-01T00:00:00.000Z', now })
    assert.ok(stale < once, 'age decays confidence')
    assert.equal(statusFor(0.75), 'active')
    assert.equal(statusFor(0.5), 'pending')
    assert.ok(candidateConfidence(0.8, 3) <= 0.85)
    assert.ok(candidateConfidence(0.8, 3) > candidateConfidence(0.8, 0))
})

// ---- episodic ---------------------------------------------------------------

test('episodes persist redacted signals to jsonl and to the signals table', async (t) => {
    const h = await harness(t)
    const written = recordEpisode(h.store.db, h.scope, {
        sessionId: 'sess-learn',
        turn: 3,
        verdict: 'failure',
        signals: [
            { sessionId: 'sess-learn', kind: 'tool-failure', turn: 3, tool: 'bash', detail: 'sk-abcdefghijklmnop leaked', at: new Date().toISOString() },
            { sessionId: 'sess-learn', kind: 'user-correction', turn: 3, detail: '不对', at: new Date().toISOString() },
        ],
    })
    assert.equal(written, 2)
    const dir = sessionsDir(h.scope)
    const files = fs.readdirSync(dir)
    assert.equal(files.length, 1)
    const lines = fs.readFileSync(path.join(dir, files[0] as string), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.doesNotMatch(lines[0] as string, /sk-abcdefghijklmnop/)
    const digest = episodeDigest(h.store.db)
    assert.equal(digest.signals, 2)
    assert.equal(digest.byKind['tool-failure'], 1)
    assert.equal(pruneEpisodes(h.scope, 90), 0, 'fresh episodes survive')
    assert.equal(pruneEpisodes(h.scope, 1, new Date(Date.now() + 10 * 86_400_000)), 1)
})

// ---- distillation -----------------------------------------------------------

test('parseCandidates tolerates prose and fenced output', () => {
    assert.equal(parseCandidates('no json here').length, 0)
    assert.equal(parseCandidates('```json\n[{"title":"t","body":"b"}]\n```').length, 1)
    assert.equal(parseCandidates('[{"title":"t","body":"b","confidence":2,"tags":["a","b"]}]')[0]?.confidence, 0.85)
    assert.equal(parseCandidates('[{"title":"","body":"b"}]').length, 0)
    assert.equal(parseCandidates(JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ title: `t${i}`, body: 'b'.repeat(20) })))).length, 3)
})

test('distillation guards block disabled, subagent and over-budget calls', async (t) => {
    const h = await harness(t, { learn: { autoDistill: false } })
    const signals: Signal[] = [{ sessionId: 's', kind: 'tool-failure', turn: 1, at: new Date().toISOString() }]
    const base = { ctx: fakeCtx(LESSON_JSON), config: h.resolved, registry: h.registry, resolver: h.resolver, state: new SessionState() }
    assert.equal(distillAllowed(base, { agent: h.agent, sessionId: 's', turn: 1, signals, recalled: [] }).allowed, false)

    const enabled = { ...base, config: resolveConfig({}) }
    assert.equal(distillAllowed(enabled, { agent: h.agent, sessionId: 's', turn: 1, signals, recalled: [] }).allowed, true)
    assert.equal(distillAllowed(enabled, { agent: h.agent, sessionId: 's', turn: 1, signals: [], recalled: [] }).allowed, false)
    assert.equal(
        distillAllowed(enabled, {
            agent: { session: { header: { cwd: h.repo, origin: 'subagent' } } },
            sessionId: 's',
            turn: 1,
            signals,
            recalled: [],
        }).allowed,
        false,
    )

    const state = new SessionState()
    state.chargeDistill('s', 1)
    state.chargeDistill('s', 1)
    state.chargeDistill('s', 1)
    assert.equal(distillAllowed({ ...enabled, state }, { agent: h.agent, sessionId: 's', turn: 1, signals, recalled: [] }).allowed, false)
    assert.equal(dailyDistillTokens(h.store.db), 0)
})

test('a painful turn distils a gated record and audits the call', async (t) => {
    const h = await harness(t)
    const state = new SessionState()
    const signals: Signal[] = [
        { sessionId: 'sess-learn', kind: 'tool-failure', turn: 1, tool: 'bash', detail: 'ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY', at: new Date().toISOString() },
    ]
    const outcome = await distillTurn(
        { ctx: fakeCtx(LESSON_JSON), config: h.resolved, registry: h.registry, resolver: h.resolver, state },
        { agent: h.agent, sessionId: 'sess-learn', turn: 1, signals, recalled: ['existing-lesson'] },
    )
    assert.equal(outcome.status, 'created')
    assert.equal(outcome.created, 1)
    const record = getRecord(h.store.db, outcome.recordIds[0] as string)
    assert.ok(record)
    assert.equal(record.origin, 'distilled')
    assert.equal(record.evidence.length, 1)
    assert.ok(record.status === 'pending' || record.confidence <= 0.85)

    const audit = h.store.db.prepare('SELECT * FROM distill').all()
    assert.equal(audit.length, 1)
    assert.equal(audit[0]?.['timed_out'], 0)
    assert.ok(Number(audit[0]?.['tokens_in'] ?? 0) > 0)
    assert.ok(dailyDistillTokens(h.store.db) > 0)

    flush: {
        // the text view must follow the store
        const files = fs.readdirSync(path.join(h.scope.root, 'lessons'))
        assert.ok(files.some((name) => name.includes('pnpm')))
    }
})

test('a slow or broken model yields no records and no crash', async (t) => {
    const h = await harness(t, { learn: { distillTimeoutMs: 500 } })
    const state = new SessionState()
    const signals: Signal[] = [{ sessionId: 's', kind: 'tool-failure', turn: 1, at: new Date().toISOString() }]

    const timedOut = await distillTurn(
        { ctx: fakeCtx(LESSON_JSON, { delayMs: 900 }), config: h.resolved, registry: h.registry, resolver: h.resolver, state },
        { agent: h.agent, sessionId: 's', turn: 1, signals, recalled: [] },
    )
    assert.equal(timedOut.status, 'timeout')
    assert.equal(timedOut.created, 0)

    const broken = await distillTurn(
        { ctx: fakeCtx('', { throws: true }), config: h.resolved, registry: h.registry, resolver: h.resolver, state },
        { agent: h.agent, sessionId: 's', turn: 2, signals, recalled: [] },
    )
    assert.equal(broken.status, 'error')
    assert.equal(countRecords(h.store.db).total, 1, 'only the pre-existing lesson remains')
})

test('the distillation prompt is redacted and bounded', () => {
    const signals: Signal[] = [
        { sessionId: 's', kind: 'tool-failure', turn: 1, tool: 'bash', detail: `sk-abcdefghijklmnop ${'x'.repeat(400)}`, at: new Date().toISOString() },
    ]
    const prompt = buildPrompt({ sessionId: 's', turn: 1, signals, recalled: ['a'] })
    assert.doesNotMatch(prompt, /sk-abcdefghijklmnop/)
    assert.match(prompt, /本轮自动召回的记忆: a/)
    assert.ok(prompt.length < 1_200)
})

// ---- turn-end wiring --------------------------------------------------------

test('a failing tool then turn end records an episode and learns from it', async (t) => {
    const h = await harness(t)
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ctx = {
        ...(fakeCtx(LESSON_JSON) as unknown as Record<string, unknown>),
        on: (event: string, handler: (...args: unknown[]) => unknown) => {
            handlers.set(event, handler)
        },
    }
    const state = new SessionState()
    const signals = new SignalBuffer()
    const ledger = new TurnLedger()
    registerLearnHooks(ctx as never, {
        ctx: fakeCtx(LESSON_JSON),
        config: h.resolved,
        registry: h.registry,
        resolver: h.resolver,
        state,
        signals,
        ledger,
    })

    state.observeTurn('sess-learn', 1)
    handlers.get('tools/result')?.({ name: 'bash', agent: h.agent }, { isError: true, content: [{ type: 'text', text: 'ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY' }] })
    assert.equal(signals.count('sess-learn'), 1)

    await handlers.get('agent/turn-stopping')?.({ agent: h.agent, turn: 1 })

    const rows = h.store.db.prepare('SELECT kind, tool FROM signals').all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.['tool'], 'bash')
    assert.ok(fs.readdirSync(sessionsDir(h.scope)).length >= 1, 'episode file written')
    const distilled = getRecord(h.store.db, 'pnpm-无-tty-安装中止') ?? h.store.db.prepare("SELECT id FROM records WHERE origin = 'distilled'").get()
    assert.ok(distilled, 'a distilled record exists')
})

test('a quiet productive turn attributes success to recalled memory', async (t) => {
    const h = await harness(t)
    // pretend the turn recalled a record
    h.store.db.prepare('INSERT INTO usage (record_id, session_id, turn, step, score, injected_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        'existing-lesson',
        'sess-learn',
        1,
        1,
        0.9,
        new Date().toISOString(),
    )
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ctx = {
        on: (event: string, handler: (...args: unknown[]) => unknown) => {
            handlers.set(event, handler)
        },
    }
    const state = new SessionState()
    const signals = new SignalBuffer()
    const ledger = new TurnLedger()
    registerLearnHooks(ctx as never, {
        ctx: fakeCtx('[]'),
        config: h.resolved,
        registry: h.registry,
        resolver: h.resolver,
        state,
        signals,
        ledger,
    })
    state.observeTurn('sess-learn', 1)
    ledger.noteRecalled('sess-learn', 1, 1)
    handlers.get('tools/result')?.({ name: 'read', agent: h.agent }, { isError: false, content: [] })

    await handlers.get('agent/turn-stopping')?.({ agent: h.agent, turn: 1 })

    const usage = h.store.db.prepare('SELECT outcome FROM usage WHERE session_id = ?').all('sess-learn')
    assert.equal(usage[0]?.['outcome'], 'success')
    const record = getRecord(h.store.db, 'existing-lesson')
    assert.equal(record?.successAfterRecall, 1)
    assert.equal(signals.count('sess-learn'), 0)
})

// ---- distillation runners ---------------------------------------------------

test('the jobs runner hands work to ctx.jobs and the inline runner stays bounded', async (t) => {
    const h = await harness(t)
    const signals: Signal[] = [
        { sessionId: 'sess-learn', kind: 'tool-failure', turn: 1, tool: 'bash', detail: 'ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY', at: new Date().toISOString() },
    ]
    const started: { kind: string; label: string; owner?: unknown }[] = []
    const jobsStub = {
        start(spec: { kind: string; label: string; owner?: unknown; run: () => { done: Promise<unknown> } }) {
            started.push({ kind: spec.kind, label: spec.label, ...(spec.owner !== undefined ? { owner: spec.owner } : {}) })
            const hooks = spec.run()
            void hooks.done
            return 'memory-distill-1'
        },
    }
    const ctxWithJobs = { llm: { stream: (fakeCtx(LESSON_JSON) as unknown as { llm: { stream: unknown } }).llm.stream }, reflect: { get: (name: string) => (name === 'jobs' ? jobsStub : undefined) } } as unknown as Context

    const jobResult = await runDistillation(
        { ctx: ctxWithJobs, config: resolveConfig({ learn: { distillRunner: 'jobs' } }), registry: h.registry, resolver: h.resolver, state: new SessionState() },
        { agent: h.agent, sessionId: 'sess-learn', turn: 1, signals, recalled: [], ownerAgent: h.agent },
    )
    assert.equal(jobResult.mode, 'jobs')
    assert.equal(jobResult.jobId, 'memory-distill-1')
    assert.equal(started[0]?.kind, 'memory-distill')
    assert.match(started[0]?.label ?? '', /turn 1/)
    assert.equal(started[0]?.owner, h.agent, 'the job is fenced to its owning agent')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(getRecord(h.store.db, 'pnpm-tty'), 'the job actually distilled')

    // no jobs service → the inline path runs instead of silently dropping work
    const inline = await runDistillation(
        { ctx: fakeCtx(LESSON_JSON), config: resolveConfig({ learn: { distillRunner: 'jobs' } }), registry: h.registry, resolver: h.resolver, state: new SessionState() },
        { agent: h.agent, sessionId: 'sess-learn', turn: 2, signals, recalled: [] },
    )
    assert.equal(inline.mode, 'inline')
    assert.ok((inline.outcome?.created ?? 0) + (inline.outcome?.merged ?? 0) >= 0)

    // a throwing registry must not lose the turn's learning
    const brokenJobs = {
        start() {
            throw new Error('registry full')
        },
    }
    const brokenCtx = { llm: (fakeCtx(LESSON_JSON) as unknown as { llm: unknown }).llm, reflect: { get: () => brokenJobs } } as unknown as Context
    const fallback = await runDistillation(
        { ctx: brokenCtx, config: resolveConfig({ learn: { distillRunner: 'jobs' } }), registry: h.registry, resolver: h.resolver, state: new SessionState() },
        { agent: h.agent, sessionId: 'sess-learn', turn: 3, signals, recalled: [] },
    )
    assert.equal(fallback.mode, 'inline')
})

// ---- failure detection (found by live testing) ------------------------------

test('a command that exits non-zero is a pain signal even though the tool call succeeded', () => {
    // Regression guard from the live run: dsh-tool-bash marks only spawn
    // failures and aborts as isError, so `[exit code: N]` must be read from the
    // content or the most common failure mode is invisible.
    assert.deepEqual(detectResultFailure('boom\n[exit code: 3]', { isError: false }), {
        kind: 'tool-failure',
        detail: 'exit code 3: boom [exit code: 3]',
    })
    assert.equal(detectResultFailure('ok\n[exit code: 0]', { isError: false }), undefined)
    assert.equal(detectResultFailure('no match', { isError: false }), undefined)

    // exit 1 is usually benign in agent work (grep with no match, `diff --quiet`)
    assert.equal(detectResultFailure('nothing found\n[exit code: 1]', { isError: false }), undefined)
    assert.ok(detectResultFailure('nothing found\n[exit code: 1]', { isError: false, exitCodeMode: 'all' }))
    assert.equal(detectResultFailure('boom\n[exit code: 9]', { isError: false, exitCodeMode: 'off' }), undefined)

    // error output inside a successful call still counts
    const marker = detectResultFailure('cat: /nope: No such file or directory', { isError: false })
    assert.equal(marker?.kind, 'tool-failure')
    assert.match(marker?.detail ?? '', /error output/)

    // a real tool error keeps its own path, and failing checks are classified
    assert.equal(detectResultFailure('spawn ENOENT', { isError: true })?.kind, 'tool-failure')
    assert.equal(detectResultFailure('AssertionError: expected 1', { isError: true })?.kind, 'test-failure')
    assert.equal(detectResultFailure('all green', { isError: true })?.kind, 'tool-failure')
})

test('a repeated failure in one turn also records a rework signal', async (t) => {
    const h = await harness(t)
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ctx = {
        on: (event: string, handler: (...args: unknown[]) => unknown) => {
            handlers.set(event, handler)
        },
    }
    const state = new SessionState()
    const signals = new SignalBuffer()
    const ledger = new TurnLedger()
    registerLearnHooks(ctx as never, {
        ctx: fakeCtx('[]'),
        config: h.resolved,
        registry: h.registry,
        resolver: h.resolver,
        state,
        signals,
        ledger,
    })
    state.observeTurn('sess-learn', 1)
    const onResult = handlers.get('tools/result')
    onResult?.({ name: 'bash', agent: h.agent }, { isError: false, content: [{ type: 'text', text: '[exit code: 2]' }] })
    assert.equal(signals.count('sess-learn'), 1)
    onResult?.({ name: 'bash', agent: h.agent }, { isError: false, content: [{ type: 'text', text: '[exit code: 2]' }] })
    const kinds = signals.peek('sess-learn', 1).map((signal) => signal.kind)
    assert.deepEqual(kinds.filter((kind) => kind === 'tool-failure').length, 2)
    assert.equal(kinds.filter((kind) => kind === 'rework').length, 1, 'the second failure of one tool is a rework loop')

    // a healthy turn records no signal but still counts the tool call
    onResult?.({ name: 'read', agent: h.agent }, { isError: false, content: [{ type: 'text', text: 'contents' }] })
    assert.equal(signals.peek('sess-learn', 1).filter((signal) => signal.tool === 'read').length, 0)
    assert.equal(ledger.peek('sess-learn', 1).toolCalls, 3)
    assert.equal(ledger.peek('sess-learn', 1).toolErrors, 2)
})

test('distillation degrades to "llm service unavailable" instead of failing the turn', async (t) => {
    const h = await harness(t)
    const signals: Signal[] = [{ sessionId: 's', kind: 'tool-failure', turn: 1, at: new Date().toISOString() }]
    // A context that exposes neither reflect('llm') nor a direct property —
    // exactly what a composition without an LLM looks like to the plugin.
    const bareCtx = {} as unknown as Context
    const allowed = distillAllowed(
        { ctx: bareCtx, config: h.resolved, registry: h.registry, resolver: h.resolver, state: new SessionState() },
        { agent: h.agent, sessionId: 's', turn: 1, signals, recalled: [] },
    )
    assert.equal(allowed.allowed, false)
    assert.equal(allowed.reason, 'llm service unavailable')

    const outcome = await distillTurn(
        { ctx: bareCtx, config: h.resolved, registry: h.registry, resolver: h.resolver, state: new SessionState() },
        { agent: h.agent, sessionId: 's', turn: 1, signals, recalled: [] },
    )
    assert.equal(outcome.status, 'skipped')
    assert.equal(outcome.reason, 'llm service unavailable')

    // a throwing property read (cordis' "without inject" error) is contained too
    const hostile = Object.defineProperty({}, 'llm', {
        get() {
            throw new Error('cannot get property "llm" without inject')
        },
    }) as unknown as Context
    assert.equal(
        distillAllowed(
            { ctx: hostile, config: h.resolved, registry: h.registry, resolver: h.resolver, state: new SessionState() },
            { agent: h.agent, sessionId: 's', turn: 1, signals, recalled: [] },
        ).reason,
        'llm service unavailable',
    )
})

test('the distillation route is inherited from the session unless configured', async (t) => {
    const h = await harness(t)
    const signals: Signal[] = [{ sessionId: 's', kind: 'tool-failure', turn: 1, at: new Date().toISOString() }]

    // default: follow the session's own provider/model — no second config to keep in sync
    const inherited = resolveDistillRoute(h.resolved, h.agent)
    assert.deepEqual(inherited, { provider: 'test-provider', model: 'test-model' })

    // an explicit setting wins
    const explicit = resolveDistillRoute(
        resolveConfig({ learn: { distillModel: { provider: 'cheap', model: 'tiny' } } }),
        h.agent,
    )
    assert.deepEqual(explicit, { provider: 'cheap', model: 'tiny' })

    // no session route and no config → nothing to call, and the turn is untouched
    const routeless = resolveDistillRoute(resolveConfig({}), { session: { id: 's' } })
    assert.equal(routeless, undefined)
    const allowed = distillAllowed(
        { ctx: fakeCtx(LESSON_JSON), config: h.resolved, registry: h.registry, resolver: h.resolver, state: new SessionState() },
        { agent: { session: { id: 's' } }, sessionId: 's', turn: 1, signals, recalled: [] },
    )
    assert.equal(allowed.allowed, false)
    assert.equal(allowed.reason, 'no model route available')

    // and the end-to-end call reports which route it used
    const outcome = await distillTurn(
        { ctx: fakeCtx(LESSON_JSON), config: h.resolved, registry: h.registry, resolver: h.resolver, state: new SessionState() },
        { agent: h.agent, sessionId: 'sess-learn', turn: 1, signals, recalled: [] },
    )
    assert.notEqual(outcome.status, 'skipped')
    const audit = h.store.db.prepare('SELECT model FROM distill ORDER BY id DESC LIMIT 1').get()
    assert.equal(audit?.['model'], 'test-provider/test-model')
})

// ---- undistilled-signal recovery -------------------------------------------

test('signals without an audit row are pending; any attempt settles the group', async (t) => {
    const h = await harness(t)
    const at = new Date(Date.now() - 60_000).toISOString()
    const insert = h.store.db.prepare(
        'INSERT INTO signals (session_id, turn, step, kind, tool, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    insert.run('sess-a', 1, 1, 'tool-failure', 'bash', 'exit code 2', at)
    insert.run('sess-a', 1, 1, 'rework', 'bash', 'bash failed 2×', at)
    insert.run('sess-b', 5, 1, 'user-correction', null, '用户纠正', at)

    const pending = pendingDistillations(h.store.db)
    assert.deepEqual(pending.map((group) => `${group.sessionId}#${group.turn}(${group.signals})`), ['sess-a#1(2)', 'sess-b#5(1)'])
    // in-flight protection: a group younger than the guard window is left alone
    assert.equal(pendingDistillations(h.store.db, { minAgeSeconds: 120 }).length, 0)
    assert.equal(pendingDistillations(h.store.db, { minAgeSeconds: 5 }).length, 2)

    // a completed attempt (even a timed-out one) settles the group
    h.store.db
        .prepare('INSERT INTO distill (session_id, turn, model, prompt_hash, tokens_in, tokens_out, created_count, timed_out, at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run('sess-a', 1, 'p/m', 'h', 10, 0, 0, 1, at)
    assert.equal(pendingDistillations(h.store.db).filter((group) => group.sessionId === 'sess-a').length, 0)

    // old episodes are history, not work
    h.store.db.prepare('UPDATE signals SET at = ? WHERE session_id = ?').run('2020-01-01T00:00:00.000Z', 'sess-b')
    assert.equal(pendingDistillations(h.store.db, { maxAgeDays: 14 }).length, 0)

    const loaded = loadGroupSignals(h.store.db, { sessionId: 'sess-b', turn: 5, signals: 1, lastAt: at })
    assert.equal(loaded[0]?.kind, 'user-correction')
})

test('recovery distils signals a cancelled job left behind', async (t) => {
    const h = await harness(t)
    // Exactly the live one-shot shape: signals exist, no distill row (the job
    // was cancelled when its agent was disposed at turn end).
    h.store.db
        .prepare('INSERT INTO signals (session_id, turn, step, kind, tool, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(
            'sess-lost',
            1,
            1,
            'tool-failure',
            'bash',
            'ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY',
            new Date(Date.now() - 60_000).toISOString(),
        )
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM distill').get()?.['n'], 0)

    const recovered = await recoverPendingDistillations(
        { ctx: fakeCtx(LESSON_JSON), config: h.resolved, registry: h.registry, resolver: h.resolver, state: new SessionState(), signals: new SignalBuffer(), ledger: new TurnLedger() },
        h.agent,
    )
    assert.equal(recovered, 1)
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM distill').get()?.['n'], 1, 'the attempt is now audited')
    assert.ok(getRecord(h.store.db, 'pnpm-tty'), 'the lesson the cancelled job never wrote')
    // idempotent: nothing is left pending, so a second pass does nothing
    assert.equal(
        await recoverPendingDistillations(
            { ctx: fakeCtx(LESSON_JSON), config: h.resolved, registry: h.registry, resolver: h.resolver, state: new SessionState(), signals: new SignalBuffer(), ledger: new TurnLedger() },
            h.agent,
        ),
        0,
    )
})

test('recovery always runs inline, even when the configured runner is jobs', async (t) => {
    const h = await harness(t, { learn: { distillRunner: 'jobs' } })
    h.store.db
        .prepare('INSERT INTO signals (session_id, turn, step, kind, tool, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('sess-lost', 7, 1, 'tool-failure', 'bash', 'exit code 2', new Date(Date.now() - 60_000).toISOString())

    const started: string[] = []
    const jobsStub = {
        start(spec: { kind: string }) {
            started.push(spec.kind)
            return 'job-1'
        },
    }
    const ctxWithJobs = {
        llm: (fakeCtx(LESSON_JSON) as unknown as { llm: unknown }).llm,
        reflect: { get: (name: string) => (name === 'jobs' ? jobsStub : undefined) },
    } as unknown as Context

    const recovered = await recoverPendingDistillations(
        { ctx: ctxWithJobs, config: h.resolved, registry: h.registry, resolver: h.resolver, state: new SessionState(), signals: new SignalBuffer(), ledger: new TurnLedger() },
        h.agent,
    )
    assert.equal(recovered, 1, 'recovery must complete, not hand the group to another job')
    assert.deepEqual(started, [], 'no job may be started for recovery')
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM distill').get()?.['n'], 1)
})

test('recovery stops at its wall-clock budget', async (t) => {
    const h = await harness(t)
    h.store.db
        .prepare('INSERT INTO signals (session_id, turn, step, kind, tool, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('sess-slow', 3, 1, 'tool-failure', 'bash', 'exit code 2', new Date(Date.now() - 60_000).toISOString())
    const recovered = await recoverPendingDistillations(
        { ctx: fakeCtx(LESSON_JSON), config: h.resolved, registry: h.registry, resolver: h.resolver, state: new SessionState(), signals: new SignalBuffer(), ledger: new TurnLedger() },
        h.agent,
        { budgetMs: -1 },
    )
    assert.equal(recovered, 0, 'an exhausted budget must not start another group')
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM distill').get()?.['n'], 0)
})

test('episodic retention prunes files and signal rows, never dropping recent debt', async (t) => {
    const h = await harness(t)
    const old = new Date(Date.now() - 200 * 86_400_000)
    const recent = new Date(Date.now() - 60 * 86_400_000)
    const now = new Date()
    recordEpisode(h.store.db, h.scope, {
        sessionId: 'ancient',
        turn: 1,
        verdict: 'failure',
        signals: [{ sessionId: 'ancient', kind: 'tool-failure', turn: 1, detail: 'old', at: old.toISOString() }],
    }, old)
    recordEpisode(h.store.db, h.scope, {
        sessionId: 'recent',
        turn: 1,
        verdict: 'failure',
        signals: [{ sessionId: 'recent', kind: 'tool-failure', turn: 1, detail: 'new', at: recent.toISOString() }],
    }, recent)

    const files = pruneEpisodes(h.scope, 90, now)
    const rows = pruneSignals(h.store.db, 90, now)
    assert.equal(files, 1, 'the 200-day-old episode file is pruned')
    assert.equal(rows, 1, 'its signal row goes too')
    const remaining = h.store.db.prepare('SELECT session_id FROM signals').all()
    assert.deepEqual(remaining.map((row) => row['session_id']), ['recent'])

    // A debt is pruned only when it is past BOTH the retention window and the
    // 14-day recovery horizon: 17 days old goes, 12 days old stays.
    const insert = h.store.db.prepare(
        'INSERT INTO signals (session_id, turn, step, kind, tool, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    insert.run('debt-gone', 1, 1, 'tool-failure', 'bash', 'unrecovered', new Date(Date.now() - 17 * 86_400_000).toISOString())
    insert.run('debt-kept', 1, 1, 'tool-failure', 'bash', 'unrecovered', new Date(Date.now() - 12 * 86_400_000).toISOString())
    pruneSignals(h.store.db, 10, now)
    assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM signals WHERE session_id = 'debt-gone'").get()?.['n'], 0)
    assert.equal(
        h.store.db.prepare("SELECT COUNT(*) AS n FROM signals WHERE session_id = 'debt-kept'").get()?.['n'],
        1,
        'an undistilled debt inside the recovery horizon must survive pruning',
    )
})

test('the configured capture policy actually governs what episodes keep', async (t) => {
    const h = await harness(t)
    const at = new Date(Date.now() - 3_600_000).toISOString()
    const signal = {
        sessionId: 'sess-policy',
        kind: 'user-correction' as const,
        turn: 1,
        detail: '用户纠正：我说的是 /Users/zhangyong/secret 那个目录，token=abcdefghijk',
        at,
    }
    recordEpisode(h.store.db, h.scope, { sessionId: 'sess-policy', turn: 1, verdict: 'failure', signals: [signal], captureUserText: 'redacted' }, new Date())
    const redactedRow = h.store.db.prepare("SELECT detail FROM signals WHERE session_id = 'sess-policy'").get()
    assert.match(String(redactedRow?.['detail']), /~\/secret/, 'home path is masked')
    assert.doesNotMatch(String(redactedRow?.['detail']), /abcdefghijk/, 'secret is masked')

    recordEpisode(h.store.db, h.scope, { sessionId: 'sess-none', turn: 1, verdict: 'failure', signals: [{ ...signal, sessionId: 'sess-none' }], captureUserText: 'none' }, new Date())
    const bare = h.store.db.prepare("SELECT detail, kind FROM signals WHERE session_id = 'sess-none'").get()
    assert.equal(bare?.['detail'], null, "'none' keeps the signal but drops the text")
    assert.equal(bare?.['kind'], 'user-correction')
})

test('a session that did work leaves one ledger row', async (t) => {
    const h = await harness(t)
    const started = Date.now() - 12 * 60_000
    const stats = sessionStats(h.store.db, {
        sessionId: 'sess-ledger',
        startedAt: started,
        turns: 4,
        toolCalls: 9,
        signals: 0,
        rework: 0,
        corrections: 0,
    })
    assert.equal(stats.signals, 0)

    // no pain signals + real work → success
    const clean = withLearningCounters(h.store.db, buildLedgerRow(stats)!, 'sess-ledger')
    assert.equal(clean.outcome, 'success')
    assert.equal(clean.durationMin, 12)
    assert.match(clean.summary, /4 turn\(s\), 9 tool call\(s\)/)
    recordSessionMetric(h.store.db, h.scope, clean)
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.['n'], 1)
    assert.ok(fs.readFileSync(path.join(h.scope.root, 'metrics.jsonl'), 'utf8').includes(clean.taskId), 'jsonl view is written too')

    // pain signals in the session flip it to failed, and the audit supplies the learning counters
    const at = new Date(Date.now() - 60_000).toISOString()
    h.store.db.prepare('INSERT INTO signals (session_id, turn, step, kind, tool, detail, at) VALUES (?,?,?,?,?,?,?)').run('sess-bad', 1, 1, 'tool-failure', 'bash', 'x', at)
    h.store.db.prepare('INSERT INTO signals (session_id, turn, step, kind, tool, detail, at) VALUES (?,?,?,?,?,?,?)').run('sess-bad', 2, 1, 'rework', 'bash', 'x', at)
    h.store.db.prepare('INSERT INTO signals (session_id, turn, step, kind, tool, detail, at) VALUES (?,?,?,?,?,?,?)').run('sess-bad', 3, 1, 'user-correction', null, 'x', at)
    h.store.db.prepare('INSERT INTO distill (session_id, turn, model, prompt_hash, tokens_in, tokens_out, created_count, timed_out, at) VALUES (?,?,?,?,?,?,?,?,?)').run('sess-bad', 1, 'p/m', 'h', 100, 50, 2, 0, at)
    const bad = withLearningCounters(
        h.store.db,
        buildLedgerRow(sessionStats(h.store.db, { sessionId: 'sess-bad', turns: 3, toolCalls: 5, signals: 0, rework: 0, corrections: 0 }))!,
        'sess-bad',
    )
    assert.equal(bad.outcome, 'failed')
    assert.equal(bad.reworkRounds, 1)
    assert.equal(bad.disturbCount, 1)
    assert.equal(bad.lessons, 2)
    assert.equal(bad.tokens, 150)

    // a session that never ran a turn writes nothing
    assert.equal(buildLedgerRow({ sessionId: 'boot-only', turns: 0, toolCalls: 0, signals: 0, rework: 0, corrections: 0 }), undefined)
})

// ---- audit fixes ------------------------------------------------------------

test('content heuristics only govern command runners', () => {
    // A healthy `read` of a document that *mentions* an error string used to be
    // recorded as a failure: one wasted distillation call and a fabricated
    // lesson per document read.
    const doc = 'docs/DESIGN.md: 当出现 No such file or directory 时……'
    assert.equal(detectResultFailure(doc, { isError: false, tool: 'read' }), undefined)
    assert.equal(detectResultFailure('errno 2', { isError: false, tool: 'grep' }), undefined)
    assert.ok(detectResultFailure('boom\n[exit code: 3]', { isError: false, tool: 'bash' }))
    // a registry-level error counts for every tool
    assert.ok(detectResultFailure('read failed', { isError: true, tool: 'read' }))
})

test('merging takes the higher confidence and the newer body', async (t) => {
    const h = await harness(t)
    const existing = {
        ...materialize({ title: 'CI 变量', body: '旧：不要用 CI=true。', layer: 'project', scopeKind: 'project', repo: h.repo, confidence: 0.9 }),
        timesSeen: 4,
        failAfterRecall: 4,
    }
    const merged = mergeRecord(existing, {
        title: 'CI 变量',
        body: '新：应当用 CI=true 绕过无 TTY 限制。',
        confidence: 0.9,
        origin: 'user',
    })
    assert.ok(merged.confidence >= 0.9, `a merge must never lower confidence (got ${merged.confidence})`)
    assert.match(merged.body, /应当用 CI=true/, 'the newer correction is kept')
    assert.equal(merged.timesSeen, 5)
})

test('two lessons that slugify to the same id stay two lessons', async (t) => {
    const h = await harness(t)
    const before = countRecords(h.store.db).total
    const first = applyDraft(h.store.db, h.scope, h.store.fts5, {
        title: 'dsh: 记忆插件',
        body: '触发场景：A。正确做法：A 的做法说明。',
        confidence: 0.9,
        origin: 'user',
    })
    const second = applyDraft(h.store.db, h.scope, h.store.fts5, {
        title: 'dsh: 权限模式',
        body: '触发场景：B。正确做法：B 的做法说明。',
        confidence: 0.9,
        origin: 'user',
    })
    assert.notEqual(second.recordId, first.recordId, 'the second lesson must not overwrite the first')
    assert.equal(countRecords(h.store.db).total, before + 2)
    assert.match(getRecord(h.store.db, first.recordId)?.body ?? '', /A 的做法/)
    assert.match(getRecord(h.store.db, second.recordId)?.body ?? '', /B 的做法/)
})

test('the configured distillation timeout is not silently clamped', () => {
    // The cap used to be 10s while the default was 15s, so anyone copying the
    // documented default into a profile got 10s.
    assert.equal(resolveConfig({ learn: { distillTimeoutMs: 15_000 } }).learn.distillTimeoutMs, 15_000)
    assert.equal(resolveConfig({ learn: { distillTimeoutMs: 60_000 } }).learn.distillTimeoutMs, 60_000)
    assert.equal(resolveConfig({ learn: { distillTimeoutMs: 999_999 } }).learn.distillTimeoutMs, 60_000)
})

test('already-injected records do not consume pack slots', async (t) => {
    const h = await harness(t)
    upsertRecord(
        h.store.db,
        materialize({
            title: 'second recall candidate',
            body: '触发场景：pnpm install 无 TTY 中止。正确做法：用 CI=true 重试。',
            layer: 'project',
            scopeKind: 'project',
            repo: h.repo,
            confidence: 0.9,
        }),
    )
    const injected: string[] = []
    const request = {
        agent: h.agent,
        terms: ['pnpm', 'install', 'tty', 'trigger'],
        text: 'pnpm install 无 TTY trigger',
        maxItems: 1,
        minScore: 0,
        exclude: (id: string) => injected.includes(id),
    }
    const first = await recall({ config: h.resolved, registry: h.registry, resolver: h.resolver }, request)
    assert.equal(first.hits.length, 1)
    injected.push(first.hits[0]!.record.id)

    // With the exclusion applied *after* picking, this second call returned an
    // empty pack even though other matches existed.
    const second = await recall({ config: h.resolved, registry: h.registry, resolver: h.resolver }, request)
    assert.equal(second.hits.length, 1, 'the next best record must still be injected')
    assert.notEqual(second.hits[0]!.record.id, injected[0])
})
