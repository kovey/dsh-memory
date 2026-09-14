/**
 * dsh-memory — layered memory plugin for DeepSeek Harness.
 *
 * Strictly separated project/global memory (one SQLite database per root, one
 * text view per root), host-driven recall before work and continuous learning
 * after it. See `docs/DESIGN.md` for the full design.
 *
 * Extension points used here (verified against the installed packages):
 *  - ctx.tools.register(defineTool(...))        @deepseek-ai/dsh-tools
 *  - ctx.systemPrompt.section({...})            @deepseek-ai/dsh-system-prompt
 *  - ctx.on('agent/pre-step', (payload, next))  @deepseek-ai/dsh-agent (waterfall)
 *  - ctx.on('agent/created' | 'session/disposed')
 *  - agent.ctx                                  agent-scoped registrations
 *  - session.header.cwd                         @deepseek-ai/dsh-session (scope key)
 *  - createUserMessage({source:{kind:'plugin'}}) @deepseek-ai/dsh-llm
 *  - ctx.effect(() => cleanup)                  cordis v4 fiber teardown
 *
 * @module dsh-memory
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.js'
import { createHookDeps, registerHooks } from './hooks/index.js'
import { log, setLogFile } from './log.js'
import { expandHome } from './paths.js'
import { createEmbeddingProvider, QueryVectorCache } from './recall/semantic.js'
import { ScopeResolver } from './scope/resolver.js'
import { loadSqliteModule } from './store/sqlite/db.js'
import { StoreRegistry } from './store/store.js'
import { registerTools } from './tools/index.js'

export const name = 'dsh-memory'
export const inject = ['tools', 'systemPrompt']

/** The protocol section only advertises tools that are actually registered. */
const CAPABILITIES = { save: true }

export function apply(ctx: Context, config: unknown = {}): void {
    try {
        const resolved = resolveConfig(config)
        if (!resolved.enabled) return
        setLogFile(expandHome(resolved.logFile))
        log('info', `dsh-memory applying (default scope: ${resolved.routing.defaultScope})`)

        const registry = new StoreRegistry(resolved)
        const resolver = new ScopeResolver(resolved)
        const semantic = { provider: createEmbeddingProvider(resolved), cache: new QueryVectorCache() }
        const deps = createHookDeps(resolved, registry, resolver, CAPABILITIES, semantic)

        const toolDisposers = registerTools(ctx, {
            config: resolved,
            registry,
            resolver,
            state: deps.state,
            committer: deps.committer,
            semantic,
        })
        const hooks = registerHooks(ctx, deps)

        ctx.effect(() => () => {
            for (const dispose of toolDisposers) {
                try {
                    dispose()
                } catch (error) {
                    log('warn', 'memory: tool disposer failed:', error)
                }
            }
            hooks.dispose()
            registry.closeAll()
        })

        // The driver is probed asynchronously; tools called before the probe
        // settles report "store unavailable" instead of failing the session.
        void registry.initialize(loadSqliteModule).then((report) => {
            if (!registry.available) {
                log(
                    'error',
                    `memory: SQLite unavailable (${report.probe.reason ?? 'unknown'}) — memory tools will report unavailability. Node >= 24 (or a build with node:sqlite enabled) is required.`,
                )
                return
            }
            log(
                'info',
                `memory: ready (node:sqlite ${report.probe.sqliteVersion ?? '?'}, fts5=${report.probe.fts5 ? 'yes' : 'no'}, recall=${resolved.recall.autoInject ? `on/${resolved.recall.budgetTokens}tok` : 'off'}, protocol=${resolved.prompt.protocol.enabled ? 'on' : 'off'}, learn=${resolved.learn.autoDistill ? `on/${resolved.learn.distillModel.model}` : 'off'}, semantic=${resolved.semantic.enabled ? `on/${resolved.semantic.model}` : 'off'})`,
            )
        })
    } catch (error) {
        // A plugin failure must never break the host session.
        log('error', 'dsh-memory apply failed:', error)
    }
}
