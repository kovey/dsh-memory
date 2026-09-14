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
): HookDeps {
    return {
        config,
        registry,
        resolver,
        capabilities,
        state: new SessionState(),
        signals: new SignalBuffer(),
        ledger: new TurnLedger(),
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

    // ④ per-session state cleanup.
    ctx.on('session/disposed', (session: { id?: string }) => {
        try {
            if (typeof session?.id !== 'string') return
            deps.state.forget(session.id)
            deps.signals.forget(session.id)
            deps.ledger.forget(session.id)
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
