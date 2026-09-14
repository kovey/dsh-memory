/**
 * Recall loop tests (DESIGN §6): query construction, ranked retrieval inside a
 * token budget, pre-step injection with per-session idempotence, usage
 * bookkeeping and the switchable prompt sections.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { createPreStepHook } from '../lib/hooks/pre-step.js'
import { indexSummaryText, protocolText, registerProtocolSection } from '../lib/hooks/prompt.js'
import { clearRepoCache } from '../lib/paths.js'
import { packTokens, recall, renderRecallPack } from '../lib/recall/engine.js'
import { normalizeRelevance } from '../lib/recall/rank.js'
import { buildQuery, messageText, isMemoryMessage } from '../lib/recall/query.js'
import { SessionState } from '../lib/recall/session-state.js'
import { recallStats } from '../lib/recall/usage.js'
import { ScopeResolver } from '../lib/scope/resolver.js'
import { countRecords } from '../lib/store/sqlite/records.js'
import { loadSqliteModule } from '../lib/store/sqlite/db.js'
import { StoreRegistry } from '../lib/store/store.js'
import { fakeRepo, lessonDoc, memoryFixture, useGlobalMemoryHome } from './helpers.ts'

const LESSONS = {
    'shell-background-trap.md': lessonDoc({
        title: 'shell background process trap',
        body: 'Background pipelines with stdio inherit produce no output; redirect to a file first.',
        confidence: 0.95,
        timesSeen: 3,
    }),
    'jsonl-compact.md': lessonDoc({
        title: 'JSONL audit lines must stay compact',
        body: 'Never pretty-print JSONL: one compact line per record.',
        confidence: 0.9,
    }),
    'pnpm-tty.md': lessonDoc({
        title: 'pnpm install without a TTY',
        body: 'Use --config.confirmModulesPurge=false when no TTY is available.',
        confidence: 0.8,
    }),
    'dsh-sandbox.md': lessonDoc({
        title: '写入可能被沙箱拒绝',
        body: '写 ~/.dsh 被沙箱拒绝时降级到项目本地并登记待重放。',
        confidence: 0.85,
    }),
}

async function harness(t: { skip: (reason: string) => void }, config: Record<string, unknown> = {}) {
    clearRepoCache()
    const repo = fakeRepo('recall-repo')
    const globalHome = memoryFixture('recall-global', {
        'global-toolchain.md': lessonDoc({
            title: 'dsh global toolchain fact',
            body: 'Scoped tarball URLs need an explicit registry.',
            confidence: 0.9,
        }),
    })
    useGlobalMemoryHome(globalHome.root)
    const lessonsDir = path.join(repo, '.dsh', 'memory', 'lessons')
    fs.mkdirSync(lessonsDir, { recursive: true })
    for (const [name, body] of Object.entries(LESSONS)) fs.writeFileSync(path.join(lessonsDir, name), body)

    const resolved = resolveConfig({ ...config })
    const registry = new StoreRegistry(resolved)
    const report = await registry.initialize(loadSqliteModule)
    if (!registry.available) {
        t.skip(`node:sqlite unavailable: ${report.probe.reason ?? 'unknown'}`)
        throw new Error('unreachable')
    }
    const resolver = new ScopeResolver(resolved)
    const agent = { session: { id: 'sess-1', header: { cwd: repo } } }
    return { repo, globalHome: globalHome.root, config: resolved, registry, resolver, agent, deps: { config: resolved, registry, resolver } }
}

function preStepPayload(agent: unknown, messages: unknown[], step = 1, turn = 1) {
    return { agent, messages, turn, step, signal: new AbortController().signal }
}

/** The real loop hands the admitted messages back through the decision. */
function nextEcho(payload: { messages: unknown[] }) {
    return async () => ({ kind: 'enter' as const, messages: payload.messages })
}

const USER_MESSAGE = { role: 'user', content: [{ type: 'text', text: 'pnpm install fails in the sandbox pipeline' }] }

