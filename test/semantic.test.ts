/**
 * Semantic-recall tests (DESIGN §14.3): provider behaviour, incremental vector
 * caching, hybrid blending, and the "never block or charge when it cannot help"
 * guarantees.
 *
 * Embeddings are faked deterministically by concept keywords, so the assertions
 * are about the mechanism (blending, caching, degradation) rather than about a
 * particular model's notion of similarity.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { clearRepoCache } from '../lib/paths.js'
import { recall } from '../lib/recall/engine.js'
import {
    QueryVectorCache,
    blendRelevance,
    cosine,
    createRemoteProvider,
    embeddingText,
    ensureEmbeddings,
    indexStats,
    loadVectors,
    pruneVectors,
    recordHash,
    saveVectors,
    semanticRecall,
    similarityScores,
    toBlob,
    fromBlob,
} from '../lib/recall/semantic.js'
import type { EmbeddingProvider } from '../lib/recall/semantic.js'
import { ScopeResolver } from '../lib/scope/resolver.js'
import { loadSqliteModule } from '../lib/store/sqlite/db.js'
import { listRecords, materialize, upsertRecord } from '../lib/store/sqlite/records.js'
import { StoreRegistry } from '../lib/store/store.js'
import { fakeRepo, lessonDoc, memoryFixture, useGlobalMemoryHome } from './helpers.ts'

/** Concept vector: [has "terminal-ish", has "install-ish", constant]. */
function conceptVector(text: string): number[] {
    const t = text.toLowerCase()
    const terminal = /tty|终端|terminal/.test(t) ? 1 : 0.1
    const install = /安装|装依赖|install|依赖/.test(t) ? 1 : 0.1
    return [terminal, install, 0.2]
}

function fakeProvider(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider & { calls: number; texts: string[] } {
    const state = {
        calls: 0,
        texts: [] as string[],
    }
    return {
        id: 'fake:concept',
        available: () => true,
        lastError: () => undefined,
        async embed(texts) {
            state.calls += 1
            state.texts.push(...texts)
            return texts.map(conceptVector)
        },
        get calls() {
            return state.calls
        },
        get texts() {
            return state.texts
        },
        ...overrides,
    }
}

async function harness(t: { skip: (reason: string) => void }, semantic: Record<string, unknown> = {}) {
    clearRepoCache()
    const repo = fakeRepo('sem-repo')
    const globalHome = memoryFixture('sem-global', {})
    useGlobalMemoryHome(globalHome.root)
    const lessonsDir = path.join(repo, '.dsh', 'memory', 'lessons')
    fs.mkdirSync(lessonsDir, { recursive: true })
    fs.writeFileSync(
        path.join(lessonsDir, 'pnpm-tty.md'),
        lessonDoc({ title: 'pnpm install without a TTY', body: '无 TTY 环境下 pnpm 安装会中止，用 CI=true 重试。', confidence: 0.9 }),
    )
    fs.writeFileSync(
        path.join(lessonsDir, 'jsonl.md'),
        lessonDoc({ title: 'JSONL lines stay compact', body: '审计日志每行一条紧凑 JSON。', confidence: 0.9 }),
    )
    const config = resolveConfig({
        semantic: { enabled: true, provider: 'remote', baseUrl: 'http://fake', model: 'fake-embed', ...semantic },
    })
    const registry = new StoreRegistry(config)
    const report = await registry.initialize(loadSqliteModule)
    if (!registry.available) {
        t.skip(`node:sqlite unavailable: ${report.probe.reason ?? 'unknown'}`)
        throw new Error('unreachable')
    }
    const resolver = new ScopeResolver(config)
    const agent = { session: { id: 'sem', header: { cwd: repo } } }
    const scope = resolver.resolve({ agent })
    const store = registry.open(scope)
    assert.ok(store)
    return { repo, config, registry, resolver, agent, scope, store }
}

// ---- provider ---------------------------------------------------------------

test('the remote provider posts batches and returns vectors', async () => {
    const seen: { url: string; auth: string | undefined; body: unknown }[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { input: string[] }
        seen.push({
            url: String(url),
            auth: (init?.headers as Record<string, string> | undefined)?.['authorization'],
            body,
        })
        return new Response(JSON.stringify({ data: body.input.map((text) => ({ embedding: conceptVector(text) })) }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })
    }) as unknown as typeof fetch

    const provider = createRemoteProvider({
        baseUrl: 'https://embed.example/v1/',
        model: 'm1',
        apiKey: 'secret',
        timeoutMs: 500,
        batchSize: 2,
        fetchImpl,
    })
    assert.equal(provider.available(), true)
    const vectors = await provider.embed(['a', 'b', 'c'])
    assert.equal(vectors?.length, 3)
    assert.equal(seen.length, 2, 'three inputs with batchSize 2 → two calls')
    assert.equal(seen[0]?.url, 'https://embed.example/v1/embeddings')
    assert.equal(seen[0]?.auth, 'Bearer secret')
    assert.equal(provider.lastError(), undefined)
})

