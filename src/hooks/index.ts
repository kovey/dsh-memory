/**
 * Hook wiring (DESIGN §4, §7). Everything registered here is zero-LLM; the
 * learning loop's bounded distillation arrives in M2.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryConfig } from '../config.js'
import { log } from '../log.js'
import { SessionState } from '../recall/session-state.js'
import { ScopeResolver } from '../scope/resolver.js'
import type { AgentLike } from '../scope/resolver.js'
import type { StoreRegistry } from '../store/store.js'
import type { MemoryScope } from '../store/types.js'
import { AutoCommitter } from '../sync/autocommit.js'
import { ensureRepo } from '../sync/git.js'
import { consolidate } from '../learn/consolidate.js'
import { pruneEpisodes, pruneSignals } from '../learn/episodic.js'
import { buildLedgerRow, recordSessionMetric, sessionStats, withLearningCounters } from '../learn/task-metrics.js'
import { consolidationDue } from '../learn/decay.js'
import { TurnLedger } from '../learn/ledger.js'
import { SignalBuffer } from '../learn/signals.js'
import { recoverPendingDistillations, registerLearnHooks } from './learn.js'
import { createPreStepHook } from './pre-step.js'
import { registerAgentIndexSection, registerProtocolSection } from './prompt.js'
import type { PromptDeps } from './prompt.js'

export interface HookDeps extends PromptDeps {
    config: MemoryConfig
    registry: StoreRegistry
    resolver: ScopeResolver
    state: SessionState
    /** Bounded pain-signal buffer (L0). */
    signals: SignalBuffer
    /** Per-turn work counters, used for recall attribution. */
    ledger: TurnLedger
    /** Local-only commits of the memory text view. */
    committer: AutoCommitter
}

export interface HookHandle {
    deps: HookDeps
    dispose: () => void
}

/** Build the shared dependency bag (tools and hooks use the same one). */
export function createHookDeps(
    config: MemoryConfig,
    registry: StoreRegistry,
    resolver: ScopeResolver,
    capabilities: { save: boolean },
    semantic?: { provider?: import('../recall/semantic.js').EmbeddingProvider | undefined; cache?: import('../recall/semantic.js').QueryVectorCache } | undefined,
): HookDeps {
    return {
        config,
        registry,
        resolver,
        capabilities,
        state: new SessionState(),
        signals: new SignalBuffer(),
        ledger: new TurnLedger(),
        committer: new AutoCommitter(config),
        ...(semantic !== undefined ? { semantic } : {}),
    }
}

