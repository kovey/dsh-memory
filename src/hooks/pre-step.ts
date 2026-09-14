/**
 * `agent/pre-step` recall hook (DESIGN §4, §6).
 *
 * Runs the zero-LLM half of the learning flywheel: on the first step of a turn
 * it searches project + global memory for the incoming task and injects what it
 * finds as a plugin-sourced user message — a *logged* channel, so what the model
 * saw is exactly what the session log records.
 *
 * Guarantees: threshold floor, token budget, per-session idempotence, and a
 * total try/catch (a recall failure must never disturb the step).
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { MemoryConfig } from '../config.js'
import { log } from '../log.js'
import { ScopeResolver } from '../scope/resolver.js'
import type { AgentLike } from '../scope/resolver.js'
import { sessionIdOf } from '../scope/resolver.js'
import { recordRecalls } from '../recall/usage.js'
import type { UsageRow } from '../recall/usage.js'
import { recall, renderRecallPack } from '../recall/engine.js'
import type { RecallHit } from '../recall/engine.js'
import { buildQuery, isMemoryMessage, MEMORY_PLUGIN_ID } from '../recall/query.js'
import type { MessageLike } from '../recall/query.js'
import type { SessionState } from '../recall/session-state.js'
import type { StoreRegistry } from '../store/store.js'
import type { TurnLedger } from '../learn/ledger.js'
import type { EmbeddingProvider, QueryVectorCache } from '../recall/semantic.js'
import { detectCorrection } from '../learn/signals.js'
import type { SignalBuffer } from '../learn/signals.js'

export interface RecallHookDeps {
    config: MemoryConfig
    registry: StoreRegistry
    resolver: ScopeResolver
    state: SessionState
    /** Present when signal collection is wired (M2). */
    signals?: SignalBuffer
    ledger?: TurnLedger
    /** Optional semantic recall runtime (absent = lexical only). */
    semantic?: { provider?: EmbeddingProvider | undefined; cache?: QueryVectorCache } | undefined
}

interface PreStepPayload {
    agent?: AgentLike
    messages?: readonly UserMessage[]
    turn?: number
    step?: number
    signal?: AbortSignal
}

/** Build the pre-step middleware. */
export function createPreStepHook(deps: RecallHookDeps) {
    return async (payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
        const decision = await next()
        try {
            return await injectRecall(deps, payload, decision)
        } catch (error) {
            log('error', 'memory: pre-step recall failed:', error)
            return decision
        }
    }
}

async function injectRecall(deps: RecallHookDeps, payload: PreStepPayload, decision: PreStepDecision): Promise<PreStepDecision> {
    if (decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
    const admitted: readonly UserMessage[] = decision.messages
    const config = deps.config
    if (!config.recall.autoInject) return decision
    // Only the first step of a turn carries new user input; later steps are
    // tool continuations that already have the pack in context.
    if ((payload.step ?? 1) > 1) return decision
    if (payload.signal?.aborted === true) return decision

    const messages = admitted as readonly MessageLike[]
    if (messages.some((message) => isMemoryMessage(message))) return decision

    const query = buildQuery(messages)
    if (query.terms.length === 0) return decision

    const sessionId = sessionIdOf(payload.agent)
    noteUserCorrection(deps, payload, sessionId, query.text)
    const outcome = await recall(deps, {
        agent: payload.agent,
        terms: query.terms,
        text: query.text,
        ...(payload.signal !== undefined ? { signal: payload.signal } : {}),
        exclude: (id) => sessionId !== undefined && deps.state.hasInjected(sessionId, id),
    })
    if (outcome.hits.length === 0) {
        log('debug', `memory: recall miss for "${query.text.slice(0, 60)}" (considered ${outcome.considered})`)
        return decision
    }

    const text = renderRecallPack(outcome.hits, outcome.dropped)
    const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: {
            kind: 'plugin',
            plugin: MEMORY_PLUGIN_ID,
            form: 'notice',
            summary: `记忆召回：${outcome.hits.length} 条`,
        },
    })

    recordUsage(deps, outcome.hits, { sessionId, turn: payload.turn, step: payload.step })
    if (sessionId !== undefined) {
        deps.state.markInjected(sessionId, outcome.hits.map((hit) => hit.record.id))
        if (payload.turn !== undefined) {
            deps.state.observeTurn(sessionId, payload.turn)
            deps.ledger?.noteRecalled(sessionId, payload.turn, outcome.hits.length)
        }
    }

    log(
        'info',
        `memory: injected ${outcome.hits.length} record(s) (~${outcome.tokensUsed} tok) turn ${payload.turn ?? '?'} step ${payload.step ?? '?'} → ${outcome.hits.map((hit) => hit.record.id).join(', ')}`,
    )
    return {
        kind: 'enter',
        messages: [message as UserMessage, ...admitted],
        ...(decision.startsRequestSeries === true ? { startsRequestSeries: true as const } : {}),
    }
}

/**
 * A user message that reads as a correction is the strongest cheap signal that
 * something went wrong. Recording it here costs nothing and is what lets the
 * turn-end handler decide to distil.
 */
function noteUserCorrection(
    deps: RecallHookDeps,
    payload: PreStepPayload,
    sessionId: string | undefined,
    text: string,
): void {
    if (sessionId === undefined || payload.turn === undefined || deps.signals === undefined) return
    const marker = detectCorrection(text)
    if (marker === undefined) return
    deps.ledger?.noteCorrection(sessionId, payload.turn)
    deps.signals.add({
        sessionId,
        kind: 'user-correction',
        turn: payload.turn,
        ...(payload.step !== undefined ? { step: payload.step } : {}),
        detail: `用户纠正信号「${marker}」：${text.slice(0, 160)}`,
        at: new Date().toISOString(),
    })
    log('info', `memory: user-correction signal recorded (marker "${marker}") turn ${payload.turn}`)
}

function recordUsage(
    deps: RecallHookDeps,
    hits: readonly RecallHit[],
    context: { sessionId?: string | undefined; turn?: number | undefined; step?: number | undefined },
): void {
    const rowsByRoot = new Map<string, UsageRow[]>()
    for (const hit of hits) {
        const rows = rowsByRoot.get(hit.scope.root) ?? []
        rows.push({
            recordId: hit.record.id,
            ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
            ...(context.turn !== undefined ? { turn: context.turn } : {}),
            ...(context.step !== undefined ? { step: context.step } : {}),
            score: hit.score,
        })
        rowsByRoot.set(hit.scope.root, rows)
    }
    for (const [root, rows] of rowsByRoot) {
        const store = deps.registry.listOpen().find((candidate) => candidate.scope.root === root)
        if (store === undefined) continue
        try {
            recordRecalls(store.db, rows)
        } catch (error) {
            log('warn', `memory: usage bookkeeping failed for ${root}:`, error)
        }
    }
}