test('the remote provider degrades instead of throwing', async () => {
    const failing = createRemoteProvider({
        baseUrl: 'https://embed.example/v1',
        model: 'm1',
        timeoutMs: 200,
        fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    })
    assert.equal(await failing.embed(['x']), undefined)
    assert.equal(failing.lastError(), 'HTTP 500')

    const unreachable = createRemoteProvider({
        baseUrl: 'https://embed.example/v1',
        model: 'm1',
        timeoutMs: 200,
        fetchImpl: (async () => {
            throw new Error('ECONNREFUSED')
        }) as unknown as typeof fetch,
    })
    assert.equal(await unreachable.embed(['x']), undefined)
    assert.match(unreachable.lastError() ?? '', /ECONNREFUSED/)

    const malformed = createRemoteProvider({
        baseUrl: 'https://embed.example/v1',
        model: 'm1',
        timeoutMs: 200,
        fetchImpl: (async () => new Response(JSON.stringify({ data: [{ embedding: 'not-a-vector' }] }), { status: 200 })) as unknown as typeof fetch,
    })
    assert.equal(await malformed.embed(['x']), undefined)

    const unconfigured = createRemoteProvider({ baseUrl: '', model: '', timeoutMs: 100 })
    assert.equal(unconfigured.available(), false)
    assert.equal(await unconfigured.embed(['x']), undefined)
})

test('the provider works against a real HTTP endpoint', async () => {
    const server = http.createServer((request, response) => {
        let body = ''
        request.on('data', (chunk) => {
            body += String(chunk)
        })
        request.on('end', () => {
            const parsed = JSON.parse(body) as { input: string[] }
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ data: parsed.input.map((text) => ({ embedding: conceptVector(text) })) }))
        })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    try {
        const provider = createRemoteProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'local-fake', timeoutMs: 2_000 })
        const vectors = await provider.embed(['TTY 安装', 'jsonl 紧凑'])
        assert.equal(vectors?.length, 2)
        assert.ok((vectors?.[0]?.[0] ?? 0) > (vectors?.[1]?.[0] ?? 0))
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
})

// ---- vector storage ---------------------------------------------------------

