import { resolveConfig } from './config.js';
import { createHookDeps, registerHooks } from './hooks/index.js';
import { log, setLogFile } from './log.js';
import { expandHome } from './paths.js';
import { createEmbeddingProvider, QueryVectorCache } from './recall/semantic.js';
import { ScopeResolver } from './scope/resolver.js';
import { loadSqliteModule } from './store/sqlite/db.js';
import { StoreRegistry } from './store/store.js';
import { registerTools } from './tools/index.js';
export const name = 'dsh-memory';
/**
 * Only the two services this plugin actually touches:
 *   - `tools`        — `ctx.tools.register(...)` for the memory tool surface
 *   - `systemPrompt` — `ctx.systemPrompt.section(...)` for the two prompt sections
 *
 * `agents` and `session` are deliberately *not* injected: events arrive through
 * `ctx.on` (which `inject` does not gate), and the agent/session a hook or tool
 * call refers to always comes from the hook payload or from `exec.agent` — the
 * plugin never looks up `ctx.agents` / `ctx.session`. `ctx.jobs` (optional job
 * runner) is resolved reflectively without `inject` in
 * `learn/distill-runner.ts`, so a host without it degrades to inline
 * distillation instead of failing to load. DESIGN §9.2 matches this list.
 */
export const inject = ['tools', 'systemPrompt'];
export function apply(ctx, config = {}) {
    try {
        const resolved = resolveConfig(config);
        if (!resolved.enabled)
            return;
        setLogFile(expandHome(resolved.logFile));
        log('info', `dsh-memory applying (default scope: ${resolved.routing.defaultScope})`);
        const registry = new StoreRegistry(resolved);
        const resolver = new ScopeResolver(resolved);
        const semantic = { provider: createEmbeddingProvider(resolved), cache: new QueryVectorCache() };
        // Derived from the registration result below — never hardcoded. The prompt
        // sections close over this same object, so `memory:protocol` can only
        // advertise a tool the host actually accepted.
        const capabilities = { save: false, search: false, get: false };
        const deps = createHookDeps(resolved, registry, resolver, capabilities, semantic);
        const tools = registerTools(ctx, {
            config: resolved,
            registry,
            resolver,
            state: deps.state,
            committer: deps.committer,
            semantic,
        });
        capabilities.save = tools.registered.includes('memory_save');
        capabilities.search = tools.registered.includes('memory_search');
        capabilities.get = tools.registered.includes('memory_get');
        for (const failed of tools.failed) {
            log('warn', `memory: tool ${failed} failed to register — it is unavailable and is not advertised in the prompt protocol`);
        }
        if (tools.failed.length > 0) {
            log('warn', `memory: ${tools.registered.length}/${tools.registered.length + tools.failed.length} memory tools registered (failed: ${tools.failed.join(', ')})`);
        }
        const hooks = registerHooks(ctx, deps);
        ctx.effect(() => () => {
            for (const dispose of tools.disposers) {
                try {
                    dispose();
                }
                catch (error) {
                    log('warn', 'memory: tool disposer failed:', error);
                }
            }
            hooks.dispose();
            registry.closeAll();
        });
        // The driver is probed asynchronously; tools called before the probe
        // settles report "store unavailable" instead of failing the session.
        void registry.initialize(loadSqliteModule).then((report) => {
            if (!registry.available) {
                log('error', `memory: SQLite unavailable (${report.probe.reason ?? 'unknown'}) — memory tools will report unavailability. Node >= 24 (or a build with node:sqlite enabled) is required.`);
                return;
            }
            log('info', `memory: ready (node:sqlite ${report.probe.sqliteVersion ?? '?'}, fts5=${report.probe.fts5 ? 'yes' : 'no'}, recall=${resolved.recall.autoInject ? `on/${resolved.recall.budgetTokens}tok` : 'off'}, protocol=${resolved.prompt.protocol.enabled ? 'on' : 'off'}, learn=${resolved.learn.autoDistill ? `on/${resolved.learn.distillModel.model}` : 'off'}, semantic=${resolved.semantic.enabled ? `on/${resolved.semantic.model}` : 'off'})`);
        });
    }
    catch (error) {
        // A plugin failure must never break the host session.
        log('error', 'dsh-memory apply failed:', error);
    }
}
//# sourceMappingURL=index.js.map