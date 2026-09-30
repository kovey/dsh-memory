/**
 * Learning-loop tests (DESIGN §7, §8): signal detection, redaction, the write
 * gate, confidence arithmetic, L1 episodes and bounded distillation.
 *
 * The LLM is faked with a realistic chunk stream, so the distillation path is
 * exercised end to end (prompt → stream → parse → gate → store → audit).
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from '../dist/config.js'
import { setLogFile } from '../dist/log.js'
import { acquireCommitLock, AutoCommitter, LOCK_FILE_NAME, releaseCommitLock, STALE_LOCK_MS, touchCommitLock } from '../dist/sync/autocommit.js'
import type { CommitLock, CommitOutcome } from '../dist/sync/autocommit.js'
import { recoverPendingDistillations, registerLearnHooks } from '../dist/hooks/learn.js'
import { createHookDeps, registerHooks } from '../dist/hooks/index.js'
import { materialize, upsertRecord } from '../dist/store/sqlite/records.js'
import { recall } from '../dist/recall/engine.js'
import { candidateConfidence, nextConfidence, statusFor } from '../dist/learn/confidence.js'
import { buildPrompt, dailyDistillTokens, distillAllowed, distillTurn, parseCandidates, resolveDistillRoute } from '../dist/learn/distill.js'
import { episodeDigest, pruneEpisodes, pruneSignals, recordEpisode, sessionsDir } from '../dist/learn/episodic.js'
import { loadGroupSignals, pendingDistillations, pendingMinAgeSeconds } from '../dist/learn/pending.js'
import { buildLedgerRow, recordSessionMetric, sessionStats, withLearningCounters } from '../dist/learn/task-metrics.js'
import { applyDraft, gateDraft, jaccard, looksGeneric, mergeRecord, similarity, tokens } from '../dist/learn/gate.js'
import { TurnLedger } from '../dist/learn/ledger.js'
import { redact } from '../dist/learn/redact.js'
import { distillInFlightTtlMs, isDistilling, runDistillation } from '../dist/learn/distill-runner.js'
import { SignalBuffer, detectCorrection, detectResultFailure, looksLikeTestFailure, summarize } from '../dist/learn/signals.js'
import type { Signal } from '../dist/learn/signals.js'
import { clearRepoCache } from '../dist/paths.js'
import { recordRecalls } from '../dist/recall/usage.js'
import { SessionState } from '../dist/recall/session-state.js'
import { ScopeResolver } from '../dist/scope/resolver.js'
import { listEvidence, countRecords, getRecord, listRecords } from '../dist/store/sqlite/records.js'
import { loadSqliteModule } from '../dist/store/sqlite/db.js'
import { StoreRegistry } from '../dist/store/store.js'
import type { ScopeStore } from '../dist/store/store.js'
import type { Evidence } from '../dist/store/types.js'
import { fakeRepo, lessonDoc, memoryFixture, repoRoot, tempDir, useGlobalMemoryHome } from './helpers.ts'

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

test('redaction covers cloud keys, auth headers and connection strings', () => {
    // AWS access key id: the recognizable prefix stays readable, the id goes
    assert.equal(redact('aws AKIAIOSFODNN7EXAMPLE done'), 'aws AKIA*** done')
    assert.equal(redact('temporary ASIAIOSFODNN7EXAMPLE'), 'temporary ASIA***')
    // `x-api-key:` in any case, and the `=` form some tools print
    assert.equal(redact('X-Api-Key: 9f8e7d6c5b4a3210'), 'X-Api-Key: ***')
    assert.equal(redact('x-api-key=9f8e7d6c5b4a3210'), 'x-api-key: ***')
    // `Authorization: Basic <base64>`
    assert.equal(redact('Authorization: Basic dXNlcjpwYXNzd29yZA=='), 'Authorization: Basic ***')
    // provider tokens
    assert.equal(redact('glpat-abcdefghijklmnopqrst'), 'glpat-***')
    assert.equal(redact('npm_1a2b3c4d5e6f7g8h9i0j'), 'npm_***')
    assert.equal(redact('AIzaSyA1234567890abcdefghijklmnopqrs'), 'AIza***')
    // connection strings keep scheme/user/host and lose the password
    assert.equal(redact('postgres://user:s3cr3t@db.internal:5432/app'), 'postgres://user:***@db.internal:5432/app')
    assert.equal(redact('redis://:hunter2@cache:6379'), 'redis://:***@cache:6379')
    // set-cookie: the whole cookie goes, the rest of the collapsed line survives
    assert.equal(redact('set-cookie: session=abc123; Path=/; HttpOnly'), 'set-cookie: ***')
    assert.equal(
        redact('HTTP/1.1 200 OK set-cookie: sid=abc123; Path=/; HttpOnly content-type: text/html'),
        'HTTP/1.1 200 OK set-cookie: *** content-type: text/html',
    )
})

test('redaction leaves ordinary words, paths and header names alone', () => {
    // `Basic` is an English word and a plausible file name
    assert.equal(redact('Basic auth is described in src/auth/basic.ts'), 'Basic auth is described in src/auth/basic.ts')
    assert.equal(redact('authorization: bearer-less token flow'), 'authorization: bearer-less token flow')
    // a header *name* without a value is not a credential
    assert.equal(redact('the set-cookie header was missing'), 'the set-cookie header was missing')
    assert.equal(redact('x-api-key is a request header name'), 'x-api-key is a request header name')
    // a passwordless connection string is just a URL
    assert.equal(redact('redis://cache:6379/0 needs no password'), 'redis://cache:6379/0 needs no password')
    // prefixes that are not followed by a token body
    assert.equal(redact('npm_install_all runs the scripts'), 'npm_install_all runs the scripts')
    assert.equal(redact('the glpat- prefix is reserved for GitLab'), 'the glpat- prefix is reserved for GitLab')
    assert.equal(redact('ASIA-Pacific is a region name'), 'ASIA-Pacific is a region name')
    assert.equal(redact('AIza is not a word'), 'AIza is not a word')
})

// A format nobody enumerated yet must not reach L1 episodes, the distillation
// prompt or the git-tracked text view unmasked — a commit makes it permanent.
test('redaction masks JWTs whole, whatever their segment shape', () => {
    const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    assert.equal(redact(`auth ${jwt} ok`), 'auth [redacted:jwt] ok')
    assert.doesNotMatch(redact(`auth ${jwt} ok`), /eyJ/, 'no segment survives')
    // base64url body charset (including `-`/`_`) and long segments still match
    assert.equal(redact(`t ${jwt.replace('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', 'a'.repeat(70))}`), 't [redacted:jwt]')

    // negative: a two-segment `eyJ…` value is not a JWT (≥2 dots required)
    assert.equal(
        redact('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'),
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    )
    // negative: below the 60-char floor the older prefix rule stays the fallback
    assert.equal(redact('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig1234567890'), 'jwt.***')
    // negative: `eyJ…` inside an ordinary word (no word boundary) is not a token
    assert.equal(redact('the word eyJobs is not a token'), 'the word eyJobs is not a token')
})

// "Rather miss than over-mask" (§7/D5): the point of the rule is to catch what
// the prefix list never saw, not to redact every long string.
test('the high-entropy rule spares SHAs, identifiers and prose', () => {
    const token = 'AbCdEf12GhIjKl34MnOpQr56StUvWx78YzAbCd90EfGhIj12KlMnOp'
    assert.equal(token.length, 54)
    assert.equal(redact(`sess ${token} ok`), 'sess [redacted:high-entropy] ok')

    // git SHA (7-40 hex) and any longer pure-hex digest are not credentials
    assert.equal(redact('commit 4f3a9c1b7e2d8f0a6c5b4d3e2f1a0b9c8d7e6f5a'), 'commit 4f3a9c1b7e2d8f0a6c5b4d3e2f1a0b9c8d7e6f5a')
    assert.equal(
        redact('digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'),
        'digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    )
    // 48+ lowercase chars read as a sentence-like run, not as a secret
    const sentence = 'thisisaverylonglowercaseenglishsentencewithoutanyspaces1'
    assert.equal(sentence.length, 56)
    assert.equal(redact(sentence), sentence)
    // one char below the floor: left alone (the floor is the cheap guard)
    const short = token.slice(0, 47)
    assert.equal(redact(`sess ${short} ok`), `sess ${short} ok`)
    // ordinary camelCase identifiers carry no digit and stay readable
    assert.equal(
        redact('getUserProfileFromTheDatabaseByAccountIdentifierX failed'),
        'getUserProfileFromTheDatabaseByAccountIdentifierX failed',
    )
    // the policy parameter still governs the heuristics: `none` discards the
    // text entirely, `full` is the operator's explicit "keep it as-is" switch
    assert.equal(redact(`sess ${token}`, 'none'), '')
    assert.equal(redact(`sess ${token}`, 'full'), `sess ${token}`)
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
    // A timeout and an answered-but-failed call are attempts too: each settles
    // its group with exactly one zero-created audit row.
    const audit = h.store.db.prepare('SELECT session_id, created_count, timed_out FROM distill ORDER BY id').all()
    assert.deepEqual(
        audit.map((row) => [row['session_id'], row['created_count'], row['timed_out']]),
        [['s', 0, 1], ['s', 0, 0]],
    )
})

test('a gate-denied skip writes no audit row, an attempt always settles the group', async (t) => {
    const h = await harness(t)
    const at = new Date(Date.now() - 60_000).toISOString()
    h.store.db
        .prepare('INSERT INTO signals (session_id, turn, step, kind, tool, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('sess-debt', 3, 1, 'tool-failure', 'bash', 'ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY', at)
    const signals = loadGroupSignals(h.store.db, { sessionId: 'sess-debt', turn: 3, signals: 1, lastAt: at })
    const auditRows = (): number => Number(h.store.db.prepare('SELECT COUNT(*) AS n FROM distill').get()?.['n'] ?? -1)
    const deps = (config: ReturnType<typeof resolveConfig>) => ({
        ctx: fakeCtx(LESSON_JSON),
        config,
        registry: h.registry,
        resolver: h.resolver,
        state: new SessionState(),
    })

    // The daily budget refuses the spend. Nothing was attempted, so nothing may
    // be audited: `pending.ts` reads "no audit row" as "still owed", and this
    // group must stay recoverable by a later turn instead of being settled empty.
    const refused = await distillTurn(deps(resolveConfig({ learn: { maxDistillTokensPerDay: 0 } })), {
        agent: h.agent,
        sessionId: 'sess-debt',
        turn: 3,
        signals,
        recalled: [],
    })
    assert.equal(refused.status, 'skipped')
    assert.equal(refused.reason, 'daily token budget exhausted')
    assert.equal(auditRows(), 0)
    assert.deepEqual(
        pendingDistillations(h.store.db).map((group) => `${group.sessionId}#${group.turn}`),
        ['sess-debt#3'],
    )

    // The same group, once it is really attempted, is settled by its audit row —
    // exactly once, however many recovery passes look at it afterwards.
    const outcome = await distillTurn(deps(h.resolved), { agent: h.agent, sessionId: 'sess-debt', turn: 3, signals, recalled: [] })
    assert.equal(outcome.status, 'created')
    assert.equal(auditRows(), 1)
    assert.equal(pendingDistillations(h.store.db).length, 0, 'a settled group is never distilled again')
})

test('a write failure after the model call still settles the attempt', async (t) => {
    const h = await harness(t)
    const signals: Signal[] = [
        { sessionId: 'sess-write-fail', kind: 'tool-failure', turn: 5, tool: 'bash', detail: 'ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY', at: new Date().toISOString() },
    ]
    // A record write that blows up is what a full disk / sandbox denial looks
    // like here. Before this fix the throw escaped with no audit row, so the
    // very next recovery pass distilled (and paid for) the same signals again.
    const failingDb = new Proxy(h.store.db, {
        get(target, property, receiver) {
            if (property === 'prepare') {
                return (sql: string) => {
                    if (sql.includes('INSERT INTO records')) throw new Error('database or disk is full')
                    return target.prepare(sql)
                }
            }
            const value = Reflect.get(target, property, receiver)
            return typeof value === 'function' ? value.bind(target) : value
        },
    }) as typeof h.store.db
    const registry = {
        open: () => ({ ...h.store, db: failingDb }),
        exportScope: () => undefined,
        listOpen: () => [h.store],
    } as unknown as StoreRegistry

    const outcome = await distillTurn(
        { ctx: fakeCtx(LESSON_JSON), config: h.resolved, registry, resolver: h.resolver, state: new SessionState() },
        { agent: h.agent, sessionId: 'sess-write-fail', turn: 5, signals, recalled: [] },
    )
    assert.equal(outcome.status, 'error')
    assert.match(outcome.reason ?? '', /disk is full/)
    const audit = h.store.db.prepare('SELECT created_count, timed_out FROM distill WHERE session_id = ?').all('sess-write-fail')
    assert.equal(audit.length, 1, 'the failed attempt is still audited')
    assert.equal(audit[0]?.['created_count'], 0)
    assert.equal(audit[0]?.['timed_out'], 0)
    assert.equal(pendingDistillations(h.store.db).length, 0, 'the group is settled, not retried forever')
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

test('recovery ignores a group a live job in this process is already distilling', async (t) => {
    const h = await harness(t)
    const at = new Date(Date.now() - 60_000).toISOString()
    h.store.db
        .prepare('INSERT INTO signals (session_id, turn, step, kind, tool, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('sess-inflight', 4, 1, 'tool-failure', 'bash', 'ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY', at)
    const signals = loadGroupSignals(h.store.db, { sessionId: 'sess-inflight', turn: 4, signals: 1, lastAt: at })
    const auditRows = (): number => Number(h.store.db.prepare('SELECT COUNT(*) AS n FROM distill').get()?.['n'] ?? -1)
    const config = resolveConfig({ learn: { distillRunner: 'jobs' } })

    // The job owns the group and its LLM call is still running: for a 15s call
    // the group looks unattempted to `pendingDistillations` the whole time.
    let done: Promise<unknown> | undefined
    const jobsStub = {
        start(spec: { run: () => { done: Promise<unknown> } }) {
            done = spec.run().done
            return 'memory-distill-inflight'
        },
    }
    const slowCtx = {
        llm: (fakeCtx(LESSON_JSON, { delayMs: 400 }) as unknown as { llm: unknown }).llm,
        reflect: { get: (name: string) => (name === 'jobs' ? jobsStub : undefined) },
    } as unknown as Context
    const runner = await runDistillation(
        { ctx: slowCtx, config, registry: h.registry, resolver: h.resolver, state: new SessionState() },
        { agent: h.agent, sessionId: 'sess-inflight', turn: 4, signals, recalled: [], ownerAgent: h.agent },
    )
    assert.equal(runner.mode, 'jobs')
    assert.equal(isDistilling('sess-inflight', 4, distillInFlightTtlMs(config.learn.distillTimeoutMs)), true)

    // A quiet turn in the same process must not distil — or pay for — it again.
    assert.equal(
        await recoverPendingDistillations(
            {
                ctx: fakeCtx(LESSON_JSON),
                config,
                registry: h.registry,
                resolver: h.resolver,
                state: new SessionState(),
                signals: new SignalBuffer(),
                ledger: new TurnLedger(),
            },
            h.agent,
        ),
        0,
    )
    assert.equal(auditRows(), 0, 'no second attempt while the job is live')

    await done
    assert.equal(auditRows(), 1, 'the job writes the group\'s only audit row')
    assert.equal(isDistilling('sess-inflight', 4, 60_000), false, 'the mark is cleared when the attempt settles')
    assert.equal(pendingDistillations(h.store.db).length, 0)
    assert.ok(getRecord(h.store.db, 'pnpm-tty'), 'the lesson landed exactly once')
})

test('the recovery freshness guard covers a full distillation window', async (t) => {
    const h = await harness(t, { learn: { distillTimeoutMs: 15_000 } })
    h.store.db
        .prepare('INSERT INTO signals (session_id, turn, step, kind, tool, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('sess-young', 2, 1, 'tool-failure', 'bash', 'exit code 2', new Date(Date.now() - 8_000).toISOString())

    // Derived from `learn.distillTimeoutMs`, not the old fixed 5s window that a
    // 15s distillation call could outlive.
    assert.equal(pendingMinAgeSeconds(h.resolved.learn.distillTimeoutMs), 16)
    assert.equal(pendingDistillations(h.store.db, { distillTimeoutMs: h.resolved.learn.distillTimeoutMs }).length, 0)
    assert.equal(pendingDistillations(h.store.db, { minAgeSeconds: 5 }).length, 1, 'the old fixed guard would have taken it')

    const deps = () => ({
        ctx: fakeCtx(LESSON_JSON),
        config: h.resolved,
        registry: h.registry,
        resolver: h.resolver,
        state: new SessionState(),
        signals: new SignalBuffer(),
        ledger: new TurnLedger(),
    })
    assert.equal(await recoverPendingDistillations(deps(), h.agent), 0)
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM distill').get()?.['n'], 0)

    // Once the window has passed, the very same group is recovered.
    h.store.db.prepare('UPDATE signals SET at = ?').run(new Date(Date.now() - 60_000).toISOString())
    assert.equal(await recoverPendingDistillations(deps(), h.agent), 1)
})

test('a quiet turn that attempted nothing leaves recovery available for the next one', async (t) => {
    const h = await harness(t, { learn: { maxDistillTokensPerDay: 0 } })
    h.store.db
        .prepare('INSERT INTO signals (session_id, turn, step, kind, tool, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('sess-lost', 9, 1, 'tool-failure', 'bash', 'ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY', new Date(Date.now() - 60_000).toISOString())

    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ctx = {
        on: (event: string, handler: (...args: unknown[]) => unknown) => {
            handlers.set(event, handler)
        },
    }
    const state = new SessionState()
    registerLearnHooks(ctx as never, {
        ctx: fakeCtx(LESSON_JSON),
        config: h.resolved,
        registry: h.registry,
        resolver: h.resolver,
        state,
        signals: new SignalBuffer(),
        ledger: new TurnLedger(),
    })
    const quiet = { options: { provider: 'test-provider', model: 'test-model' }, session: { id: 'sess-quiet', header: { cwd: h.repo } } }
    const auditRows = (): number => Number(h.store.db.prepare('SELECT COUNT(*) AS n FROM distill').get()?.['n'] ?? -1)

    // Quiet turn 1: the daily budget refuses every attempt, so nothing was
    // recovered. Latched here, the one recovery slot this process gets would be
    // spent on nothing and the debt would never be picked up again.
    state.observeTurn('sess-quiet', 1)
    await handlers.get('agent/turn-stopping')?.({ agent: quiet, turn: 1 })
    assert.equal(auditRows(), 0)
    assert.equal(pendingDistillations(h.store.db).length, 1, 'the debt is untouched')

    // Budget frees up: the *next* quiet turn must be allowed to try again.
    h.resolved.learn.maxDistillTokensPerDay = 200_000
    state.observeTurn('sess-quiet', 2)
    await handlers.get('agent/turn-stopping')?.({ agent: quiet, turn: 2 })
    assert.equal(auditRows(), 1)
    assert.equal(pendingDistillations(h.store.db).length, 0)
    assert.ok(getRecord(h.store.db, 'pnpm-tty'), 'the cancelled job\'s lesson finally lands')
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

// ---- cross-process commit lock (DESIGN §5.3, D6) ----------------------------
//
// Two hosts (nvim-tui + web) export and commit the same memory root. These live
// here rather than in test/sync.test.ts because that file is owned by another
// workstream right now; the subject matter is the same.

function gitIn(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** A real repository: the lock exists to protect a real git commit. */
function commitRepo(label: string): string {
    const root = tempDir(label)
    gitIn(root, 'init', '--quiet', '-b', 'main')
    gitIn(root, 'config', 'user.email', 'test@example.com')
    gitIn(root, 'config', 'user.name', 'dsh-memory test')
    gitIn(root, 'config', 'commit.gpgsign', 'false')
    return root
}

