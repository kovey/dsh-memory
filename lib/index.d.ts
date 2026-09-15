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
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-memory";
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
export declare const inject: string[];
export declare function apply(ctx: Context, config?: unknown): void;
//# sourceMappingURL=index.d.ts.map