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
 * Groups this process is distilling *right now*, keyed by `sessionId\0turn`.
 *
 * A distillation call may run for `distillTimeoutMs` and only writes its audit
 * row at the very end, so for that entire window the group still *looks*
 * unattempted to `pending.ts`. Without this set a quiet turn in the same process
 * distils the same signals a second time: two audit rows, `times_seen=2`, and a
 * confidence the merge path raises without a single new piece of evidence —
 * exactly the "越学越自信" failure DESIGN §12 warns about.
 */
const inFlight = new Map<string, number>()

/** A mark may outlive its (hard-bounded) call by this much before it is stale. */
const IN_FLIGHT_GRACE_MS = 10_000

function distillationKey(sessionId: string, turn: number): string {
    return `${sessionId}\u0000${turn}`
}

/** Mark a group as being distilled; visible to `isDistilling` immediately. */
export function beginDistillation(sessionId: string, turn: number): void {
    inFlight.set(distillationKey(sessionId, turn), Date.now())
}

/** Clear the mark once the attempt settled (audit row written, or the job died). */
export function endDistillation(sessionId: string, turn: number): void {
    inFlight.delete(distillationKey(sessionId, turn))
}

/**
 * Whether this process is already distilling that group.
 *
 * `ttlMs` bounds how long a mark may outlive its distillation: a job that is
 * killed before its producer ever runs would otherwise hide the group from
 * recovery for the rest of the process's life.
 */
export function isDistilling(sessionId: string, turn: number, ttlMs: number): boolean {
    const key = distillationKey(sessionId, turn)
    const at = inFlight.get(key)
    if (at === undefined) return false
    if (Date.now() - at <= ttlMs) return true
    inFlight.delete(key)
    return false
}

/** How long an in-flight mark stays trustworthy, derived from the call bound. */
export function distillInFlightTtlMs(distillTimeoutMs: number): number {
    return Math.max(0, distillTimeoutMs) + IN_FLIGHT_GRACE_MS
}

/**
 * Run — or hand off — one turn's distillation according to
 * `learn.distillRunner`. Never throws: a failing job submission falls back to
 * the inline path.
 *
 * Both runners mark the group in flight for as long as it is being distilled —
 * for the jobs path that starts *before* `jobs.start`, because the job's own LLM
 * call is what makes the group look unattempted.
 */
export async function runDistillation(deps: RunnerDeps, request: RunnerRequest): Promise<RunnerResult> {
    const mode = request.mode ?? deps.config.learn.distillRunner
    if (mode === 'jobs') {
        const jobs = optionalJobs(deps.ctx)
        if (jobs !== undefined) {
            beginDistillation(request.sessionId, request.turn)
            try {
                const jobId = jobs.start({
                    kind: 'memory-distill',
                    label: `distil memory from turn ${request.turn} (${request.signals.length} signal(s))`,
                    ...(request.ownerAgent !== undefined ? { owner: request.ownerAgent } : {}),
                    run: () => startJob(deps, request),
                })
                return { mode: 'jobs', jobId }
            } catch (error) {
                endDistillation(request.sessionId, request.turn)
                log('warn', 'memory: job submission failed, falling back to inline distillation:', error)
            }
        } else {
            log('debug', 'memory: ctx.jobs unavailable — distilling inline')
        }
    }
    beginDistillation(request.sessionId, request.turn)
    try {
        const outcome = await distillTurn(
            { ctx: deps.ctx, config: deps.config, registry: deps.registry, resolver: deps.resolver, state: deps.state },
            request,
        )
        return { mode: 'inline', outcome }
    } finally {
        endDistillation(request.sessionId, request.turn)
    }
}

/** Producer hooks for one distillation job. */
function startJob(deps: RunnerDeps, request: RunnerRequest): {
    cancel(reason?: string): void
    done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }>
} {
    const controller = new AbortController()
    const promise = distillTurn(
        { ctx: deps.ctx, config: deps.config, registry: deps.registry, resolver: deps.resolver, state: deps.state },
        { ...request, signal: controller.signal },
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
        // A cancelled or crashed job must stop hiding its group from recovery.
        .finally(() => {
            endDistillation(request.sessionId, request.turn)
        })
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