function writeLesson(root: string, name: string, body: string): void {
    fs.mkdirSync(path.join(root, 'lessons'), { recursive: true })
    fs.writeFileSync(path.join(root, 'lessons', name), body)
}

function commitScope(root: string): { kind: 'global'; root: string; reason: 'no-project-context' } {
    return { kind: 'global', root, reason: 'no-project-context' }
}

/** Run `body` with the file logger pointed at a fresh file, then restore it. */
function withLogFile(label: string, body: (logFile: string) => void): void {
    const logFile = path.join(tempDir(label), 'memory.log')
    setLogFile(logFile)
    try {
        body(logFile)
    } finally {
        setLogFile(undefined)
    }
}

/**
 * A real second host: a child Node process that appends its own lesson through
 * an export hook and commits the shared root. It prints `{"phase":"started"}`
 * before entering `commitNow`, so the test can release a lock deterministically
 * instead of guessing at process startup time.
 */
const CHILD_COMMIT_SCRIPT = `
const root = process.env.DSH_TEST_ROOT
const lesson = process.env.DSH_TEST_LESSON
const { AutoCommitter } = await import(${JSON.stringify(path.join(repoRoot, 'dist/sync/autocommit.js'))})
const { resolveConfig } = await import(${JSON.stringify(path.join(repoRoot, 'dist/config.js'))})
const fs = await import('node:fs')
const path = await import('node:path')
console.log(JSON.stringify({ phase: 'started', pid: process.pid }))
const committer = new AutoCommitter(resolveConfig({ git: { autoCommit: 'immediate', lockTimeoutMs: 8000 } }), {
    exportText: () => {
        fs.mkdirSync(path.join(root, 'lessons'), { recursive: true })
        fs.writeFileSync(path.join(root, 'lessons', lesson), 'child lesson\\n')
    },
})
const at = Date.now()
const outcome = committer.commitNow({ kind: 'global', root, reason: 'no-project-context' }, 'child host')
console.log(JSON.stringify({ phase: 'done', committed: outcome.committed, skipped: outcome.skipped ?? null, waitedMs: Date.now() - at }))
`