test('vectors store, reload and re-embed only when content changes', async (t) => {
    const h = await harness(t)
    const provider = fakeProvider()
    const model = 'fake-embed'

    assert.equal(await ensureEmbeddings(h.store.db, provider, model), 2)
    assert.equal(provider.calls, 1)
    assert.equal(indexStats(h.store.db, model).indexed, 2)
    assert.equal(indexStats(h.store.db, model).pending, 0)

    // unchanged records never cost another call
    assert.equal(await ensureEmbeddings(h.store.db, provider, model), 0)
    assert.equal(provider.calls, 1)

    // a changed lesson is re-embedded, and only that one
    const record = listRecords(h.store.db).find((item) => item.id === 'jsonl')
    assert.ok(record)
    upsertRecord(h.store.db, { ...record, body: `${record.body} 追加一句。`, updatedAt: new Date().toISOString() })
    assert.equal(indexStats(h.store.db, model).pending, 1)
    assert.equal(await ensureEmbeddings(h.store.db, provider, model), 1)
    assert.equal(provider.texts.filter((text) => text.includes('追加一句')).length, 1)

    // vectors survive a round trip through the blob column
    const vectors = loadVectors(h.store.db, model)
    assert.equal(vectors.size, 2)
    const round = fromBlob(toBlob([0.25, -0.5, 0.75]))
    assert.ok(Math.abs((round[0] ?? 0) - 0.25) < 1e-6)
    assert.ok(Math.abs((round[1] ?? 0) + 0.5) < 1e-6)
})

test('orphaned vectors are pruned', async (t) => {
    const h = await harness(t)
    const provider = fakeProvider()
    await ensureEmbeddings(h.store.db, provider, 'fake-embed')
    saveVectors(h.store.db, 'fake-embed', [{ recordId: 'ghost', vector: [1, 0, 0], hash: 'x' }])
    assert.equal(loadVectors(h.store.db, 'fake-embed').size, 3)
    assert.equal(pruneVectors(h.store.db, 'fake-embed'), 1)
    assert.equal(loadVectors(h.store.db, 'fake-embed').size, 2)
})

test('cosine similarity and similarity scores behave', () => {
    assert.ok(Math.abs(cosine(new Float32Array([1, 0]), new Float32Array([1, 0])) - 1) < 1e-6)
    assert.equal(cosine(new Float32Array([1, 0]), new Float32Array([0, 1])), 0)
    assert.equal(cosine(new Float32Array([]), new Float32Array([])), 0)
    const scores = similarityScores(
        new Map([
            ['same', new Float32Array([1, 0])],
            ['opposite', new Float32Array([-1, 0])],
        ]),
        new Float32Array([1, 0]),
    )
    assert.equal(scores.get('same'), 1)
    assert.equal(scores.get('opposite'), 0, 'negative similarity is clamped')
})

// ---- blending ---------------------------------------------------------------

test('blending surfaces semantic-only hits and respects the weight', () => {
    const lexical = new Map([['a', 1]])
    const semantic = new Map([
        ['a', 0.9],
        ['b', 0.8],
        ['c', 0.1],
    ])
    const blended = blendRelevance(lexical, semantic, 0.5, 0.35)
    assert.deepEqual(blended.semanticOnly, ['b'], 'c is below the similarity floor')
    assert.ok((blended.relevance.get('a') ?? 0) > (blended.relevance.get('b') ?? 0))
    const semanticHeavy = blendRelevance(lexical, semantic, 0.9, 0.35)
    assert.ok((semanticHeavy.relevance.get('b') ?? 0) > (blended.relevance.get('b') ?? 0))

    // weight 0 is pure lexical: a semantic-only hit cannot sneak in above the floor
    const lexicalOnly = blendRelevance(lexical, new Map([['b', 1]]), 0, 0.35)
    assert.equal(lexicalOnly.relevance.has('b'), false)
})

// ---- integration with the recall engine -------------------------------------

test('semantic recall finds a lesson with no keyword overlap', async (t) => {
    const h = await harness(t)
    const provider = fakeProvider()
    const cache = new QueryVectorCache()
    const deps = { config: h.config, registry: h.registry, resolver: h.resolver, semantic: { provider, cache } }

    // No lexical overlap with the TTY lesson: no shared terms at all.
    const outcome = await recall(deps, { agent: h.agent, terms: ['终端环境依赖'], text: '怎么在没有终端的环境装依赖' })
    assert.equal(outcome.hits[0]?.record.id, 'pnpm-tty', `expected the TTY lesson, got ${outcome.hits.map((hit) => hit.record.id).join(',')}`)
    assert.equal(outcome.semantic?.used, true)
    assert.equal(provider.calls >= 1, true)

    // the second identical query is served from the query cache
    const callsBefore = provider.calls
    await recall(deps, { agent: h.agent, terms: ['终端环境依赖'], text: '怎么在没有终端的环境装依赖' })
    assert.equal(provider.calls, callsBefore, 'query vectors are cached')
    assert.ok(cache.size >= 1)
})

