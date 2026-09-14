/**
 * System-prompt contributions (DESIGN §6, channel ①).
 *
 * Two independently switchable sections:
 *   - `memory:protocol`  — always-on, static, tiny: what the memory system is
 *     and which tools exist. Never mentions a tool that is not registered.
 *   - `memory:index`     — per-agent, dynamic: how much project/global memory
 *     exists and the most recent titles, so the model knows what to search for
 *     without paying for the bodies.
 *
 * The index section is registered on the *agent-scoped* context, so it resolves
 * the right repository per session and unwinds automatically on disposal.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryConfig } from '../config.js'
import { log } from '../log.js'
import { readProfile, renderProfile } from '../learn/profile.js'
import { estimateTokens } from '../recall/rank.js'
import { ScopeResolver } from '../scope/resolver.js'
import type { AgentLike } from '../scope/resolver.js'
import { countRecords, listRecords } from '../store/sqlite/records.js'
import type { StoreRegistry } from '../store/store.js'

export const PROTOCOL_SECTION = 'memory:protocol'
export const INDEX_SECTION = 'memory:index'

/**
 * Which tools the host actually registered (see `registerTools`). The protocol
 * text is rendered from this object and from nothing else, so a tool whose
 * registration failed is never advertised.
 *
 * `search`/`get` are optional for callers that only track the write capability:
 * an explicit `false` suppresses the line, `undefined` keeps the historical
 * default of mentioning the read tools.
 */
export interface PromptCapabilities {
    save: boolean
    search?: boolean
    get?: boolean
}

export interface PromptDeps {
    config: MemoryConfig
    registry: StoreRegistry
    resolver: ScopeResolver
    /** Which tools exist, so the protocol never advertises a missing tool. */
    capabilities: PromptCapabilities
}

/** Static protocol text. Kept short: ~120 tokens at the default budget. */
export function protocolText(config: MemoryConfig, capabilities: PromptCapabilities = { save: false }): string {
    const lines = [
        '记忆系统（dsh-memory）已启用：',
        '- 任务开始时会自动召回相关的历史经验（项目记忆 + 跨项目工具链教训），你无需手动检索即可看到它们。',
    ]
    if (capabilities.search !== false) {
        lines.push('- 需要更深入的历史信息时用 `memory_search` 检索（项目记忆 + 关键词命中的全局教训）。')
    }
    if (capabilities.get !== false) {
        lines.push('- 命中后用 `memory_get(id)` 读全文；不要凭印象复述记忆内容。')
    }
    lines.push('- 记忆条目带 confidence：< 0.7 只是线索，必须自行验证后再执行；与当前事实冲突时以当前事实为准。')
    if (capabilities.save) {
        lines.push('- 值得长期保留的经验（真踩坑/真修复，或用户明确要求记住）用 `memory_save` 写入：默认写项目级；只有跨项目工具链事实才写全局。')
    }
    return clampTokens(lines.join('\n'), config.prompt.protocol.budgetTokens)
}

/** Register the global protocol section. Returns disposers. */
export function registerProtocolSection(ctx: Context, deps: PromptDeps): (() => void)[] {
    if (!deps.config.prompt.protocol.enabled) return []
    try {
        const dispose = ctx.systemPrompt.section({
            name: PROTOCOL_SECTION,
            order: deps.config.prompt.protocol.order,
            text: () => protocolText(deps.config, deps.capabilities),
        })
        return [dispose]
    } catch (error) {
        log('warn', 'memory: protocol section registration failed:', error)
        return []
    }
}

/**
 * Register the per-agent index section. Called from `agent/created` with the
 * agent's own scoped context.
 */
export function registerAgentIndexSection(agent: AgentLike & { ctx?: Context }, deps: PromptDeps): boolean {
    if (!deps.config.prompt.indexSummary.enabled) return false
    const ctx = agent.ctx
    if (ctx === undefined) return false
    try {
        ctx.systemPrompt.section({
            name: INDEX_SECTION,
            order: deps.config.prompt.indexSummary.order,
            text: () => indexSummaryText(deps, agent),
        })
        return true
    } catch (error) {
        log('debug', 'memory: index section registration skipped:', error)
        return false
    }
}

/** Dynamic index summary for one agent's scope. */
export function indexSummaryText(deps: PromptDeps, agent: AgentLike | undefined): string {
    try {
        const scope = deps.resolver.resolve({ agent })
        const store = deps.registry.open(scope)
        if (store === undefined) return ''
        const counts = countRecords(store.db)
        if (counts.total === 0) return ''
        const maxTitles = deps.config.prompt.indexSummary.maxTitles
        const recent = listRecords(store.db, { status: ['active', 'pending'], limit: maxTitles })
        const label = scope.kind === 'project' ? '项目记忆' : '全局记忆'
        const lines = [
            `${label}：${counts.total} 条（active ${counts.active} / pending ${counts.pending}${counts.archived > 0 ? ` / archived ${counts.archived}` : ''}）。`,
        ]
        // L5 rides the resident section (DESIGN §6 ①): a preference must be in
        // effect without being recalled, and it is short by construction.
        const profile = renderProfile(readProfile(store.scope), deps.config.prompt.indexSummary.profileBudgetTokens)
        if (profile !== '') lines.push(profile)
        if (recent.length > 0) {
            lines.push(`最近更新：${recent.map((record) => record.title).join('；')}`)
        }
        if (scope.kind === 'project') {
            const global = deps.registry.open(deps.resolver.globalScope())
            if (global !== undefined) {
                const globalCounts = countRecords(global.db)
                if (globalCounts.total > 0) lines.push(`全局记忆：${globalCounts.total} 条跨项目工具链教训（命中关键词时自动召回）。`)
            }
        }
        return clampTokens(lines.join('\n'), deps.config.prompt.indexSummary.budgetTokens)
    } catch (error) {
        log('debug', 'memory: index summary failed:', error)
        return ''
    }
}

/** Hard token cap so a large store can never inflate the system prompt. */
function clampTokens(text: string, budgetTokens: number): string {
    if (budgetTokens <= 0) return ''
    if (estimateTokens(text) <= budgetTokens) return text
    const lines = text.split('\n')
    const kept: string[] = []
    let used = 0
    for (const line of lines) {
        const cost = estimateTokens(line)
        if (used + cost > budgetTokens) break
        kept.push(line)
        used += cost
    }
    return kept.join('\n')
}