interface ChildCommitRun {
    started: Promise<void>
    done: Promise<{ code: number | null; out: string }>
}

function spawnChildCommit(root: string, lesson: string): ChildCommitRun {
    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
        markStarted = resolve
    })
    const done = new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_COMMIT_SCRIPT], {
            env: { ...process.env, DSH_TEST_ROOT: root, DSH_TEST_LESSON: lesson },
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        let out = ''
        child.stdout.on('data', (chunk: Buffer) => {
            out += String(chunk)
            if (out.includes('"phase":"started"')) markStarted()
        })
        child.on('close', (code) => resolve({ code, out }))
    })
    return { started, done }
}

function childOutcome(out: string): { committed: boolean; skipped: string | null; waitedMs: number } {
    const line = out.split('\n').find((candidate) => candidate.includes('"phase":"done"'))
    assert.ok(line !== undefined, `child printed no outcome: ${out}`)
    return JSON.parse(line) as { committed: boolean; skipped: string | null; waitedMs: number }
}

test('two hosts committing one root both keep their content (in-process queue)', async () => {
    const root = commitRepo('m4-lock-race')
    const config = resolveConfig({ git: { autoCommit: 'immediate' } })
    const hostA = new AutoCommitter(config, { exportText: () => writeLesson(root, 'from-a.md', 'A\n') })
    const hostB = new AutoCommitter(config, { exportText: () => writeLesson(root, 'from-b.md', 'B\n') })

    const [first, second] = await Promise.all([
        hostA.commitAsync(commitScope(root), 'host a'),
        hostB.commitAsync(commitScope(root), 'host b'),
    ])
    assert.equal(first.committed, true, first.detail)
    assert.equal(second.committed, true, second.detail)
    assert.equal(gitIn(root, 'rev-list', '--count', 'HEAD').trim(), '2', 'one commit per host, none interleaved')
    const tracked = gitIn(root, 'ls-files')
    assert.match(tracked, /lessons\/from-a\.md/, 'host A content is in the history')
    assert.match(tracked, /lessons\/from-b\.md/, 'host B content is in the history')
    assert.doesNotMatch(tracked, /dsh-memory-commit\.lock/, 'the lock file is never versioned')
    assert.equal(gitIn(root, 'status', '--porcelain').trim(), '', 'no work left uncommitted')
    assert.equal(fs.existsSync(path.join(root, LOCK_FILE_NAME)), false, 'the lock is released')
})