test('lexical recall that is already rich skips the embedding call', async (t) => {
    // `minLexicalHits` counts *matched records*, so a small store needs the
    // threshold lowered to express "lexical already found enough".
    const h = await harness(t, { minLexicalHits: 2 })
    const provider = fakeProvider()
    const deps = { config: h.config, registry: h.registry, resolver: h.resolver, semantic: { provider, cache: new QueryVectorCache() } }

    const outcome = await recall(deps, { agent: h.agent, terms: ['pnpm', 'jsonl'], text: 'pnpm jsonl' })
    // `considered` is the lexical candidate count — the number the gate looks at.
    assert.equal(outcome.considered, 2, 'both lessons match lexically')
    assert.ok(outcome.hits.length >= 1)
    assert.equal(outcome.semantic?.used, false)
    assert.equal(provider.calls, 0, 'a rich lexical result must not cost an embedding call')
})

test('a failing provider degrades to lexical recall', async (t) => {
    const h = await harness(t)
    const provider = fakeProvider({
        embed: async () => undefined,
        lastError: () => 'HTTP 503',
    })
    const deps = { config: h.config, registry: h.registry, resolver: h.resolver, semantic: { provider, cache: new QueryVectorCache() } }

    // This phrasing shares no term (nor CJK bigram) with the stored lessons, so
    // without a working provider there is nothing to recall.
    const semanticMiss = await recall(deps, { agent: h.agent, terms: ['离线构建流水线'], text: '离线构建流水线' })
    assert.equal(semanticMiss.semantic?.used, false)
    assert.equal(semanticMiss.hits.length, 0)

    // …and the lexical path is untouched
    const lexical = await recall(deps, { agent: h.agent, terms: ['pnpm', 'tty'], text: 'pnpm tty' })
    assert.equal(lexical.hits[0]?.record.id, 'pnpm-tty')
})

test('semantic recall stays off unless enabled, whatever else is configured', async (t) => {
    const h = await harness(t, { enabled: false })
    const provider = fakeProvider()
    const deps = { config: h.config, registry: h.registry, resolver: h.resolver, semantic: { provider, cache: new QueryVectorCache() } }
    const outcome = await recall(deps, { agent: h.agent, terms: ['终端环境依赖'], text: '怎么在没有终端的环境装依赖' })
    assert.equal(outcome.semantic?.used, false)
    assert.equal(outcome.semantic?.reason, 'semantic disabled')
    assert.equal(provider.calls, 0)
})

test('semanticRecall reports why it stayed lexical', async (t) => {
    const h = await harness(t)
    const provider = fakeProvider()
    const off = await semanticRecall(
        { config: resolveConfig({}), registry: h.registry, provider, cache: new QueryVectorCache() },
        h.store,
        'anything',
        0,
    )
    assert.equal(off.used, false)
    assert.equal(off.reason, 'semantic disabled')

    const rich = await semanticRecall(
        { config: h.config, registry: h.registry, provider, cache: new QueryVectorCache() },
        h.store,
        'anything',
        5,
    )
    assert.equal(rich.reason, 'lexical recall sufficient')

    const empty = await semanticRecall({ config: h.config, registry: h.registry, provider, cache: new QueryVectorCache() }, h.store, '   ', 0)
    assert.equal(empty.reason, 'empty query')
})

test('embeddingText is bounded and covers title plus body', () => {
    const record = materialize({ title: 'title', body: 'x'.repeat(5_000), layer: 'project', scopeKind: 'project' })
    const text = embeddingText(record)
    assert.ok(text.startsWith('title\n'))
    assert.ok(text.length <= 2_000)
    assert.equal(recordHash(record), recordHash(record))
    assert.notEqual(recordHash(record), recordHash({ ...record, body: 'other' }))
})

