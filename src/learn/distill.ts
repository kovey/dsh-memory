/**
 * Bounded automatic distillation (DESIGN §4.2, §7).
 *
 * The only path in this plugin that spends money, so every guardrail is
 * deliberate: pain-signal turns only, a fixed cheap model, a hard wall-clock
 * timeout, per-session and per-day caps, full audit rows, and a write gate on
 * everything that comes back. A timeout or a bad model answer costs nothing but
 * a log line — the signals stay in L1 for the skill-based fallback path.
 */
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { DatabaseSync } from 'node:sqlite'
import type { MemoryConfig } from '../config.js'
import { log } from '../log.js'
import { estimateTokens } from '../recall/rank.js'
import type { SessionState } from '../recall/session-state.js'
import { ScopeResolver } from '../scope/resolver.js'
import type { AgentLike } from '../scope/resolver.js'
import type { StoreRegistry, ScopeStore } from '../store/store.js'
import type { Evidence, MemoryScope } from '../store/types.js'
import { applyDraft } from './gate.js'
import type { CandidateDraft } from './gate.js'
import { candidateConfidence } from './confidence.js'
import { optionalLlm } from './llm-access.js'
import { redact } from './redact.js'
import type { Signal } from './signals.js'

export interface DistillDeps {
    ctx: Context
    config: MemoryConfig
    registry: StoreRegistry
    resolver: ScopeResolver
    state: SessionState
}

export interface DistillRequest {
    agent?: AgentLike | undefined
    sessionId: string
    turn: number
    signals: readonly Signal[]
    recalled: readonly string[]
}

export interface DistillOutcome {
    status: 'created' | 'merged' | 'rejected' | 'skipped' | 'timeout' | 'error'
    created: number
    merged: number
    rejected: number
    tokensIn: number
    tokensOut: number
    reason?: string
    recordIds: string[]
}

const SYSTEM_PROMPT = [
    '你是 DSH 记忆蒸馏器：把一轮任务中的客观疼痛信号（工具失败、模型请求失败、用户纠正）提炼为可复用的经验教训。',
    '只输出严格 JSON 数组，不要输出任何其他文字。每个元素：',
    '{"title": "一句话教训标题", "body": "触发场景 + 正确做法（含关键命令/参数/文件路径）", "confidence": 0.5到0.85之间的数字, "tags": ["关键词"]}',
    '规则：',
    '1. 只写有信号证据支持的教训；只是猜测或泛泛而谈 → 返回 []。',
    '2. body 必须包含「什么情况下会遇到」与「应当怎么做」，禁止写「要注意」「要小心」这类空话。',
    '3. 不得臆造信号中未出现的事实、命令或结论。',
    '4. 最多 3 条，宁缺毋滥。',
].join('\n')

const MAX_SIGNALS_IN_PROMPT = 8

export interface ModelRoute {
    provider: string
    model: string
}

/**
 * Which route the distillation call uses.
 *
 * An explicit `learn.distillModel` wins; otherwise the session's own route is
 * inherited, so the plugin follows the user's existing configuration instead of
 * asking for a second set of LLM settings. `undefined` = no route available at
 * all, and distillation is skipped (signals stay in L1).
 */
export function resolveDistillRoute(config: MemoryConfig, agent: AgentLike | undefined): ModelRoute | undefined {
    const explicit = config.learn.distillModel
    if (explicit.provider !== '' && explicit.model !== '') return explicit
    const options = (agent as { options?: { provider?: unknown; model?: unknown } } | undefined)?.options
    const provider = typeof options?.provider === 'string' ? options.provider : ''
    const model = typeof options?.model === 'string' ? options.model : ''
    if (provider !== '' && model !== '') return { provider, model }
    return undefined
}

/** Today's distillation spend, in estimated tokens. */
export function dailyDistillTokens(db: DatabaseSync, now = new Date()): number {
    const start = new Date(now.getTime() - (now.getTime() % 86_400_000)).toISOString()
    const row = db
        .prepare('SELECT COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)), 0) AS n FROM distill WHERE at >= ?')
        .get(start)
    const value = row?.['n']
    if (typeof value === 'number') return value
    if (typeof value === 'bigint') return Number(value)
    return 0
}

/** Whether this turn may spend an LLM call at all (DESIGN §4.2). */
export function distillAllowed(deps: DistillDeps, request: DistillRequest): { allowed: boolean; reason?: string } {
    const learn = deps.config.learn
    if (!learn.autoDistill) return { allowed: false, reason: 'autoDistill disabled' }
    if (request.signals.length < Math.max(1, learn.minSignals)) return { allowed: false, reason: 'no pain signals' }
    if (!deps.resolver.mayWrite(request.agent)) return { allowed: false, reason: 'subagent sessions do not author memory' }
    const budget = deps.state.distillBudget(request.sessionId)
    if (budget.runs >= learn.maxDistillPerSession) return { allowed: false, reason: 'session distillation budget exhausted' }
    const store = deps.registry.open(deps.resolver.resolve({ agent: request.agent }))
    if (store === undefined) return { allowed: false, reason: 'memory store unavailable' }
    if (optionalLlm(deps.ctx) === undefined) return { allowed: false, reason: 'llm service unavailable' }
    if (resolveDistillRoute(deps.config, request.agent) === undefined) {
        return { allowed: false, reason: 'no model route available' }
    }
    if (dailyDistillTokens(store.db) >= learn.maxDistillTokensPerDay) {
        return { allowed: false, reason: 'daily token budget exhausted' }
    }
    return { allowed: true }
}

