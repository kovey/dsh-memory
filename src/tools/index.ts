/**
 * Model-facing memory tools (DESIGN §9.1).
 *
 * M0 ships the read-only surface (`memory_search`, `memory_get`,
 * `memory_stats`) plus the derived-index repair tool (`memory_reindex`).
 * Writing tools arrive with the learning loop in M2.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryConfig } from '../config.js'
import { log } from '../log.js'
import { rankRecords, normalizeRelevance } from '../recall/rank.js'
import { countRecords, extractTerms, getRecord, listRecords, rawSearch } from '../store/sqlite/records.js'
import { summarizeMetrics } from '../store/metrics.js'
import type { StoreRegistry, ScopeStore } from '../store/store.js'
import type { Layer, MemoryRecord, MemoryScope } from '../store/types.js'
import { ScopeResolver } from '../scope/resolver.js'
import type { AgentLike } from '../scope/resolver.js'

export interface ToolDeps {
    config: MemoryConfig
    registry: StoreRegistry
    resolver: ScopeResolver
}

type TextOutput = { type: 'string' }

const TEXT_OUTPUT: TextOutput = { type: 'string' }

const LAYER_ENUM = ['project', 'global', 'profile', 'episodic'] as const

/** Register every tool; returns the list of disposers for `ctx.effect`. */
export function registerTools(ctx: Context, deps: ToolDeps): (() => void)[] {
    const disposers: (() => void)[] = []
    const register = (definition: ReturnType<typeof defineTool>): void => {
        try {
            disposers.push(ctx.tools.register(definition))
        } catch (error) {
            log('error', `memory: registering tool ${definition.name} failed:`, error)
        }
    }

    register(searchTool(deps))
    register(getTool(deps))
    register(statsTool(deps))
    register(reindexTool(deps))
    return disposers
}

/** Which open stores a call should consult. */
function targetStores(deps: ToolDeps, agent: AgentLike | undefined, scope: 'auto' | 'project' | 'global' | 'all'): ScopeStore[] {
    const primary = deps.registry.open(deps.resolver.resolve({ agent }))
    const stores: ScopeStore[] = []
    if (primary !== undefined) stores.push(primary)
    if (scope === 'global' || scope === 'all') {
        const global = deps.registry.open(deps.resolver.globalScope())
        if (global !== undefined && !stores.some((store) => store.scope.root === global.scope.root)) stores.push(global)
    }
    return stores
}

function searchTool(deps: ToolDeps) {
    return defineTool({
        name: 'memory_search',
        description:
            'Search the agent memory store (project memory first, then global). Returns titles, metadata and short excerpts — use memory_get for a full body. Call this before starting non-trivial work and whenever prior experience with the same tool, error or workflow may exist.',
        parameters: {
            query: { type: 'string', required: true, description: 'Free-text query: task, error message, tool or topic keywords.' },
            scope: {
                type: 'string',
                enum: ['auto', 'project', 'global', 'all'],
                description: 'Which memory roots to search. Default auto = the scope owning this session.',
            },
            layer: { type: 'string', enum: [...LAYER_ENUM], description: 'Restrict to one memory layer.' },
            limit: { type: 'number', description: 'Maximum results (default 8, max 50).' },
            minConfidence: { type: 'number', description: 'Drop records below this confidence (0..1).' },
        },
        output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
            const agent = exec.agent as unknown as AgentLike | undefined
            const limit = Math.max(1, Math.min(50, Math.floor(args.limit ?? 8)))
            const wanted = (args.scope ?? 'auto') as 'auto' | 'project' | 'global' | 'all'
            const stores = targetStores(deps, agent, wanted)
            if (stores.length === 0) return 'memory store unavailable (SQLite driver missing or memory root unwritable)'

            const terms = extractTerms(args.query)
            if (terms.length === 0) return 'query contained no searchable terms'
            const filter = {
                ...(args.layer !== undefined ? { layers: [args.layer as Layer] } : {}),
                status: ['active', 'pending'] as const,
            }

            const perStore = stores.map((store) => {
                const hits = rawSearch(store.db, terms, store.fts5, filter)
                const relevance = normalizeRelevance(new Map(hits.map((hit) => [hit.id, hit.raw])))
                const records = hits
                    .map((hit) => getRecord(store.db, hit.id))
                    .filter((record): record is MemoryRecord => record !== undefined)
                return { store, ranked: rankRecords(records, { relevance }) }
            })

            const minConfidence = args.minConfidence ?? 0
            const merged = perStore
                .flatMap(({ store, ranked }) =>
                    ranked
                        .filter((item) => item.record.confidence >= minConfidence)
                        .map((item) => ({ ...item, scope: store.scope })),
                )
                .sort((a, b) => b.score - a.score)
                .slice(0, limit)

            if (merged.length === 0) {
                return `no memory matched "${args.query}" (searched ${stores.map((s) => s.scope.kind).join(' + ')})`
            }
            const lines: string[] = [`${merged.length} memory record(s) for "${args.query}":`]
            merged.forEach((item, index) => {
                lines.push(formatHit(index + 1, item.record, item.scope, item.score))
            })
            lines.push('')
            lines.push('Use memory_get(id) for the full text. Records with confidence < 0.7 are hints, not instructions.')
            return lines.join('\n')
        },
    })
}