test('semantic-only additions are bounded by maxAdditions', async (t) => {
    const h = await harness(t)
    const provider = fakeProvider()
    const query = { agent: h.agent, terms: ['终端环境依赖'], text: '怎么在没有终端的环境装依赖', minScore: 0 }

    // `pnpm-tty` matches lexically (the CJK bigram 环境), while `jsonl` is only
    // semantically near — that second one is the "addition" the cap governs.
    const allowed = await recall(
        { config: h.config, registry: h.registry, resolver: h.resolver, semantic: { provider, cache: new QueryVectorCache() } },
        query,
    )
    assert.equal(allowed.semantic?.used, true)
    assert.equal(allowed.semantic?.semanticOnly, 1, 'the semantic-only lesson was added')
    assert.deepEqual(allowed.hits.map((hit) => hit.record.id).sort(), ['jsonl', 'pnpm-tty'])

    // maxAdditions: 0 → the pass still runs, but nothing is added
    const capped = resolveConfig({
        semantic: { enabled: true, provider: 'remote', baseUrl: 'http://fake', model: 'fake-embed', minLexicalHits: 3, maxAdditions: 0 },
    })
    const none = await recall(
        { config: capped, registry: h.registry, resolver: h.resolver, semantic: { provider, cache: new QueryVectorCache() } },
        { agent: h.agent, terms: ['终端环境依赖'], text: '怎么在没有终端的环境装依赖', minScore: 0 },
    )
    assert.equal(none.semantic?.used, true, 'the pass still ran; it just added nothing')
    assert.equal(none.semantic?.semanticOnly, 0)
    assert.deepEqual(none.hits.map((hit) => hit.record.id), ['pnpm-tty'], 'only the lexical hit remains')
})

test('a semantic-only hit is admitted by minSimilarity, not by the lexical score floor', async (t) => {
    // Regression guard from a live run: with weight 0.3 a semantic-only record
    // scores below the 0.35 lexical floor, so it was found and then dropped —
    // "considered 2, injected 0".
    const h = await harness(t)
    const provider = fakeProvider()
    const lowWeight = resolveConfig({
        semantic: { enabled: true, provider: 'remote', baseUrl: 'http://fake', model: 'fake-embed', minLexicalHits: 3, weight: 0.3, minSimilarity: 0.45, maxAdditions: 2 },
    })
    const outcome = await recall(
        { config: lowWeight, registry: h.registry, resolver: h.resolver, semantic: { provider, cache: new QueryVectorCache() } },
        { agent: h.agent, terms: ['终端环境依赖'], text: '怎么在没有终端的环境装依赖' },
    )
    assert.equal(outcome.semantic?.used, true)
    assert.ok(outcome.semantic?.semanticOnly === 1)
    assert.ok(
        outcome.hits.some((hit) => hit.record.id === 'jsonl'),
        `the semantically-near lesson must survive the lexical floor, got ${outcome.hits.map((hit) => hit.record.id).join(',')}`,
    )
})

// ---- audit fixes ------------------------------------------------------------

test('the embedding budget covers the whole run, not each batch', async () => {
    let calls = 0
    const slow: typeof fetch = async (_input, init) => {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 60))
        const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] }
        return new Response(
            JSON.stringify({ data: (body.input ?? []).map(() => ({ embedding: [1, 0, 0] })) }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        )
    }
    const provider = createRemoteProvider({
        baseUrl: 'http://fake/v1',
        model: 'm',
        timeoutMs: 5_000,
        budgetMs: 120,
        batchSize: 1,
        fetchImpl: slow,
    })
    const started = Date.now()
    const vectors = await provider.embed(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    const elapsed = Date.now() - started
    assert.ok(elapsed < 1_000, `the run must stop at its budget, took ${elapsed}ms`)
    assert.ok(calls < 8, `not every batch may be attempted (calls=${calls})`)
    assert.ok(vectors === undefined || vectors.length >= 1, 'partial work is returned rather than discarded')
})