/** Distil one painful turn into gated memory records. */
export async function distillTurn(deps: DistillDeps, request: DistillRequest): Promise<DistillOutcome> {
    const skip: DistillOutcome = { status: 'skipped', created: 0, merged: 0, rejected: 0, tokensIn: 0, tokensOut: 0, recordIds: [] }
    const gate = distillAllowed(deps, request)
    if (!gate.allowed) {
        log('debug', `memory: distillation skipped (${gate.reason ?? 'unknown'})`)
        return { ...skip, reason: gate.reason }
    }
    const store = deps.registry.open(deps.resolver.resolve({ agent: request.agent }))
    if (store === undefined) return { ...skip, reason: 'memory store unavailable' }
    const llm = optionalLlm(deps.ctx)
    if (llm === undefined) {
        log('debug', 'memory: distillation skipped — no LLM service in this composition')
        return { ...skip, reason: 'llm service unavailable' }
    }
    const route = resolveDistillRoute(deps.config, request.agent)
    if (route === undefined) {
        log('debug', 'memory: distillation skipped — no model route (session has none and learn.distillModel is empty)')
        return { ...skip, reason: 'no model route available' }
    }

    const prompt = buildPrompt(request)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), deps.config.learn.distillTimeoutMs)
    let text = ''
    let timedOut = false
    let finishNote: string | undefined
    const callStartedAt = Date.now()
    try {
        const assembler = new BlockAssembler()
        const stream = llm.stream({
            provider: route.provider,
            model: route.model,
            messages: [
                createUserMessage({
                    content: [{ type: 'text', text: prompt }],
                    source: { kind: 'plugin', plugin: 'dsh-memory', form: 'notice', summary: '记忆蒸馏输入' },
                }),
            ],
            system: SYSTEM_PROMPT,
            maxTokens: deps.config.learn.distillMaxTokens,
            ...(deps.config.learn.distillReasoningEffort !== ''
                ? { reasoningEffort: ReasoningEffortId(deps.config.learn.distillReasoningEffort) }
                : {}),
            // The route field is branded by the harness; the value is the raw id.
            sessionId: request.sessionId as unknown as NonNullable<GenerateOptions['sessionId']>,
            signal: controller.signal,
        })
        for await (const chunk of stream) assembler.push(chunk)
        // The runtime normalizes an adapter failure into a terminal `finish`
        // chunk instead of throwing, so an empty answer must be diagnosed from
        // the finish reason or it looks like "the model said nothing".
        const finish: unknown = assembler.finish
        // Our own deadline aborts the call; the runtime reports that as a
        // terminal `aborted` finish rather than a throw, so the timeout has to
        // be recognized here too.
        if (controller.signal.aborted) timedOut = true
        const finishKind =
            finish !== null && typeof finish === 'object' && 'kind' in finish
                ? String((finish as { kind?: unknown }).kind)
                : String(finish)
        if (finishKind !== 'stop') {
            const failure =
                finish !== null && typeof finish === 'object' && 'failure' in finish
                    ? (finish as { failure?: { code?: string; message?: string } }).failure
                    : undefined
            finishNote =
                finishKind === 'max-tokens'
                    ? `model hit maxTokens ${deps.config.learn.distillMaxTokens} (reasoning tokens count) — raise learn.distillMaxTokens`
                    : `${finishKind}${failure !== undefined ? `: ${failure.code ?? ''} ${failure.message ?? ''}`.trimEnd() : ''}`
            log('warn', `memory: distillation model call ended with ${finishNote}`)
        }
        text = assembler
            .blocks()
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n')
    } catch (error) {
        timedOut = controller.signal.aborted
        log('warn', `memory: distillation ${timedOut ? 'timed out' : 'failed'}:`, error)
    } finally {
        clearTimeout(timer)
    }

    const tokensIn = estimateTokens(prompt) + estimateTokens(SYSTEM_PROMPT)
    const tokensOut = estimateTokens(text)
    deps.state.chargeDistill(request.sessionId, tokensIn + tokensOut)

    if (text.trim() === '') {
        audit(store.db, request, `${route.provider}/${route.model}`, tokensIn, tokensOut, 0, timedOut)
        const reason = timedOut
            ? `distillation timed out after ${Date.now() - callStartedAt}ms (limit ${deps.config.learn.distillTimeoutMs}ms)`
            : (finishNote ?? 'model returned no text')
        log('warn', `memory: distillation produced nothing (${reason})`)
        return {
            ...skip,
            status: timedOut ? 'timeout' : 'error',
            tokensIn,
            tokensOut,
            reason,
        }
    }

    const candidates = parseCandidates(text)
    const evidence = evidenceFromSignals(request.signals)
    let created = 0
    let merged = 0
    let rejected = 0
    const recordIds: string[] = []
    for (const candidate of candidates) {
        const draft: CandidateDraft = {
            title: candidate.title,
            body: candidate.body,
            confidence: candidateConfidence(candidate.confidence, evidence.length),
            tags: candidate.tags,
            evidence,
            origin: 'distilled',
            source: { sessionId: request.sessionId, turn: request.turn },
        }
        const result = applyDraft(store.db, store.scope, store.fts5, draft)
        if (result.action === 'reject') rejected += 1
        else {
            recordIds.push(result.recordId)
            if (result.action === 'merge') merged += 1
            else created += 1
        }
    }
    audit(store.db, request, `${route.provider}/${route.model}`, tokensIn, tokensOut, created + merged, timedOut)
    if (created + merged > 0) {
        deps.registry.exportScope(store.scope)
        log(
            'info',
            `memory: distilled ${created} new + ${merged} merged record(s) from turn ${request.turn} via ${route.provider}/${route.model}`,
        )
    }
    return {
        status: created > 0 ? 'created' : merged > 0 ? 'merged' : 'rejected',
        created,
        merged,
        rejected,
        tokensIn,
        tokensOut,
        recordIds,
    }
}

