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
import { consolidationDue } from '../learn/decay.js'
import { TurnLedger } from '../learn/ledger.js'
import { SignalBuffer } from '../learn/signals.js'
import { registerLearnHooks } from './learn.js'
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
    ctx.on('session/created', (session: { header?: { cwd?: string } }) => {
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
        log(
            'info',
            `memory: consolidation (${due.reason}) on ${report.scope} — archived ${report.archived}, decayed ${report.decayed}, conflicts ${report.conflictsFound}, proposals ${report.proposals.length}`,
        )
    } catch (error) {
        log('warn', 'memory: lazy consolidation failed:', error)
    }
}