test('buildQuery skips plugin-injected messages and extracts terms', () => {
    const query = buildQuery([
        { content: [{ type: 'text', text: 'pnpm install fails in the sandbox' }] },
        { content: [{ type: 'text', text: 'ignore me' }], source: { kind: 'plugin', plugin: 'dsh-memory' } },
    ])
    assert.equal(query.sources, 1)
    assert.ok(query.terms.includes('pnpm'))
    assert.ok(query.terms.includes('sandbox'))
    assert.ok(!query.terms.includes('ignore'))
    assert.equal(isMemoryMessage({ source: { plugin: 'dsh-memory' } }), true)
    assert.equal(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }] }), 'a')
})

test('recall ranks matches and respects the token budget', async (t) => {
    const h = await harness(t)
    const outcome = await recall(h.deps, { agent: h.agent, terms: ['pnpm', 'sandbox', 'install'] })
    assert.ok(outcome.hits.length >= 1)
    assert.ok(outcome.hits.every((hit) => hit.score > 0))
    assert.ok(outcome.scopes.some((scope) => scope.kind === 'project'))

    const tight = await recall(h.deps, { agent: h.agent, terms: ['pnpm', 'sandbox'], budgetTokens: 40 })
    assert.ok(tight.tokensUsed <= 60, `expected a small pack, got ${tight.tokensUsed}`)
    assert.ok(tight.hits.length <= outcome.hits.length)

    const floor = await recall(h.deps, { agent: h.agent, terms: ['pnpm'], minScore: 1e9 })
    assert.equal(floor.hits.length, 0)
})

test('recall can reach global memory for cross-project facts', async (t) => {
    const h = await harness(t)
    const outcome = await recall(h.deps, { agent: h.agent, terms: ['tarball', 'registry', 'scoped'] })
    assert.ok(outcome.hits.some((hit) => hit.scope.kind === 'global'))
})

test('the rendered pack carries the confidence caveat', async (t) => {
    const h = await harness(t)
    const outcome = await recall(h.deps, { agent: h.agent, terms: ['pnpm'] })
    const text = renderRecallPack(outcome.hits, outcome.dropped)
    assert.match(text, /dsh-memory 自动召回/)
    assert.match(text, /以当前事实为准/)
    assert.ok(packTokens(outcome.hits, outcome.dropped) > 0)
})

test('pre-step injects a plugin message first and records usage once per session', async (t) => {
    const h = await harness(t)
    const { state, ...deps } = { ...h.deps, state: new SessionState() }
    const hook = createPreStepHook({ ...deps, state })
    const next = async () => ({ kind: 'enter' as const, messages: [USER_MESSAGE] })

    const first = await hook(preStepPayload(h.agent, [USER_MESSAGE]), next)
    assert.equal(first.kind, 'enter')
    const messages = (first as { messages: unknown[] }).messages
    assert.equal(messages.length, 2)
    assert.equal(isMemoryMessage(messages[0] as never), true)
    assert.equal(messages[1], USER_MESSAGE, 'the original message must stay last')

    const store = h.registry.open(h.resolver.resolve({ agent: h.agent }))
    assert.ok(store)
    const stats = recallStats(store.db)
    assert.ok(stats.injections >= 1)
    const recalled = store.db.prepare('SELECT SUM(times_recalled) AS n FROM records').get()
    assert.ok(Number(recalled?.['n'] ?? 0) >= 1)

    // Same session, same query: everything is already injected → no second pack.
    const second = await hook(preStepPayload(h.agent, [USER_MESSAGE], 1, 2), next)
    assert.equal((second as { messages: unknown[] }).messages.length, 1)
})

test('pre-step stays quiet after step 1, when disabled, or without terms', async (t) => {
    const h = await harness(t, { recall: { autoInject: false } })
    const { state, ...deps } = { ...h.deps, state: new SessionState() }
    const disabled = createPreStepHook({ ...deps, state })
    const next = async () => ({ kind: 'enter' as const, messages: [USER_MESSAGE] })
    assert.equal(((await disabled(preStepPayload(h.agent, [USER_MESSAGE]), next)) as { messages: unknown[] }).messages.length, 1)

    const enabled = createPreStepHook({ ...deps, config: resolveConfig({}), state: new SessionState() })
    const secondStep = preStepPayload(h.agent, [USER_MESSAGE], 2)
    assert.equal(((await enabled(secondStep, nextEcho(secondStep))) as { messages: unknown[] }).messages.length, 1)

    const noTerms = preStepPayload(h.agent, [{ content: [{ type: 'text', text: 'a' }] }])
    assert.equal(((await enabled(noTerms, nextEcho(noTerms))) as { messages: unknown[] }).messages.length, 1)
})