/** Compact, redacted digest of one turn's signals. */
export function buildPrompt(request: DistillRequest): string {
    const lines = [`会话: ${request.sessionId}`, `轮次: ${request.turn}`, '疼痛信号:']
    request.signals.slice(0, MAX_SIGNALS_IN_PROMPT).forEach((signal, index) => {
        const parts = [`${index + 1}. [${signal.kind}]`]
        if (signal.tool !== undefined) parts.push(`tool=${signal.tool}`)
        if (signal.detail !== undefined) parts.push(`detail=${redact(signal.detail, 'redacted', 240)}`)
        lines.push(parts.join(' '))
    })
    if (request.recalled.length > 0) {
        lines.push('', `本轮自动召回的记忆: ${request.recalled.join(', ')}（若这些记忆未能避免上述问题，说明它们不完整或已过时）`)
    }
    return lines.join('\n')
}

export interface ParsedCandidate {
    title: string
    body: string
    confidence: number
    tags: string[]
}

/** Tolerant JSON extraction: models sometimes wrap the array in prose/fences. */
export function parseCandidates(text: string): ParsedCandidate[] {
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start === -1 || end <= start) return []
    let parsed: unknown
    try {
        parsed = JSON.parse(text.slice(start, end + 1))
    } catch {
        return []
    }
    if (!Array.isArray(parsed)) return []
    const out: ParsedCandidate[] = []
    for (const item of parsed) {
        if (item === null || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        const title = typeof record['title'] === 'string' ? record['title'].trim() : ''
        const body = typeof record['body'] === 'string' ? record['body'].trim() : ''
        if (title === '' || body === '') continue
        const rawConfidence = typeof record['confidence'] === 'number' ? record['confidence'] : 0.6
        const tags = Array.isArray(record['tags'])
            ? record['tags'].filter((tag): tag is string => typeof tag === 'string').slice(0, 6)
            : []
        out.push({
            title: title.slice(0, 120),
            body: body.slice(0, 1_500),
            confidence: Math.min(0.85, Math.max(0.4, rawConfidence)),
            tags,
        })
        if (out.length >= 3) break
    }
    return out
}

/** Objective evidence attached to every distilled record. */
export function evidenceFromSignals(signals: readonly Signal[]): Evidence[] {
    const out: Evidence[] = []
    const seen = new Set<string>()
    for (const signal of signals) {
        const key = `${signal.kind}|${signal.detail ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
            kind: signal.kind,
            ...(signal.detail !== undefined ? { detail: redact(signal.detail, 'redacted', 200) } : {}),
            ...(signal.turn !== undefined ? { turn: signal.turn } : {}),
            at: signal.at,
        })
        if (out.length >= 5) break
    }
    return out
}

function audit(
    db: DatabaseSync,
    request: DistillRequest,
    resolvedRoute: string,
    tokensIn: number,
    tokensOut: number,
    created: number,
    timedOut: boolean,
): void {
    try {
        db.prepare(
            'INSERT INTO distill (session_id, turn, model, prompt_hash, tokens_in, tokens_out, created_count, timed_out, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
            request.sessionId,
            request.turn,
            `${resolvedRoute}`,
            hashish(buildPrompt(request)),
            tokensIn,
            tokensOut,
            created,
            timedOut ? 1 : 0,
            new Date().toISOString(),
        )
    } catch (error) {
        log('warn', 'memory: distill audit row failed:', error)
    }
}

function hashish(text: string): string {
    let hash = 0
    for (let i = 0; i < text.length; i += 1) {
        hash = (hash * 31 + text.charCodeAt(i)) | 0
    }
    return (hash >>> 0).toString(16)
}

/** Scope helper for callers that already resolved a store. */
export function scopeOf(store: ScopeStore): MemoryScope {
    return store.scope
}