// The real thing: two OS processes, one root, released lock in between. The
// in-process queue cannot help here — only the lock file can.
test('two OS processes racing on one root both commit, and neither hangs', async () => {
    const root = commitRepo('m4-lock-xproc')
    const held = acquireCommitLock(root, 0)
    assert.ok('file' in held, 'the parent process takes the lock first')
    // the lock lives in the memory root (never in `.git/`) and names its holder
    const lockFile = path.join(root, LOCK_FILE_NAME)
    assert.equal((held as CommitLock).file, lockFile)
    const raw = fs.readFileSync(lockFile, 'utf8')
    assert.match(raw, new RegExp(`"pid":${process.pid}`), 'pid is recorded')
    assert.match(raw, /"at":"\d{4}-\d{2}-\d{2}T[\d:.]+Z"/, 'timestamp is recorded')

    const a = spawnChildCommit(root, 'child-a.md')
    const b = spawnChildCommit(root, 'child-b.md')
    await Promise.all([a.started, b.started])
    // both children are inside `commitNow` now; keep the lock a moment longer so
    // the wait is real, then release it like a finishing host would
    await new Promise((resolve) => setTimeout(resolve, 200))
    releaseCommitLock(held as CommitLock)

    const [ra, rb] = await Promise.all([a.done, b.done])
    assert.equal(ra.code, 0, ra.out)
    assert.equal(rb.code, 0, rb.out)
    const [oa, ob] = [childOutcome(ra.out), childOutcome(rb.out)]
    assert.equal(oa.committed, true, ra.out)
    assert.equal(ob.committed, true, rb.out)
    assert.ok(Math.min(oa.waitedMs, ob.waitedMs) >= 100, `both children waited for the lock (${oa.waitedMs}/${ob.waitedMs}ms)`)

    const tracked = gitIn(root, 'ls-files')
    assert.match(tracked, /lessons\/child-a\.md/)
    assert.match(tracked, /lessons\/child-b\.md/)
    assert.equal(gitIn(root, 'status', '--porcelain').trim(), '', 'the interleaved export left nothing behind')
    assert.equal(fs.existsSync(path.join(root, LOCK_FILE_NAME)), false, 'the last child released the lock')
})

