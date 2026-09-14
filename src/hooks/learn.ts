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
import { applyOutcome } from '../recall/usage.js'
import type { SessionState } from '../recall/session-state.js'
import { ScopeResolver, sessionIdOf } from '../scope/resolver.js'
import type { AgentLike } from '../scope/resolver.js'
import type { StoreRegistry } from '../store/store.js'
import { runDistillation } from '../learn/distill-runner.js'
import type { DistillOutcome } from '../learn/distill.js'
import { recordEpisode } from '../learn/episodic.js'
import { TurnLedger } from '../learn/ledger.js'
import { loadGroupSignals, pendingDistillations } from '../learn/pending.js'
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

/**
 * Pick up pain signals that were collected but never distilled — a job killed
 * with its agent on a one-shot surface, or a process that died mid-call.
 *
 * Runs off the session-start path, uses the *new* session's route/model, and is
 * naturally idempotent: any attempt writes a `distill` audit row, so a group is
 * retried until its first attempt and never again.
 */
export async function recoverPendingDistillations(
    deps: LearnDeps,
    agent: AgentLike | undefined,
    options: { budgetMs?: number } = {},
): Promise<number> {
    const startedAt = Date.now()
    const budgetMs = options.budgetMs ?? deps.config.learn.recoverBudgetMs
    const limit = deps.config.learn.maxRecoverPerSession
    if (limit <= 0 || !deps.config.learn.autoDistill) return 0
    if (!deps.resolver.mayWrite(agent)) return 0
    const store = deps.registry.open(deps.resolver.resolve({ agent }))
    if (store === undefined) return 0
    const sessionId = sessionIdOf(agent)
    // Deliberately *not* "exclude the current session": the nvim-tui runner
    // resumes the previous session, so the group that needs recovery often
    // belongs to this very session id. Guard by "the turn has ended" instead —
    // a group is recoverable when its turn is behind the turn this process has
    // observed, and it is old enough not to be mid-flight.
    const currentTurn = sessionId !== undefined ? deps.state.lastTurn(sessionId) : 0
    const groups = pendingDistillations(store.db, { limit: limit + 2, minAgeSeconds: 5 }).filter(
        (group) => !(sessionId !== undefined && currentTurn > 0 && group.sessionId === sessionId && group.turn >= currentTurn),
    )
    if (groups.length === 0) {
        log('debug', 'memory: no undistilled signals to recover')
        return 0
    }
    let recovered = 0
    for (const group of groups) {
        if (Date.now() - startedAt > budgetMs) {
            log('debug', `memory: recovery budget (${budgetMs}ms) reached — remaining groups stay pending`)
            break
        }
        const signals = loadGroupSignals(store.db, group)
        if (signals.length === 0) continue
        const runner = await runDistillation(
            { ctx: deps.ctx, config: deps.config, registry: deps.registry, resolver: deps.resolver, state: deps.state },
            {
                agent,
                sessionId: group.sessionId,
                turn: group.turn,
                signals,
                recalled: [],
                ...(agent !== undefined ? { ownerAgent: agent } : {}),
                mode: 'inline',
            },
        )
        if (runner.outcome !== undefined && runner.outcome.status !== 'skipped') {
            recovered += 1
            log(
                'info',
                `memory: recovered ${signals.length} undistilled signal(s) from session ${group.sessionId.slice(0, 18)}… turn ${group.turn} → ${runner.outcome.status}`,
            )
        }
    }
    return recovered
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
                    ...(typeof exec.name === 'string' ? { tool: exec.name } : {}),
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

/**
 * Attribute an outcome in *every* open store that has unattributed usage rows
 * for this session and turn.
 *
 * Recall writes its usage rows into the store a record came from, so a turn that
 * injected both project and global memories has rows in two databases. Only
 * attributing the session's own store left global memory permanently
 * unattributed — its use-weight could never rise, and DESIGN §7's "a memory that
 * failed after recall loses confidence" never applied to it.
 */
function attributeAcrossRoots(
    deps: LearnDeps,
    sessionId: string,
    outcome: 'success' | 'failure',
    turn: number,
): number {
    let attributed = 0
    for (const candidate of deps.registry.listOpen()) {
        try {
            attributed += applyOutcome(candidate.db, sessionId, outcome, turn)
        } catch (error) {
            log('debug', 'memory: outcome attribution failed for a root:', error)
        }
    }
    return attributed
}

/** One recovery pass per scope per process (see pending.ts). */
const recoveredScopes = new Set<string>()

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
        // Recovery rides a *quiet* turn: the store is open, the agent is alive,
        // and it never stacks on top of this turn's own distillation (whose
        // result the user is waiting for). Once per scope per process, and
        // wall-clock bounded so a debt of groups cannot stall turn closure.
        if (deps.config.learn.autoDistill && !recoveredScopes.has(store.scope.root)) {
            recoveredScopes.add(store.scope.root)
            try {
                await recoverPendingDistillations(deps, payload.agent)
            } catch (error) {
                log('warn', 'memory: pending-distillation recovery failed:', error)
            }
        }
        // A quiet turn that did real work counts as evidence the recalled
        // memory did not mislead: attribute success, raise its weight.
        if (ledger.recalled > 0 && ledger.toolCalls > 0) {
            try {
                attributeAcrossRoots(deps, sessionId, 'success', turn)
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
        captureUserText: deps.config.episodic.captureUserText,
    })
    try {
        attributeAcrossRoots(deps, sessionId, 'failure', turn)
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
