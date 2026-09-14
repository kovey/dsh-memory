/**
 * `memory_stats` — the evaluation surface (DESIGN §11 M5).
 *
 * Answers three questions in one call: what is in the store, how healthy the
 * learning loop is, and whether the current period regressed against the frozen
 * baseline.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryConfig } from '../config.js'
import {
    evaluateGate,
    freezeBaseline,
    healthDigest,
    latestBaseline,
    readBaseline,
    renderEvaluation,
    snapshotMetrics,
    windowSummary,
} from '../eval/baseline.js'
import { episodeDigest } from '../learn/episodic.js'
import { log } from '../log.js'
import { openProposalsCount } from '../learn/stats.js'
import { conflictCount } from '../learn/conflicts.js'
import { recallStats } from '../recall/usage.js'
import { indexStats } from '../recall/semantic.js'
import type { EmbeddingProvider } from '../recall/semantic.js'
import { ScopeResolver, sessionIdOf } from '../scope/resolver.js'
import type { AgentLike } from '../scope/resolver.js'
import { summarizeMetrics } from '../store/metrics.js'
import { countRecords } from '../store/sqlite/records.js'
import type { StoreRegistry, ScopeStore } from '../store/store.js'
import type { MemoryScope } from '../store/types.js'
import { refuseWrite } from './save.js'

export interface StatsToolDeps {
    config: MemoryConfig
    registry: StoreRegistry
    resolver: ScopeResolver
    semantic?: { provider?: EmbeddingProvider | undefined } | undefined
}

const TEXT_OUTPUT = { type: 'string' } as const

export function statsTool(deps: StatsToolDeps) {
    return defineTool({
        name: 'memory_stats',
        description:
            'Report memory-store health and the evaluation gate: record counts, recall hit rate, learning cost, open conflicts/proposals, task-metric trends, and whether the current period regressed against the frozen baseline. Freezing a new baseline is a human-review step: setBaseline=true is refused unless the user explicitly asked for it and a non-empty baselineReason is passed.',
        parameters: {
            scope: { type: 'string', enum: ['auto', 'all'], description: 'auto = this session\'s scope; all = also the global store.' },
            setBaseline: {
                type: 'boolean',
                description:
                    'Freeze the current task metrics as the regression baseline. Human-review step: only after the user explicitly asks, and only together with baselineReason.',
            },
            baselineReason: {
                type: 'string',
                description:
                    'Required with setBaseline=true: why the baseline is being frozen now (what the user asked, what was verified). Recorded in the log with the calling session id.',
            },
            windowDays: { type: 'number', description: 'Trend window in days (default 30).' },
            note: { type: 'string', description: 'Optional note stored with a frozen baseline snapshot.' },
        },
        output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
            const agent = exec.agent as unknown as AgentLike | undefined
            // Freezing is this tool's only write, and it is the one action that
            // can erase a regression signal: a model must not re-freeze the
            // reference on its own, and a subagent must not freeze it either.
            let baselineReason: string | undefined
            if (args.setBaseline === true) {
                const refusal = refuseWrite(deps, agent, '`memory_stats` with setBaseline=true (freezing the gate baseline)')
                if (refusal !== undefined) return refusal
                baselineReason = (args.baselineReason ?? '').trim()
                if (baselineReason === '') {
                    return [
                        'refused: setBaseline is a human-review step, not a model action — freezing a baseline replaces the reference the gate compares against, so a period that regressed would start reading as PASS.',
                        'Freeze only when the user explicitly asked for it, and state why:',
                        '  memory_stats({ setBaseline: true, baselineReason: "<who asked and what was verified>" })',
                        'Without setBaseline this call reports the read-only status and the current verdict.',
                    ].join('\n')
                }
            }
            const stores = targetStores(deps, agent, args.scope === 'all')
            if (stores.length === 0) return 'memory store unavailable (SQLite driver missing or memory root unwritable)'

            const windowDays = Math.max(1, Math.min(365, Math.floor(args.windowDays ?? 30)))
            const lines: string[] = ['memory store status:']
            const capabilities = deps.registry.capabilities
            lines.push(
                `driver: ${capabilities.available ? `node:sqlite ${capabilities.sqliteVersion ?? ''}` : `unavailable (${capabilities.reason ?? 'unknown'})`} · fts5: ${capabilities.fts5 ? 'yes' : 'no'}`,
            )

            for (const store of stores) {
                lines.push('')
                lines.push(
                    `[${store.scope.kind}] ${store.scope.root}${store.scope.repo !== undefined ? ` (repo ${store.scope.repo})` : ''}`,
                )
                const counts = countRecords(store.db)
                const recall = recallStats(store.db)
                const metrics = summarizeMetrics(store.db)
                const episodes = episodeDigest(store.db)
                lines.push(
                    `  records: ${counts.total} (active ${counts.active} / pending ${counts.pending} / archived ${counts.archived}) · expired ${counts.expired} · superseded ${counts.superseded}`,
                )
                lines.push(
                    `  conflicts ${conflictCount(store.db)} · open proposals ${openProposalsCount(store.db)} · episodes ${episodes.signals} signal(s)`,
                )
                lines.push(
                    `  recall: ${recall.injections} injection(s), ${recall.attributed} attributed (success ${recall.success} / failure ${recall.failure})`,
                )
                lines.push(
                    `  tasks: ${metrics.tasks} (success ${metrics.success} / partial ${metrics.partial} / failed ${metrics.failed}) · lessons logged ${metrics.lessons}`,
                )

                const scopeLabel = store.scope.kind === 'project' ? `project:${store.scope.repo ?? store.scope.root}` : 'global'
                if (baselineReason !== undefined) {
                    const frozen = freezeBaseline(store.db, scopeLabel, args.note)
                    // The freeze is an audited human decision: the log carries who
                    // called it and the reason they gave.
                    log(
                        'info',
                        `memory: baseline frozen for ${scopeLabel} by session ${sessionIdOf(agent) ?? 'unknown'} — reason: ${baselineReason}${args.note !== undefined ? ` (note: ${args.note})` : ''}`,
                    )
                    lines.push(
                        `  baseline frozen: ${frozen.tasks} task(s), success rate ${frozen.successRate ?? 'n/a'}, avg duration ${frozen.avgDuration ?? 'n/a'} min, avg disturb ${frozen.avgDisturb ?? 'n/a'}, avg rework ${frozen.avgRework ?? 'n/a'} · reason: ${baselineReason}`,
                    )
                }

                const current = snapshotMetrics(store.db)
                const gate = evaluateGate(current, latestBaseline(store.db))
                const trend = {
                    current: windowSummary(store.db, windowDays, 0),
                    previous: windowSummary(store.db, windowDays, windowDays),
                }
                const semanticCfg = deps.config.semantic
                if (!semanticCfg.enabled) {
                    lines.push('  semantic: off (lexical FTS5 + CJK bigram ranking only)')
                } else if (deps.semantic?.provider === undefined) {
                    lines.push(`  semantic: enabled but no provider (baseUrl/model configured? provider=${semanticCfg.provider})`)
                } else {
                    const stats = indexStats(store.db, semanticCfg.model)
                    const error = deps.semantic.provider.lastError()
                    lines.push(
                        `  semantic: ${deps.semantic.provider.id} — indexed ${stats.indexed}, pending ${stats.pending}, weight ${semanticCfg.weight}${error !== undefined ? ` (last error: ${error})` : ''}`,
                    )
                }
                const baselineDoc = readBaseline(store.scope)
                lines.push(...renderEvaluation(gate, healthDigest(store.db, windowDays), trend, baselineDoc?.tasks ?? []))
            }
            return lines.join('\n')
        },
    })
}

function targetStores(deps: StatsToolDeps, agent: AgentLike | undefined, includeGlobal: boolean): ScopeStore[] {
    const stores: ScopeStore[] = []
    const primary = deps.registry.open(deps.resolver.resolve({ agent }))
    if (primary !== undefined) stores.push(primary)
    if (includeGlobal) {
        const global = deps.registry.open(deps.resolver.globalScope())
        if (global !== undefined && !stores.some((store) => store.scope.root === global.scope.root)) stores.push(global)
    }
    return stores
}

/** Exported for tests: the scope label used when freezing a baseline. */
export function scopeLabel(scope: MemoryScope): string {
    return scope.kind === 'project' ? `project:${scope.repo ?? scope.root}` : 'global'
}
