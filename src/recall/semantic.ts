/**
 * Optional semantic recall (DESIGN §14.3 claim, now implemented).
 *
 * Design constraints that shape this module:
 *   - **Off by default.** Embeddings are the only feature that can spend money
 *     outside the bounded distillation path, so `semantic.enabled` is false
 *     until a human turns it on.
 *   - **Never block the step.** The provider call is bounded by
 *     `semantic.timeoutMs`, and only happens when lexical recall came back thin
 *     (`minLexicalHits`). Any failure degrades to lexical silently — a broken
 *     endpoint must not cost a turn.
 *   - **Pay once per lesson.** Vectors are cached in SQLite keyed by the content
 *     hash, so an unchanged record is never re-embedded and a changed one is.
 *   - **Blend, do not replace.** The result feeds the existing `relevance` input
 *     of the ranker, so confidence/freshness/layer weights still apply.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { MemoryConfig } from '../config.js'
import { log } from '../log.js'
import { transact } from '../store/sqlite/db.js'
import { listRecords } from '../store/sqlite/records.js'
import type { MemoryRecord } from '../store/types.js'
import type { StoreRegistry, ScopeStore } from '../store/store.js'
import { hash } from '../store/rebuild.js'
import { extractTerms } from '../store/sqlite/records.js'

export interface EmbeddingProvider {
    id: string
    /** Whether the provider is usable at all (configuration + credentials). */
    available(): boolean
    /** Embed a batch; resolves to `undefined` on any failure (degrade to lexical). */
    embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][] | undefined>
    /** Last error, for `memory_stats`. */
    lastError(): string | undefined
}

export interface RemoteProviderOptions {
    baseUrl: string
    model: string
    apiKey?: string | undefined
    timeoutMs: number
    /** Batches larger than this are split. */
    batchSize?: number
    /** Injected for tests. */
    fetchImpl?: typeof fetch
}

