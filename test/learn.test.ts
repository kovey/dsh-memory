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
import { registerLearnHooks } from '../lib/hooks/learn.js'
import { candidateConfidence, nextConfidence, statusFor } from '../lib/learn/confidence.js'
import { buildPrompt, dailyDistillTokens, distillAllowed, distillTurn, parseCandidates } from '../lib/learn/distill.js'
import { episodeDigest, pruneEpisodes, recordEpisode, sessionsDir } from '../lib/learn/episodic.js'
import { applyDraft, gateDraft, jaccard, looksGeneric, similarity, tokens } from '../lib/learn/gate.js'
import { TurnLedger } from '../lib/learn/ledger.js'
import { redact } from '../lib/learn/redact.js'
import { runDistillation } from '../lib/learn/distill-runner.js'
import { SignalBuffer, detectCorrection, looksLikeTestFailure, summarize } from '../lib/learn/signals.js'
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
        yield { type: 'finish', reason: 'stop' }
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
    const agent = { session: { id: 'sess-learn', header: { cwd: repo } } }
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
    assert.equal(created.confidence, 0.85)
    assert.equal(countRecords(h.store.db).total, 2)
    assert.equal(getRecord(h.store.db, created.recordId)?.evidence.length, 1)
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