test('a lock held elsewhere skips the commit inside the timeout, naming the holder', () => {
    const root = commitRepo('m4-lock-busy')
    writeLesson(root, 'busy.md', 'busy\n')
    const lockFile = path.join(root, LOCK_FILE_NAME)
    fs.writeFileSync(
        lockFile,
        JSON.stringify({ pid: 999_999, host: 'other-host', at: '2026-01-01T00:00:00.000Z', token: 'foreign' }),
    )

    withLogFile('m4-lock-busy-log', (logFile) => {
        const committer = new AutoCommitter(resolveConfig({ git: { autoCommit: 'immediate', lockTimeoutMs: 250 } }))
        const started = Date.now()
        const outcome = committer.commitNow(commitScope(root), 'busy root')
        const elapsed = Date.now() - started

        assert.equal(outcome.committed, false)
        assert.equal(outcome.skipped, 'lock-timeout', 'a held lock is a skip, not a failure')
        assert.match(outcome.detail, /999999/, 'the skip names who holds the lock')
        assert.ok(elapsed >= 200, `the wait respects lockTimeoutMs (${elapsed}ms)`)
        assert.ok(elapsed < 5_000, `the wait is bounded, never a hang (${elapsed}ms)`)
        // someone else's lock is never released by us
        assert.equal(fs.existsSync(lockFile), true)
        assert.match(fs.readFileSync(lockFile, 'utf8'), /foreign/)

        const logged = fs.readFileSync(logFile, 'utf8')
        assert.match(logged, /\[info\][^\n]*commit lock[^\n]*held by pid 999999/, 'the skip is visible in the log')
        // nothing was committed while the lock was held
        assert.throws(() => gitIn(root, 'rev-parse', '--verify', 'HEAD'))
    })
})