test('a failing store never disturbs the step', async (t) => {
    const h = await harness(t)
    const state = new SessionState()
    const hook = createPreStepHook({ ...h.deps, state, registry: new StoreRegistry(h.config) })
    const next = async () => ({ kind: 'enter' as const, messages: [USER_MESSAGE] })
    const decision = await hook(preStepPayload(h.agent, [USER_MESSAGE]), next)
    assert.equal((decision as { messages: unknown[] }).messages.length, 1)
})

test('protocol section is short, switchable and never advertises missing tools', () => {
    const text = protocolText(resolveConfig({}))
    assert.match(text, /dsh-memory/)
    assert.match(text, /memory_search/)
    assert.doesNotMatch(text, /memory_save/)
    const withSave = protocolText(resolveConfig({}), { save: true })
    assert.match(withSave, /memory_save/)

    const registered: string[] = []
    const ctx = {
        systemPrompt: {
            section: (section: { name: string }) => {
                registered.push(section.name)
                return () => undefined
            },
        },
    }
    const h = { registry: new StoreRegistry(resolveConfig({})), resolver: new ScopeResolver(resolveConfig({})), capabilities: { save: false } }
    assert.equal(registerProtocolSection(ctx as never, { config: resolveConfig({}), ...h }).length, 1)
    assert.deepEqual(registered, ['memory:protocol'])
    assert.equal(
        registerProtocolSection(ctx as never, { config: resolveConfig({ prompt: { protocol: { enabled: false } } }), ...h }).length,
        0,
    )
})

test('index summary reflects the project store and shrinks to its budget', async (t) => {
    const h = await harness(t)
    const store = h.registry.open(h.resolver.resolve({ agent: h.agent }))
    assert.ok(store)
    assert.equal(countRecords(store.db).total, Object.keys(LESSONS).length)

    const full = indexSummaryText({ config: h.config, registry: h.registry, resolver: h.resolver, capabilities: { save: false } }, h.agent)
    assert.match(full, /项目记忆：4 条/)
    assert.match(full, /全局记忆：1 条/)

    const tight = indexSummaryText(
        { config: resolveConfig({ prompt: { indexSummary: { budgetTokens: 8, maxTitles: 1 } } }), registry: h.registry, resolver: h.resolver, capabilities: { save: false } },
        h.agent,
    )
    assert.ok(tight.length < full.length)
})

test('session state forgets sessions and caps its size', () => {
    const state = new SessionState(2)
    state.markInjected('a', ['r1'])
    assert.equal(state.hasInjected('a', 'r1'), true)
    state.observeTurn('b', 3)
    state.markInjected('c', ['r9'])
    assert.equal(state.size <= 2, true)
    state.forget('c')
    assert.equal(state.hasInjected('c', 'r9'), false)
})

test('bm25 normalization ranks the strongest match first', () => {
    // SQLite bm25 is negative; the largest magnitude is the best match.
    const normalized = normalizeRelevance(
        new Map([
            ['weak', -0.4],
            ['strong', -3.2],
            ['middle', -1.1],
        ]),
    )
    assert.equal(normalized.get('strong'), 1)
    // scaled by the strongest hit, with a floor so a real match is never zeroed
    assert.ok((normalized.get('weak') ?? 0) > 0 && (normalized.get('weak') ?? 0) < 0.2)
    assert.ok((normalized.get('middle') ?? 0) > (normalized.get('weak') ?? 0))
    assert.ok((normalized.get('middle') ?? 0) < 1)
    assert.equal(normalizeRelevance(new Map([['only', -2.5]])).get('only'), 1)
    assert.equal(normalizeRelevance(new Map()).size, 0)
})

test('a title match outranks a body-only match', async (t) => {
    const h = await harness(t)
    const outcome = await recall(h.deps, { agent: h.agent, terms: ['pnpm', 'install', 'tty'] })
    assert.equal(outcome.hits[0]?.record.id, 'pnpm-tty')
})