/** Minimal OpenAI-compatible `/embeddings` client. */
export function createRemoteProvider(options: RemoteProviderOptions): EmbeddingProvider {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    const batchSize = Math.max(1, options.batchSize ?? 32)
    let lastError: string | undefined
    let calls = 0
    return {
        id: `remote:${options.model}`,
        available: () => options.baseUrl !== '' && options.model !== '' && typeof fetchImpl === 'function',
        lastError: () => lastError,
        async embed(texts, signal) {
            if (texts.length === 0) return []
            if (!this.available()) {
                lastError = 'provider not configured (baseUrl/model missing)'
                return undefined
            }
            const out: number[][] = []
            try {
                for (let i = 0; i < texts.length; i += batchSize) {
                    const batch = texts.slice(i, i + batchSize)
                    const controller = new AbortController()
                    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
                    const onAbort = (): void => controller.abort()
                    signal?.addEventListener('abort', onAbort, { once: true })
                    try {
                        calls += 1
                        const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, '')}/embeddings`, {
                            method: 'POST',
                            headers: {
                                'content-type': 'application/json',
                                ...(options.apiKey !== undefined && options.apiKey !== ''
                                    ? { authorization: `Bearer ${options.apiKey}` }
                                    : {}),
                            },
                            body: JSON.stringify({ model: options.model, input: batch }),
                            signal: controller.signal,
                        })
                        if (!response.ok) {
                            lastError = `HTTP ${response.status}`
                            return undefined
                        }
                        const payload = (await response.json()) as { data?: { embedding?: unknown }[] }
                        const rows = payload.data ?? []
                        for (const row of rows) {
                            if (!Array.isArray(row.embedding)) {
                                lastError = 'malformed embedding response'
                                return undefined
                            }
                            out.push(row.embedding.map((value) => Number(value)))
                        }
                    } finally {
                        clearTimeout(timer)
                        signal?.removeEventListener('abort', onAbort)
                    }
                }
                if (out.length !== texts.length) {
                    lastError = `expected ${texts.length} vectors, got ${out.length}`
                    return undefined
                }
                lastError = undefined
                return out
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error)
                log('debug', `memory: embedding call failed (${calls} call(s)):`, lastError)
                return undefined
            }
        },
    }
}

/** Build the configured provider, or `undefined` when semantic recall is off. */
export function createEmbeddingProvider(config: MemoryConfig): EmbeddingProvider | undefined {
    const semantic = config.semantic
    if (!semantic.enabled || semantic.provider !== 'remote') return undefined
    const apiKey = semantic.apiKeyEnv !== '' ? process.env[semantic.apiKeyEnv] : semantic.apiKey
    // The endpoint may be indirection-only (e.g. the same gateway the session
    // already uses), so an env var can supply the base URL.
    const fromEnv = semantic.baseUrlEnv !== '' ? process.env[semantic.baseUrlEnv] : undefined
    const baseUrl = fromEnv !== undefined && fromEnv !== '' ? fromEnv : semantic.baseUrl
    return createRemoteProvider({
        baseUrl,
        model: semantic.model,
        apiKey: apiKey !== undefined && apiKey !== '' ? apiKey : semantic.apiKey,
        timeoutMs: semantic.timeoutMs,
    })
}

// ---- vector storage ---------------------------------------------------------

export function toBlob(vector: readonly number[]): Uint8Array {
    const floats = new Float32Array(vector)
    return new Uint8Array(floats.buffer.slice(0))
}

export function fromBlob(blob: Uint8Array): Float32Array {
    return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
}

/** Content hash of the parts that get embedded. */
export function recordHash(record: MemoryRecord): string {
    return hash(`${record.title}\n${record.body}\n${record.tags.join(',')}`).toString(16)
}

export interface StoredVector {
    recordId: string
    vector: Float32Array
}

export function loadVectors(db: DatabaseSync, model: string): Map<string, Float32Array> {
    const rows = db.prepare('SELECT record_id, vector FROM embeddings WHERE model = ?').all(model)
    const out = new Map<string, Float32Array>()
    for (const row of rows) {
        const id = row['record_id']
        const blob = row['vector']
        if (typeof id !== 'string') continue
        // node:sqlite hands BLOBs back as Uint8Array; anything else is not a vector.
        if (blob instanceof Uint8Array) out.set(id, fromBlob(blob))
    }
    return out
}

export function saveVectors(
    db: DatabaseSync,
    model: string,
    entries: readonly { recordId: string; vector: readonly number[]; hash: string }[],
    at = new Date().toISOString(),
): void {
    if (entries.length === 0) return
    transact(db, () => {
        const statement = db.prepare(
            'INSERT INTO embeddings (record_id, model, dim, hash, vector, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(record_id, model) DO UPDATE SET dim = excluded.dim, hash = excluded.hash, vector = excluded.vector, at = excluded.at',
        )
        for (const entry of entries) {
            statement.run(entry.recordId, model, entry.vector.length, entry.hash, toBlob(entry.vector), at)
        }
    })
}

/** Records eligible for recall in one scope. */
export function searchableRecords(db: DatabaseSync): number {
    const row = db.prepare("SELECT COUNT(*) AS n FROM records WHERE status IN ('active', 'pending')").get()
    const value = row?.['n']
    if (typeof value === 'number') return value
    if (typeof value === 'bigint') return Number(value)
    return 0
}

/** Records whose vector is missing or stale (content changed since indexing). */
export function pendingRecords(db: DatabaseSync, model: string, limit: number): MemoryRecord[] {
    const known = new Map<string, string>()
    for (const row of db.prepare('SELECT record_id, hash FROM embeddings WHERE model = ?').all(model)) {
        const id = row['record_id']
        const hashValue = row['hash']
        if (typeof id === 'string' && typeof hashValue === 'string') known.set(id, hashValue)
    }
    return listRecords(db, { status: ['active', 'pending'] })
        .filter((record) => known.get(record.id) !== recordHash(record))
        .slice(0, Math.max(0, limit))
}

export interface IndexStats {
    indexed: number
    pending: number
    model: string
}

export function indexStats(db: DatabaseSync, model: string): IndexStats {
    const row = db.prepare('SELECT COUNT(*) AS n FROM embeddings WHERE model = ?').get(model)
    const indexed = typeof row?.['n'] === 'number' ? row['n'] : 0
    return { indexed, pending: pendingRecords(db, model, 5_000).length, model }
}

/** Drop vectors of records that no longer exist. */
export function pruneVectors(db: DatabaseSync, model: string): number {
    const result = db
        .prepare('DELETE FROM embeddings WHERE model = ? AND record_id NOT IN (SELECT id FROM records)')
        .run(model)
    return typeof result.changes === 'number' ? result.changes : 0
}

// ---- indexing and search ----------------------------------------------------

/** Text fed to the embedding model for one record. */
export function embeddingText(record: MemoryRecord): string {
    return `${record.title}\n${record.body}`.slice(0, 2_000)
}

export interface EnsureOptions {
    signal?: AbortSignal
    /** Cap for this pass; `-1` means "everything pending". */
    limit?: number
}

/**
 * Bring the semantic index up to date, incrementally. Returns how many records
 * were embedded; failures are reported through the provider's `lastError`.
 */
export async function ensureEmbeddings(
    db: DatabaseSync,
    provider: EmbeddingProvider,
    model: string,
    options: EnsureOptions = {},
): Promise<number> {
    pruneVectors(db, model)
    const limit = options.limit !== undefined && options.limit >= 0 ? options.limit : 5_000
    const pending = pendingRecords(db, model, limit)
    if (pending.length === 0) return 0
    const vectors = await provider.embed(pending.map(embeddingText), options.signal)
    if (vectors === undefined) return 0
    saveVectors(
        db,
        model,
        pending.map((record, index) => ({
            recordId: record.id,
            vector: vectors[index] ?? [],
            hash: recordHash(record),
        })).filter((entry) => entry.vector.length > 0),
    )
    return pending.length
}

export function cosine(a: Float32Array, b: Float32Array): number {
    const length = Math.min(a.length, b.length)
    if (length === 0) return 0
    let dot = 0
    let normA = 0
    let normB = 0
    for (let i = 0; i < length; i += 1) {
        const x = a[i] ?? 0
        const y = b[i] ?? 0
        dot += x * y
        normA += x * x
        normB += y * y
    }
    if (normA === 0 || normB === 0) return 0
    return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** Cosine similarity in 0..1 (negative similarity is clamped to 0). */
export function similarityScores(vectors: Map<string, Float32Array>, query: Float32Array): Map<string, number> {
    const out = new Map<string, number>()
    for (const [id, vector] of vectors) {
        out.set(id, Math.max(0, cosine(vector, query)))
    }
    return out
}

// ---- query cache ------------------------------------------------------------

const QUERY_CACHE_LIMIT = 64

/** Small LRU so a repeated query never costs a second call. */
export class QueryVectorCache {
    private readonly entries = new Map<string, Float32Array>()

    get(key: string): Float32Array | undefined {
        const hit = this.entries.get(key)
        if (hit === undefined) return undefined
        this.entries.delete(key)
        this.entries.set(key, hit)
        return hit
    }

    set(key: string, vector: Float32Array): void {
        this.entries.set(key, vector)
        while (this.entries.size > QUERY_CACHE_LIMIT) {
            const oldest = this.entries.keys().next().value
            if (oldest === undefined) break
            this.entries.delete(oldest)
        }
    }

    get size(): number {
        return this.entries.size
    }
}

export interface SemanticDeps {
    config: MemoryConfig
    registry: StoreRegistry
    provider?: EmbeddingProvider | undefined
    cache?: QueryVectorCache
}

export interface SemanticOutcome {
    /** Similarity per record id, 0..1. */
    scores: Map<string, number>
    /** Records the semantic pass surfaced that lexical search did not return. */
    extraIds: string[]
    embedded: number
    used: boolean
    reason?: string
}

/**
 * Run the semantic half of a recall pass. Returns empty scores when disabled,
 * when lexical recall was already rich enough, or when the provider failed.
 */
export async function semanticRecall(
    deps: SemanticDeps,
    store: ScopeStore,
    query: string,
    lexicalHitCount: number,
    options: { signal?: AbortSignal } = {},
): Promise<SemanticOutcome> {
    const empty: SemanticOutcome = { scores: new Map(), extraIds: [], embedded: 0, used: false }
    const semantic = deps.config.semantic
    if (!semantic.enabled || deps.provider === undefined) return { ...empty, reason: 'semantic disabled' }
    if (lexicalHitCount >= semantic.minLexicalHits) return { ...empty, reason: 'lexical recall sufficient' }
    if (query.trim() === '') return { ...empty, reason: 'empty query' }
    // A scope with nothing to find must not cost a call: secondary roots (e.g.
    // the global store during a project session) are often empty.
    if (searchableRecords(store.db) === 0) return { ...empty, reason: 'no records to search' }

    const model = semantic.model
    let embedded = 0
    try {
        embedded = await ensureEmbeddings(store.db, deps.provider, model, {
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            limit: semantic.maxRecordsPerRun,
        })
    } catch (error) {
        log('debug', 'memory: embedding backfill failed:', error)
    }

    const cache = deps.cache ?? new QueryVectorCache()
    // A cheap deterministic key: the model plus the term set the caller searched.
    const key = `${model}|${extractTerms(query, 24).join(' ')}`
    let queryVector = cache.get(key)
    if (queryVector === undefined) {
        const vectors = await deps.provider.embed([query], options.signal)
        if (vectors === undefined || vectors[0] === undefined) {
            return { ...empty, embedded, reason: deps.provider.lastError() ?? 'embedding failed' }
        }
        queryVector = new Float32Array(vectors[0])
        cache.set(key, queryVector)
    }

    const vectors = loadVectors(store.db, model)
    if (vectors.size === 0) return { ...empty, embedded, reason: 'no vectors indexed' }
    const scores = similarityScores(vectors, queryVector)
    return { scores, extraIds: [], embedded, used: true }
}

/**
 * Blend lexical relevance with semantic similarity.
 *
 * `weight` 0 keeps pure lexical ranking; 1 would ignore it. Records found by
 * only one side still receive that side's contribution, which is what lets a
 * semantically related lesson surface without keyword overlap.
 */
export function blendRelevance(
    lexical: Map<string, number>,
    semantic: Map<string, number>,
    weight: number,
    minSimilarity: number,
): { relevance: Map<string, number>; semanticOnly: string[] } {
    const w = Math.min(1, Math.max(0, weight))
    const relevance = new Map<string, number>()
    const semanticOnly: string[] = []
    // Weight 0 is "lexical only": a semantic-only candidate must not even be
    // listed, otherwise it would ride into the candidate set with relevance 0.
    if (w === 0) return { relevance: new Map(lexical), semanticOnly }
    const ids = new Set<string>([...lexical.keys(), ...semantic.keys()])
    for (const id of ids) {
        const lex = lexical.get(id) ?? 0
        const sem = semantic.get(id) ?? 0
        if (lex === 0 && sem < minSimilarity) continue
        relevance.set(id, (1 - w) * lex + w * sem)
        if (lex === 0) semanticOnly.push(id)
    }
    return { relevance, semanticOnly }
}