test('a lock older than two minutes is preempted, not waited on', () => {
    const root = commitRepo('m4-lock-stale')
    writeLesson(root, 'stale.md', 'stale\n')
    const lockFile = path.join(root, LOCK_FILE_NAME)
    fs.writeFileSync(
        lockFile,
        JSON.stringify({ pid: 4242, host: 'crashed-host', at: '2026-01-01T00:00:00.000Z', token: 'dead' }),
    )
    const old = new Date(Date.now() - STALE_LOCK_MS - 60_000)
    fs.utimesSync(lockFile, old, old)

    withLogFile('m4-lock-stale-log', (logFile) => {
        // timeout 0: only the stale-preemption path can make this commit work
        const committer = new AutoCommitter(resolveConfig({ git: { autoCommit: 'immediate', lockTimeoutMs: 0 } }))
        const outcome = committer.commitNow(commitScope(root), 'stale root')
        assert.equal(outcome.committed, true, outcome.detail)

        const logged = fs.readFileSync(logFile, 'utf8')
        assert.match(logged, /\[warn\][^\n]*preempted a stale commit lock/, 'the takeover is a warning')
        assert.match(logged, /pid 4242/, 'the warning names the dead holder')
        assert.equal(fs.existsSync(lockFile), false, 'the fresh lock is released after the commit')
        assert.doesNotMatch(gitIn(root, 'ls-files'), /dsh-memory-commit\.lock/, 'a lock never enters the text view')
        assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.dsh-memory-commit\.lock$/m)
    })
})

test('a re-entrant commit in one process skips instead of deadlocking on its own lock', () => {
    const root = commitRepo('m4-lock-reentrant')
    writeLesson(root, 'outer.md', 'outer\n')
    let nested: CommitOutcome | undefined
    const committer = new AutoCommitter(resolveConfig({ git: { autoCommit: 'immediate' } }), {
        exportText: () => {
            nested = committer.commitNow(commitScope(root), 'nested')
        },
    })
    const outer = committer.commitNow(commitScope(root), 'outer')
    assert.equal(outer.committed, true, outer.detail)
    assert.equal(nested?.skipped, 'in-process')
    assert.equal(nested?.committed, false)
    assert.equal(fs.existsSync(path.join(root, LOCK_FILE_NAME)), false, 'the outer commit released the lock')
})

test('an exception inside the critical section still releases the lock', () => {
    const root = commitRepo('m4-lock-throw')
    writeLesson(root, 'after.md', 'after\n')
    withLogFile('m4-lock-throw-log', (logFile) => {
        const boom = new AutoCommitter(resolveConfig({ git: { autoCommit: 'immediate' } }), {
            exportText: () => {
                throw new Error('export exploded')
            },
        })
        const failed = boom.commitNow(commitScope(root), 'throwing export')
        assert.equal(failed.committed, false)
        assert.match(failed.detail, /export exploded/)
        assert.match(fs.readFileSync(logFile, 'utf8'), /commit failed/)
        assert.equal(fs.existsSync(path.join(root, LOCK_FILE_NAME)), false, 'finally must release the lock')

        const ok = new AutoCommitter(resolveConfig({ git: { autoCommit: 'immediate' } })).commitNow(
            commitScope(root),
            'after the failure',
        )
        assert.equal(ok.committed, true, ok.detail)
    })
})

// ---- cross-process lock: liveness, heartbeat, bounded wait --------------------

test('a lock whose holder is alive on this host is waited on, not preempted', () => {
    // mtime alone cannot tell "a slow holder" from "a dead holder": a section
    // that ran longer than STALE_LOCK_MS looked stale, was preempted, and *two*
    // processes were then inside the export+commit critical section at once.
    const root = commitRepo('m4-lock-live-holder')
    const held = acquireCommitLock(root, 0)
    assert.ok('file' in held, 'the parent takes the lock')
    const lockFile = (held as CommitLock).file
    const old = new Date(Date.now() - STALE_LOCK_MS - 60_000)
    fs.utimesSync(lockFile, old, old)

    const contender = acquireCommitLock(root, 0)
    assert.ok(!('file' in contender), 'this process is alive, so the lock must not be stolen')
    assert.equal((contender as { reason: string }).reason, 'lock-timeout')
    assert.match(fs.readFileSync(lockFile, 'utf8'), new RegExp(`"token":"${(held as CommitLock).token}"`), 'the live holder still owns it')
    releaseCommitLock(held as CommitLock)
    assert.equal(fs.existsSync(lockFile), false)
})

test('an old lock from a dead holder is still preempted (liveness did not break the escape hatch)', () => {
    const root = commitRepo('m4-lock-dead-holder')
    const lockFile = path.join(root, LOCK_FILE_NAME)
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 4242, host: 'crashed-host', at: '2026-01-01T00:00:00.000Z', token: 'dead' }))
    const old = new Date(Date.now() - STALE_LOCK_MS - 60_000)
    fs.utimesSync(lockFile, old, old)
    const taken = acquireCommitLock(root, 0)
    assert.ok('file' in taken, 'a foreign host with a stale mtime is still preempted')
    assert.equal((taken as CommitLock).preempted, true)
    releaseCommitLock(taken as CommitLock)
})

