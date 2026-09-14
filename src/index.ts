/**
 * dsh-memory — layered memory plugin for DeepSeek Harness.
 *
 * Strictly separated project/global memory (one SQLite database per root, one
 * text view per root), host-driven recall before work and continuous learning
 * after it. See `docs/DESIGN.md` for the full design; M0 ships the store, the
 * bootstrap import and the read-only tool surface.
 *
 * Extension points used here (verified against the installed packages):
 *  - ctx.tools.register(defineTool(...))   @deepseek-ai/dsh-tools
 *  - ctx.effect(() => cleanup)             cordis v4 fiber teardown
 *  - session.header.cwd                    @deepseek-ai/dsh-session (scope key)
 *
 * @module dsh-memory
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.js'
import { log, setLogFile } from './log.js'
import { expandHome } from './paths.js'
import { ScopeResolver } from './scope/resolver.js'
import { loadSqliteModule } from './store/sqlite/db.js'
import { StoreRegistry } from './store/store.js'
import { registerTools } from './tools/index.js'

export const name = 'dsh-memory'
export const inject = ['tools']

export function apply(ctx: Context, config: unknown = {}): void {
    try {
        const resolved = resolveConfig(config)
        if (!resolved.enabled) return
        setLogFile(expandHome(resolved.logFile))
        log('info', `dsh-memory applying (default scope: ${resolved.routing.defaultScope})`)

        const registry = new StoreRegistry(resolved)
        const resolver = new ScopeResolver(resolved)
        const disposers = registerTools(ctx, { config: resolved, registry, resolver })

        ctx.effect(() => () => {
            for (const dispose of disposers) {
                try {
                    dispose()
                } catch (error) {
                    log('warn', 'memory: tool disposer failed:', error)
                }
            }
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
                `memory: ready (node:sqlite ${report.probe.sqliteVersion ?? '?'}, fts5=${report.probe.fts5 ? 'yes' : 'no'})`,
            )
        })
    } catch (error) {
        // A plugin failure must never break the host session.
        log('error', 'dsh-memory apply failed:', error)
    }
}