/** Register every hook and prompt contribution. */
export function registerHooks(ctx: Context, deps: HookDeps): HookHandle {
    const disposers: (() => void)[] = []

    // ① prompt sections: protocol (global) + index summary (per agent).
    disposers.push(...registerProtocolSection(ctx, deps))

    ctx.on('agent/created', (payload: { agent?: AgentLike & { ctx?: Context } }) => {
        try {
            const agent = payload?.agent
            if (agent === undefined) return
            registerAgentIndexSection(agent, deps)
            // Recovery deliberately does NOT run here: a timer races host
            // teardown on one-shot surfaces ("database is not open"). It runs at
            // the end of the first turn instead — see handleTurnEnd.
        } catch (error) {
            log('warn', 'memory: agent/created index registration failed:', error)
        }
    })

    // ② automatic recall at the first step of every turn.
    ctx.on('agent/pre-step', createPreStepHook(deps as HookDeps))

    // ③ learning loop: signals, turn-end distillation, recall attribution.
    disposers.push(...registerLearnHooks(ctx, { ...deps, ctx }))

    // ③.4 git: make the root versionable, then commit local changes at a
    // task-end cadence. Pushing never happens here (DESIGN D6).
    if (deps.config.git.enabled) {
        ctx.on('agent/turn-stopping', (payload: { agent?: { session?: { header?: { cwd?: string } } } }) => {
            try {
                const scope = deps.resolver.resolve({ cwd: payload?.agent?.session?.header?.cwd })
                deps.committer.maybeCommit(scope, `turn end (${scope.kind})`)
            } catch (error) {
                log('debug', 'memory: auto-commit skipped:', error)
            }
        })
    }

    // ③.5 lazy consolidation: at most one pass per scope per interval, never
    // blocking session start (DESIGN §7 "周期" row).
    const inFlight = new Set<string>()
    ctx.on('session/created', (session: { id?: string; header?: { cwd?: string } }) => {
        try {
            // Duration for the metric ledger starts here, not at the first turn.
            if (typeof session?.id === 'string') deps.state.markSessionStart(session.id)
        } catch (error) {
            log('debug', 'memory: session start bookkeeping failed:', error)
        }
        try {
            if (deps.config.git.enabled) {
                const scope = deps.resolver.resolve({ cwd: session?.header?.cwd })
                const timer = setTimeout(() => ensureRepo(scope.root), 1_000)
                timer.unref?.()
            }
        } catch (error) {
            log('debug', 'memory: git init scheduling failed:', error)
        }
        try {
            if (!deps.config.consolidate.enabled) return
            const scope = deps.resolver.resolve({ cwd: session?.header?.cwd })
            if (inFlight.has(scope.root)) return
            const timer = setTimeout(() => {
                inFlight.delete(scope.root)
                runLazyConsolidation(deps, scope)
            }, 2_000)
            timer.unref?.()
            inFlight.add(scope.root)
        } catch (error) {
            log('debug', 'memory: lazy consolidation scheduling failed:', error)
        }
    })

    // ④ per-session state cleanup.
    ctx.on('session/disposed', (session: { id?: string; header?: { cwd?: string } }) => {
        try {
            if (typeof session?.id !== 'string') return
            // Ledger row before the state is forgotten: this is the only point
            // where a session's aggregates are still known.
            const store = deps.registry.open(deps.resolver.resolve({ cwd: session?.header?.cwd }))
            if (store !== undefined) {
                const startedAt = deps.state.sessionStart(session.id)
                const base = sessionStats(store.db, {
                    sessionId: session.id,
                    ...(startedAt !== undefined ? { startedAt } : {}),
                    turns: deps.state.lastTurn(session.id),
                    toolCalls: deps.ledger.sessionToolCalls(session.id),
                    signals: 0,
                    rework: 0,
                    corrections: 0,
                })
                const row = buildLedgerRow(base)
                if (row !== undefined) {
                    const full = withLearningCounters(store.db, row, session.id)
                    recordSessionMetric(store.db, store.scope, full)
                    log(
                        'info',
                        `memory: session metric ${full.taskId} (${full.outcome}, ${full.durationMin}min, signals ${base.signals}, lessons ${full.lessons})`,
                    )
                }
            }
            deps.state.forget(session.id)
            deps.signals.forget(session.id)
            deps.ledger.forget(session.id)
            if (deps.config.git.enabled) {
                const scope = deps.resolver.resolve({ cwd: session?.header?.cwd })
                deps.committer.commitNow(scope, 'session end')
            }
        } catch (error) {
            log('debug', 'memory: session cleanup failed:', error)
        }
    })

    return {
        deps,
        dispose: () => {
            for (const dispose of disposers) {
                try {
                    dispose()
                } catch (error) {
                    log('warn', 'memory: hook disposer failed:', error)
                }
            }
        },
    }
}

/**
 * One consolidation pass, scheduled off the session-start path. Deterministic
 * work only: expiry, staleness, decay and *detection* of contradictions.
 * Superseding a lesson needs an explicit `memory_consolidate` call, and a
 * promotion always waits for a human.
 */
function runLazyConsolidation(deps: HookDeps, scope: MemoryScope): void {
    try {
        const store = deps.registry.open(scope)
        if (store === undefined) return
        const due = consolidationDue(store.db, {
            everyDays: deps.config.consolidate.everyDays,
            everyNTasks: deps.config.consolidate.everyNTasks,
        })
        if (!due.due) return
        const report = consolidate(store.db, store.scope, store.fts5, { dryRun: false, resolveConflicts: false })
        // Retention belongs to the same periodic pass: without it the episode
        // files and the signals table grow forever (the setting existed but had
        // no caller).
        const prunedFiles = pruneEpisodes(store.scope, deps.config.episodic.retentionDays)
        const prunedRows = pruneSignals(store.db, deps.config.episodic.retentionDays)
        log(
            'info',
            `memory: consolidation (${due.reason}) on ${report.scope} — archived ${report.archived}, decayed ${report.decayed}, conflicts ${report.conflictsFound}, proposals ${report.proposals.length}, pruned ${prunedFiles} episode file(s) / ${prunedRows} signal row(s)`,
        )
    } catch (error) {
        log('warn', 'memory: lazy consolidation failed:', error)
    }
}