test('touchCommitLock refreshes a held lock so a slow section does not look stale', () => {
    // A phase boundary heartbeat: the section is synchronous, so the holder
    // refreshes its own lock instead of relying on a timer that cannot fire.
    const root = commitRepo('m4-lock-heartbeat')
    const file = path.join(root, LOCK_FILE_NAME)
    const lock: CommitLock = { root, file, token: 'mine', preempted: false }
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: 'other-host', at: '2026-01-01T00:00:00.000Z', token: 'mine' }))
    const old = new Date(Date.now() - STALE_LOCK_MS - 60_000)
    fs.utimesSync(file, old, old)

    // a foreign host cannot check liveness, so only the mtime decides here
    const before = acquireCommitLock(root, 0)
    assert.ok('file' in before, 'the stale-looking lock is preempted until it is refreshed')
    releaseCommitLock(before as CommitLock)

    // the owner's own lock, still stale-looking, is refreshed by the heartbeat
    fs.writeFileSync(file, JSON.stringify({ pid: 1, host: 'other-host', at: '2026-01-01T00:00:00.000Z', token: 'mine' }))
    fs.utimesSync(file, old, old)
    touchCommitLock(lock)
    assert.ok(Date.now() - fs.statSync(file).mtimeMs < 5_000, 'the heartbeat rewrote the mtime')
    const after = acquireCommitLock(root, 60)
    assert.equal((after as { reason?: string }).reason, 'lock-timeout', 'a refreshed lock is no longer stale')
})

test('the commit path heartbeats its own lock before it commits', () => {
    const root = commitRepo('m4-lock-heartbeat-commit')
    writeLesson(root, 'kept.md', 'kept\n')
    const lockFile = path.join(root, LOCK_FILE_NAME)
    const committer = new AutoCommitter(resolveConfig({ git: { autoCommit: 'immediate' } }), {
        exportText: () => {
            // A long export: by the time it returns, the lock looks stale. The
            // token is also handed to "another process" so the lock file survives
            // the finally-block release and the test can inspect its mtime.
            fs.writeFileSync(
                lockFile,
                JSON.stringify({ pid: 1, host: 'other-host', at: '2026-01-01T00:00:00.000Z', token: 'foreign' }),
            )
            const old = new Date(Date.now() - STALE_LOCK_MS - 60_000)
            fs.utimesSync(lockFile, old, old)
        },
    })
    const outcome = committer.commitNow(commitScope(root), 'slow section')
    assert.equal(outcome.committed, true, outcome.detail)
    assert.equal(fs.existsSync(lockFile), true, 'a lock that changed owner is not ours to release')
    assert.ok(
        Date.now() - fs.statSync(lockFile).mtimeMs < 5_000,
        'the commit refreshed the lock after the export instead of letting it look stale',
    )
})

test('an undefined lock timeout falls back to the default instead of spinning forever', async () => {
    // `acquireCommitLock(root, undefined)` never returned: `waited >= undefined`
    // is false forever, so the loop polls to the end of time (a config object
    // built without `git.lockTimeoutMs` is enough to reach it).
    const root = commitRepo('m4-lock-undefined-timeout')
    const lockFile = path.join(root, LOCK_FILE_NAME)
    // fresh mtime + a foreign host: neither staleness nor liveness can end this,
    // so only the deadline can.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, host: 'other-host', at: new Date().toISOString(), token: 'foreign' }))
    const script = `
const { acquireCommitLock } = await import(${JSON.stringify(path.join(repoRoot, 'dist/sync/autocommit.js'))})
const started = Date.now()
const result = acquireCommitLock(process.env.DSH_TEST_ROOT, undefined)
console.log(JSON.stringify({ reason: result.reason ?? null, waitedMs: Date.now() - started }))
`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, DSH_TEST_ROOT: root },
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
        out += String(chunk)
    })
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 25_000)
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    clearTimeout(killTimer)
    assert.equal(code, 0, `the child never returned (out=${out})`)
    const parsed = JSON.parse(out.trim()) as { reason: string | null; waitedMs: number }
    assert.equal(parsed.reason, 'lock-timeout', 'the fallback deadline fired')
    assert.ok(parsed.waitedMs >= 9_000, `it waited for the default timeout (${parsed.waitedMs}ms)`)
    assert.ok(parsed.waitedMs < 20_000, `and it is bounded (${parsed.waitedMs}ms)`)
}, { timeout: 40_000 })

test('the high-entropy sweep keeps long identifiers that carry word boundaries', () => {
    // A 48-char camelCase identifier has mixed case and a digit, so the shape
    // heuristic ate it even though it is obviously a name, not a secret.
    const identifier = 'parseISO8601DurationIntoMillisecondsWithTimezone'
    assert.equal(identifier.length, 48)
    assert.equal(redact(identifier, 'redacted', 400), identifier)
    assert.equal(
        redact(`call ${identifier} now`, 'redacted', 400),
        `call ${identifier} now`,
        'a sentence around it keeps its evidence',
    )
    // two lower→upper boundaries is the exemption; fewer than that is still opaque
    const opaque = `Xk9${'q'.repeat(44)}Z`
    assert.equal(opaque.length, 48)
    assert.equal(redact(opaque), '[redacted:high-entropy]', 'one boundary is not a name')
    // and the enumerated rules are untouched
    assert.equal(redact('sk-abcdefghijklmnop'), 'sk-***')
})

// ---- step-aware attribution through the real hook wiring ---------------------

type RegisteredHandlers = Map<string, ((...args: unknown[]) => unknown)[]>

/**
 * Real hooks (`registerHooks`) over a real registry/store.
 *
 * Every listener of an event is kept: `registerHooks` registers two
 * `agent/turn-stopping` handlers (learning and the git committer), and a map that
 * kept only the last one would silently skip the code under test.
 */
function wiredHooks(h: { resolved: ReturnType<typeof resolveConfig>; registry: StoreRegistry; resolver: ScopeResolver; agent: unknown }) {
    const handlers: RegisteredHandlers = new Map()
    const ctx = {
        ...(fakeCtx('[]') as unknown as Record<string, unknown>),
        on: (event: string, handler: (...args: unknown[]) => unknown) => {
            const list = handlers.get(event) ?? []
            list.push(handler)
            handlers.set(event, list)
        },
    }
    const deps = createHookDeps(h.resolved, h.registry, h.resolver, { save: true })
    const handle = registerHooks(ctx as never, deps)
    return { handlers, deps, handle }
}

