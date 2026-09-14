/**
 * Distillation runners (DESIGN §4.2, §14.3).
 *
 * Two ways to spend the one bounded LLM call a painful turn earns:
 *
 *   inline — awaited inside `agent/turn-stopping` with a hard timeout. Simple,
 *            and the turn cannot close mid-write; it delays turn closure by at
 *            most `distillTimeoutMs`.
 *   jobs   — handed to `ctx.jobs` (mounted by dsh-base as `dsh-jobs-local`), so
 *            the turn closes immediately and the work is visible in the job
 *            list and cancelled automatically when its owner agent is disposed.
 *
 * Neither runner survives process exit — that is why the signals are written to
 * L1 *before* distillation starts, so a skill can still distil them later.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryConfig } from '../config.js'
import { log } from '../log.js'
import type { SessionState } from '../recall/session-state.js'
import type { ScopeResolver } from '../scope/resolver.js'
import type { AgentLike } from '../scope/resolver.js'
import type { StoreRegistry } from '../store/store.js'
import { distillTurn } from './distill.js'
import type { DistillOutcome, DistillRequest } from './distill.js'
import type { Signal } from './signals.js'

/**
 * The jobs service is optional (it is mounted by dsh-base, but this plugin must
 * keep working without it), so it is reached structurally through `ctx.reflect`
 * instead of an `inject` dependency — the same pattern the vision bridge uses for
 * the attachment service.
 */
/** Minimal structural view of the optional jobs service. */
interface JobsLike {
    start(spec: {
        kind: 'memory-distill'
        label: string
        owner?: unknown
        run(): { cancel(reason?: string): void; done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }> }
    }): string
}

export interface RunnerDeps {
    ctx: Context
    config: MemoryConfig
    registry: StoreRegistry
    resolver: ScopeResolver
    state: SessionState
}

export interface RunnerRequest extends DistillRequest {
    /** Live agent that owns the work, when the caller has one. */
    ownerAgent?: unknown
    /**
     * Force a runner for this call. Recovery passes `inline`: a recovered group
     * was *lost by a cancelled job*, so handing it to another job on the same
     * one-shot surface would lose it again (and silently — the job dies before
     * it can write an audit row).
     */
    mode?: 'inline' | 'jobs'
}

export interface RunnerResult {
    mode: 'inline' | 'jobs' | 'skipped'
    /** Present for the inline path (and for jobs that already settled). */
    outcome?: DistillOutcome
    jobId?: string
    reason?: string
}

/** Optional service lookup that never throws and never requires inject. */
export function optionalJobs(ctx: Context): JobsLike | undefined {
    try {
        const reflect = (ctx as unknown as { reflect?: { get?: (name: string, strict?: boolean) => unknown } }).reflect
        const jobs = reflect?.get?.('jobs', false)
        if (jobs === undefined || jobs === null) return undefined
        if (typeof (jobs as JobsLike).start !== 'function') return undefined
        return jobs as JobsLike
    } catch {
        return undefined
    }
}

/**
 * Run — or hand off — one turn's distillation according to
 * `learn.distillRunner`. Never throws: a failing job submission falls back to
 * the inline path.
 */
export async function runDistillation(deps: RunnerDeps, request: RunnerRequest): Promise<RunnerResult> {
    const mode = request.mode ?? deps.config.learn.distillRunner
    if (mode === 'jobs') {
        const jobs = optionalJobs(deps.ctx)
        if (jobs !== undefined) {
            try {
                const jobId = jobs.start({
                    kind: 'memory-distill',
                    label: `distil memory from turn ${request.turn} (${request.signals.length} signal(s))`,
                    ...(request.ownerAgent !== undefined ? { owner: request.ownerAgent } : {}),
                    run: () => startJob(deps, request),
                })
                return { mode: 'jobs', jobId }
            } catch (error) {
                log('warn', 'memory: job submission failed, falling back to inline distillation:', error)
            }
        } else {
            log('debug', 'memory: ctx.jobs unavailable — distilling inline')
        }
    }
    const outcome = await distillTurn(
        { ctx: deps.ctx, config: deps.config, registry: deps.registry, resolver: deps.resolver, state: deps.state },
        request,
    )
    return { mode: 'inline', outcome }
}

/** Producer hooks for one distillation job. */
function startJob(deps: RunnerDeps, request: RunnerRequest): {
    cancel(reason?: string): void
    done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }>
} {
    const controller = new AbortController()
    const promise = distillTurn(
        { ctx: deps.ctx, config: deps.config, registry: deps.registry, resolver: deps.resolver, state: deps.state },
        request,
    )
        .then((outcome) => {
            log('info', `memory: job distillation finished (${outcome.status}, +${outcome.created}/~${outcome.merged})`)
            return {
                status: (outcome.status === 'error' ? 'failed' : 'completed') as 'completed' | 'failed',
                detail: `${outcome.status}: +${outcome.created} new, ~${outcome.merged} merged, -${outcome.rejected} rejected`,
                output: outcome.recordIds.join(', '),
            }
        })
        .catch((error: unknown) => ({
            status: 'failed' as const,
            detail: error instanceof Error ? error.message : String(error),
        }))
    return {
        cancel: (reason?: string) => {
            log('debug', `memory: distillation job cancelled${reason !== undefined ? ` (${reason})` : ''}`)
            controller.abort()
        },
        done: promise,
    }
}

/** Signals available for a fallback distillation by a skill. */
export interface DeferredSignals {
    sessionId: string
    turn: number
    signals: Signal[]
}