function getTool(deps: ToolDeps) {
    return defineTool({
        name: 'memory_get',
        description: 'Read the full body of one memory record by id (as returned by memory_search).',
        parameters: {
            id: { type: 'string', required: true, description: 'Record id (slug).' },
            scope: {
                type: 'string',
                enum: ['auto', 'all'],
                description: 'auto = the scope owning this session; all = also look in global memory.',
            },
        },
        output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
            const agent = exec.agent as unknown as AgentLike | undefined
            const stores = targetStores(deps, agent, args.scope === 'all' ? 'all' : 'auto')
            for (const store of stores) {
                const record = getRecord(store.db, args.id)
                if (record === undefined) continue
                return [
                    `# ${record.title}`,
                    `id: ${record.id} · scope: ${store.scope.kind}${store.scope.repo !== undefined ? ` (${store.scope.repo})` : ''} · layer: ${record.layer}`,
                    `confidence: ${record.confidence.toFixed(2)} · seen: ${record.timesSeen} · recalled: ${record.timesRecalled} · expires: ${record.expiresAt ?? 'permanent'}`,
                    record.tags.length > 0 ? `tags: ${record.tags.join(', ')}` : '',
                    '',
                    record.body,
                    '',
                    `path: ${store.scope.root}/lessons/${record.id}.md`,
                ]
                    .filter((line) => line !== '')
                    .join('\n')
            }
            return `memory record "${args.id}" not found in ${stores.map((s) => `${s.scope.kind}(${s.scope.root})`).join(', ') || 'any open store'}`
        },
    })
}

function statsTool(deps: ToolDeps) {
    return defineTool({
        name: 'memory_stats',
        description:
            'Report memory-store health: record counts per root, pending backlog, expiry, recall usage, task metrics and store capabilities.',
        parameters: {},
        output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(_args, exec) {
            const agent = exec.agent as unknown as AgentLike | undefined
            const stores = targetStores(deps, agent, 'all')
            const lines: string[] = ['memory store status:']
            const capabilities = deps.registry.capabilities
            lines.push(
                `driver: ${capabilities.available ? `node:sqlite ${capabilities.sqliteVersion ?? ''}` : `unavailable (${capabilities.reason ?? 'unknown'})`} · fts5: ${capabilities.fts5 ? 'yes' : 'no'}`,
            )
            if (stores.length === 0) lines.push('no open memory root')
            for (const store of stores) {
                const counts = countRecords(store.db)
                const metrics = summarizeMetrics(store.db)
                lines.push('')
                lines.push(
                    `[${store.scope.kind}] ${store.scope.root}${store.scope.repo !== undefined ? ` (repo ${store.scope.repo})` : ''}`,
                )
                lines.push(
                    `  records: ${counts.total} (active ${counts.active} / pending ${counts.pending} / archived ${counts.archived}) · expired ${counts.expired} · superseded ${counts.superseded}`,
                )
                const usage = store.db
                    .prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN outcome = \'success\' THEN 1 ELSE 0 END) AS ok FROM usage')
                    .get()
                const recallCount = typeof usage?.['n'] === 'number' ? usage['n'] : 0
                const recallOk = typeof usage?.['ok'] === 'number' ? usage['ok'] : 0
                lines.push(`  recalls: ${recallCount} · successful after recall: ${recallOk}`)
                lines.push(
                    `  tasks: ${metrics.tasks} (success ${metrics.success} / partial ${metrics.partial} / failed ${metrics.failed}) · lessons logged: ${metrics.lessons}`,
                )
            }
            return lines.join('\n')
        },
    })
}

function reindexTool(deps: ToolDeps) {
    return defineTool({
        name: 'memory_reindex',
        description:
            'Rebuild the derived SQLite index from the git-tracked text view (lessons/*.md, metrics.jsonl) for this project or globally. Read-only with respect to memory content; use after editing lesson files by hand or after a git pull.',
        parameters: {
            scope: {
                type: 'string',
                enum: ['auto', 'global', 'all'],
                description: 'auto = the scope owning this session.',
            },
            rebuild: {
                type: 'boolean',
                description: 'When true, drop existing records first (full rebuild from disk).',
            },
        },
        output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
            const agent = exec.agent as unknown as AgentLike | undefined
            const targets: MemoryScope[] = []
            targets.push(deps.resolver.resolve({ agent }))
            if (args.scope === 'global' || args.scope === 'all') targets.push(deps.resolver.globalScope())
            const lines: string[] = []
            for (const scope of targets) {
                const imported = deps.registry.reimport(scope)
                deps.registry.exportIndexOnly(scope)
                lines.push(`${scope.kind} (${scope.root}): imported ${imported} lesson file(s)${args.rebuild === true ? ' [rebuild]' : ''}`)
            }
            if (lines.length === 0) lines.push('no scope resolved')
            return lines.join('\n')
        },
    })
}

function formatHit(index: number, record: MemoryRecord, scope: MemoryScope, score: number): string {
    const excerpt = record.body.replace(/\s+/g, ' ').slice(0, 160)
    const flags = [
        `score ${score.toFixed(2)}`,
        `conf ${record.confidence.toFixed(2)}`,
        `seen ${record.timesSeen}`,
        record.expiresAt !== undefined ? `expires ${record.expiresAt}` : 'permanent',
        scope.kind,
    ]
    return `${index}. [${flags.join(' · ')}] ${record.title} (id: ${record.id})\n   ${excerpt}`
}

/** Used by tests and the hook layer: the records a scope currently holds. */
export function recordsOf(store: ScopeStore, limit = 100): MemoryRecord[] {
    return listRecords(store.db, { limit })
}
