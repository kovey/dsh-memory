/**
 * Learning hooks (DESIGN §4.1, §7): the "Observe → Distill → Gate → Consolidate"
 * half of the flywheel.
 *
 * Everything except distillation itself is zero-cost; distillation is skipped
 * entirely for turns without pain signals.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { MemoryConfig } from '../config.js'
import { log } from '../log.js'
import { attributeOutcome } from '../recall/usage.js'
import type { SessionState } from '../recall/session-state.js'
import { ScopeResolver, sessionIdOf } from '../scope/resolver.js'
import type { AgentLike } from '../scope/resolver.js'
import type { StoreRegistry } from '../store/store.js'
import { runDistillation } from '../learn/distill-runner.js'
import type { DistillOutcome } from '../learn/distill.js'
import { recordEpisode } from '../learn/episodic.js'
import { TurnLedger } from '../learn/ledger.js'
import { detectResultFailure } from '../learn/signals.js'
import type { Signal, SignalBuffer, SignalKind } from '../learn/signals.js'

export interface LearnDeps {
    ctx: Context
    config: MemoryConfig
    registry: StoreRegistry
    resolver: ScopeResolver
    state: SessionState
    signals: SignalBuffer
    ledger: TurnLedger
}

interface ToolExecLike {
    name?: string
    agent?: { session?: { id?: string } }
}

interface ToolResultLike {
    isError?: boolean
    content?: unknown
}

/** Register tool-result, request-error and turn-stopping listeners. */
export function registerLearnHooks(ctx: Context, deps: LearnDeps): (() => void)[] {
    const disposers: (() => void)[] = []

    if (deps.config.learn.collectSignals) {
        const onToolResult = (exec: ToolExecLike, result: ToolResultLike): undefined => {
            try {
                const sessionId = exec?.agent?.session?.id
                if (typeof sessionId !== 'string') return undefined
                const turn = deps.state.lastTurn(sessionId)
                // A non-zero exit is not a tool error in this harness, so the
                // failure has to be read out of the content (see signals.ts).
                const failure = detectResultFailure(contentText(result?.content), {
                    isError: result?.isError === true,
                    exitCodeMode: deps.config.learn.exitCodeSignals,
                })
                deps.ledger.noteToolCall(sessionId, turn, failure !== undefined)
                if (failure === undefined) return undefined

                const tool = typeof exec.name === 'string' ? exec.name : undefined
                deps.signals.add({
                    sessionId,
                    kind: failure.kind as SignalKind,
                    turn,
                    ...(tool !== undefined ? { tool } : {}),
                    detail: failure.detail,
                    at: new Date().toISOString(),
                })
                // The same tool failing twice in one turn is a rework loop, which
                // is stronger evidence than either failure alone.
                if (tool !== undefined) {
                    const repeats = deps.signals
                        .peek(sessionId, turn)
                        .filter((signal) => signal.tool === tool && signal.kind !== 'rework').length
                    if (repeats >= 2) {
                        deps.signals.add({
                            sessionId,
                            kind: 'rework',
                            turn,
                            tool,
                            detail: `${tool} failed ${repeats}× in one turn`,
                            at: new Date().toISOString(),
                        })
                        log('info', `memory: rework signal recorded (${tool} ×${repeats}) turn ${turn}`)
                    }
                }
            } catch (error) {
                log('debug', 'memory: tool result observation failed:', error)
            }
            return undefined
        }
        ctx.on('tools/result', onToolResult)
    }

    const onRequestError = async (
        payload: { agent?: AgentLike; turn?: number; failure?: { code?: string; message?: string } },
        next: () => Promise<RequestErrorAction>,
    ): Promise<RequestErrorAction> => {
        const action = await next()
        try {
            if (!deps.config.learn.collectSignals) return action
            const sessionId = sessionIdOf(payload?.agent)
            if (sessionId === undefined) return action
            deps.signals.add({
                sessionId,
                kind: 'request-error',
                turn: payload.turn ?? deps.state.lastTurn(sessionId),
                ...(payload.failure?.code !== undefined ? { detail: payload.failure.code } : {}),
                at: new Date().toISOString(),
            })
        } catch (error) {
            log('debug', 'memory: request-error observation failed:', error)
        }
        return action
    }
    ctx.on('agent/request-error', onRequestError)

    const onTurnStopping = async (payload: { agent?: AgentLike; turn?: number; signal?: AbortSignal }): Promise<void> => {
        const started = Date.now()
        const signal = payload?.signal
        // Diagnostic: a turn-scoped abort during this await explains an LLM call
        // that reports "aborted by caller" while our own controller is live.
        const onAbort = (): void => {
            log('warn', `memory: turn ${payload.turn ?? '?'} signal aborted after ${Date.now() - started}ms (distillation may be cancelled with it)`)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        try {
            if (signal?.aborted === true) log('warn', `memory: turn-stopping entered with an already-aborted signal (turn ${payload.turn ?? '?'})`)
            await handleTurnEnd(deps, payload)
            log('debug', `memory: turn ${payload.turn ?? '?'} learning finished in ${Date.now() - started}ms`)
        } catch (error) {
            log('error', 'memory: turn-end learning failed:', error)
        } finally {
            signal?.removeEventListener('abort', onAbort)
        }
    }
    ctx.on('agent/turn-stopping', onTurnStopping)

    return disposers
}

async function handleTurnEnd(deps: LearnDeps, payload: { agent?: AgentLike; turn?: number }): Promise<void> {
    const sessionId = sessionIdOf(payload?.agent)
    const turn = payload?.turn
    if (sessionId === undefined || turn === undefined) return

    const ledger = deps.ledger.take(sessionId, turn)
    const collected = deps.signals.take(sessionId, turn)
    const store = deps.registry.open(deps.resolver.resolve({ agent: payload.agent }))
    if (store === undefined) return

    if (!deps.config.learn.collectSignals) {
        // learning disabled: only keep the session counters tidy
        deps.signals.forget(sessionId)
        return
    }

    if (collected.signals.length === 0) {
        // A quiet turn that did real work counts as evidence the recalled
        // memory did not mislead: attribute success, raise its weight.
        if (ledger.recalled > 0 && ledger.toolCalls > 0) {
            try {
                attributeOutcome(store.db, sessionId, 'success', turn)
            } catch (error) {
                log('debug', 'memory: success attribution failed:', error)
            }
        }
        return
    }

    recordEpisode(store.db, store.scope, {
        sessionId,
        turn,
        signals: collected.signals,
        verdict: 'failure',
        recalled: [],
    })
    try {
        attributeOutcome(store.db, sessionId, 'failure', turn)
    } catch (error) {
        log('debug', 'memory: failure attribution failed:', error)
    }

    const runner = await runDistillation(
        {
            ctx: deps.ctx,
            config: deps.config,
            registry: deps.registry,
            resolver: deps.resolver,
            state: deps.state,
        },
        {
            agent: payload.agent,
            sessionId,
            turn,
            signals: collected.signals,
            recalled: [],
            ownerAgent: payload.agent,
        },
    )
    if (runner.mode === 'jobs') {
        log('info', `memory: turn ${turn} distillation handed to job ${runner.jobId ?? '?'} (${collected.signals.length} signal(s))`)
        return
    }
    if (runner.outcome !== undefined) logOutcome(turn, collected.signals.length, runner.outcome)
}

function logOutcome(turn: number, signalCount: number, outcome: DistillOutcome): void {
    if (outcome.status === 'skipped') return
    log(
        'info',
        `memory: turn ${turn} learning — ${signalCount} signal(s), distill=${outcome.status} (+${outcome.created}/~${outcome.merged}/-${outcome.rejected}, ${outcome.tokensIn + outcome.tokensOut} tok)`,
    )
}

/** Read the text of a tool result's content blocks. */
export function contentText(content: unknown): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    const parts: string[] = []
    for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        const record = block as { type?: unknown; text?: unknown }
        if (typeof record.text === 'string') parts.push(record.text)
    }
    return parts.join(' ')
}

export type { Signal }