/** Fire every listener of one event, as the host would. */
async function emitHooks(handlers: RegisteredHandlers, event: string, ...args: unknown[]): Promise<void> {
    const list = handlers.get(event)
    assert.ok(list !== undefined && list.length > 0, `no listener registered for ${event}`)
    for (const handler of list) await handler(...args)
}

/**
 * Drive the registered `agent/pre-step` listeners for one step of a turn, exactly
 * as the agent loop would: `next()` returns the decision, the hook may prepend an
 * injected memory message.
 */
async function runPreStep(
    handlers: RegisteredHandlers,
    agent: unknown,
    turn: number,
    step: number,
    text: string,
): Promise<void> {
    const message = { content: [{ type: 'text', text }], source: { kind: 'user-rpc' } }
    await emitHooks(handlers, 'agent/pre-step', { agent, messages: [message], turn, step, signal: new AbortController().signal }, async () => ({
        kind: 'enter',
        messages: [message],
    }))
}

/** `usage.outcome` of one record, with the SQL NULL normalized for assertions. */
function usageOutcome(h: { store: ScopeStore }, recordId: string): string {
    const value = h.store.db
        .prepare('SELECT outcome FROM usage WHERE record_id = ? AND session_id = ?')
        .get(recordId, 'sess-learn')?.['outcome']
    return typeof value === 'string' ? value : 'unattributed'
}

test('a tool failure pins attribution to its own step: a later injection is not blamed', async (t) => {
    // The failure signals carried no step on the real path (`onToolResult` had
    // nowhere to get one), so `failureSteps` was always empty and *every*
    // injection in the turn was marked failed — including one made after the
    // failure, which the model had never seen.
    const h = await harness(t)
    const { handlers, deps, handle } = wiredHooks(h)
    try {
        const seen = listRecords(h.store.db)[0]
        assert.ok(seen)
        const later = {
            ...materialize({
                title: 'a lesson injected after the failure',
                body: '触发场景：失败之后才注入。正确做法：不该被归因。',
                layer: 'project' as const,
                scopeKind: 'project' as const,
            }),
            id: 'injected-later',
        }
        upsertRecord(h.store.db, later)
        // Both injections go through the same writer `recordUsage` uses; only the
        // step differs, which is the whole point of the guard.
        recordRecalls(h.store.db, [
            { recordId: seen.id, sessionId: 'sess-learn', turn: 1, step: 1, score: 0.9 },
            { recordId: later.id, sessionId: 'sess-learn', turn: 1, step: 3, score: 0.9 },
        ])

        await runPreStep(handlers, h.agent, 1, 1, 'qqzzxx task text')
        // step 2 is where the tool fails; the step comes from the pre-step hook
        await runPreStep(handlers, h.agent, 1, 2, 'qqzzxx')
        deps.state.observeTurn('sess-learn', 1)
        await emitHooks(
            handlers,
            'tools/result',
            { name: 'bash', agent: h.agent },
            { isError: true, content: [{ type: 'text', text: 'ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY' }] },
        )
        assert.equal(deps.signals.peek('sess-learn', 1)[0]?.step, 2, 'the failure signal knows its step')
        await runPreStep(handlers, h.agent, 1, 3, 'qqzzxx')
        await emitHooks(handlers, 'agent/turn-stopping', { agent: h.agent, turn: 1 })

        assert.equal(usageOutcome(h, seen.id), 'failure', 'the injection the model had seen is blamed')
        assert.equal(usageOutcome(h, later.id), 'unattributed', 'the injection made after the failure is not')
        assert.equal(getRecord(h.store.db, later.id)?.failAfterRecall, 0)
        assert.equal(getRecord(h.store.db, seen.id)?.failAfterRecall, 1)
    } finally {
        handle.dispose()
    }
})

test('a correction on step 1 does not exempt an injection the model saw on step 2', async (t) => {
    // The reverse half of the same bug: with a correction (step 1) and a tool
    // failure in one turn, `Math.min` picked step 1 and the mark excluded
    // everything after it — under-attributing a failure the model did see.
    const h = await harness(t)
    const { handlers, deps, handle } = wiredHooks(h)
    try {
        const record = listRecords(h.store.db)[0]
        assert.ok(record)
        recordRecalls(h.store.db, [
            { recordId: record.id, sessionId: 'sess-learn', turn: 1, step: 2, score: 0.9 },
        ])

        // step 1 carries the user's correction; the real pre-step hook records it
        await runPreStep(handlers, h.agent, 1, 1, '不对，应该换个方式重跑一遍')
        const correction = deps.signals.peek('sess-learn', 1).find((signal) => signal.kind === 'user-correction')
        assert.equal(correction?.step, 1, 'the correction is stamped with its own step')

        await runPreStep(handlers, h.agent, 1, 3, 'qqzzxx')
        deps.state.observeTurn('sess-learn', 1)
        await emitHooks(
            handlers,
            'tools/result',
            { name: 'bash', agent: h.agent },
            { isError: true, content: [{ type: 'text', text: 'ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY' }] },
        )
        await emitHooks(handlers, 'agent/turn-stopping', { agent: h.agent, turn: 1 })

        assert.equal(
            usageOutcome(h, record.id),
            'failure',
            'the tool failure (step 3) is the mark, not the correction (step 1)',
        )
        assert.equal(getRecord(h.store.db, record.id)?.failAfterRecall, 1)
    } finally {
        handle.dispose()
    }
})