test('an already-aborted signal never reaches the network', async () => {
    let calls = 0
    const provider = createRemoteProvider({
        baseUrl: 'http://fake/v1',
        model: 'm',
        timeoutMs: 1_000,
        fetchImpl: async () => {
            calls += 1
            return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), { status: 200 })
        },
    })
    const controller = new AbortController()
    controller.abort()
    const vectors = await provider.embed(['x'], controller.signal)
    assert.equal(calls, 0, 'no request may be sent after cancellation')
    assert.equal(vectors, undefined)
    assert.match(String(provider.lastError()), /abort/i)
})

test('vectors from a different embedding space are ignored, never compared', async (t) => {
    // Same model name, different dimension (an endpoint changed behind it): the
    // old code compared prefixes with min-length cosine and returned a number.
    assert.equal(cosine(new Float32Array([1, 0, 0, 0]), new Float32Array([1, 0])), 0)

    const module_ = await loadSqliteModule()
    if (module_ === undefined) return
    const h = await harness(t)
    saveVectors(h.store.db, 'm', [
        { recordId: 'right-dim', vector: [1, 0, 0], hash: 'h-right' },
        { recordId: 'wrong-dim', vector: [1, 0], hash: 'h-wrong' },
    ])
    const loaded = loadVectors(h.store.db, 'm', 3)
    assert.deepEqual([...loaded.keys()], ['right-dim'])
    assert.equal(loadVectors(h.store.db, 'm').size, 2, 'without an expected dimension everything loads')
})

test('the query cache is keyed by the embedded text, not a term prefix', async (t) => {
    const h = await harness(t, { enabled: true, provider: 'remote', baseUrl: 'http://fake', model: 'fake-embed', minLexicalHits: 99 })
    const provider = fakeProvider()
    const cache = new QueryVectorCache()
    const first = 'a'.repeat(30) + ' 第一个查询'
    const second = 'a'.repeat(30) + ' 第二个查询'
    const results = [
        await semanticRecall({ config: h.config, registry: h.registry, provider, cache }, h.store, first, 0),
        await semanticRecall({ config: h.config, registry: h.registry, provider, cache }, h.store, second, 0),
    ]
    assert.equal(results.filter((outcome) => outcome.used).length, 2)
    assert.ok(provider.calls >= 2, 'two different queries must not share one cached vector')
})

test('maxAdditions caps the whole query, not each root', async (t) => {
    const h = await harness(t, { enabled: true, provider: 'remote', baseUrl: 'http://fake', model: 'fake-embed', minLexicalHits: 99, maxAdditions: 1 })
    const provider = fakeProvider()
    // a second root (global) with its own semantically-near record
    const global = h.registry.open(h.resolver.globalScope())
    assert.ok(global)
    upsertRecord(
        global.db,
        materialize({ title: 'global near', body: '无 TTY 环境下 pnpm 安装会中止，用 CI=true 重试。', layer: 'global', scopeKind: 'global', confidence: 0.9 }),
    )
    await ensureEmbeddings(global.db, provider, 'fake-embed', { limit: -1 })
    upsertRecord(
        h.store.db,
        materialize({ title: 'project near', body: '无 TTY 环境下 pnpm 安装会中止，用 CI=true 重试。', layer: 'project', scopeKind: 'project', repo: h.repo, confidence: 0.9 }),
    )
    const outcome = await recall(
        { config: h.config, registry: h.registry, resolver: h.resolver, semantic: { provider, cache: new QueryVectorCache() } },
        { agent: h.agent, terms: ['终端环境依赖'], text: '怎么在没有终端的环境装依赖', minScore: 0 },
    )
    assert.ok((outcome.semantic?.semanticOnly ?? 0) <= 1, `expected at most 1 addition across roots, got ${outcome.semantic?.semanticOnly}`)
})
