/**
 * Model-facing memory tools (DESIGN §9.1).
 *
 * M0 ships the read-only surface (`memory_search`, `memory_get`,
 * `memory_stats`) plus the derived-index repair tool (`memory_reindex`).
 * Writing tools arrive with the learning loop in M2.
 */
import type { Context } from '@deepseek-ai/cordis'
import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryConfig } from '../config.js'
import { log } from '../log.js'
import { rankRecords, normalizeRelevance } from '../recall/rank.js'
import { countRecords, extractTerms, getRecord, listRecords, rawSearch, upsertRecord } from '../store/sqlite/records.js'
import { importLessons } from '../store/import.js'
import { assertInsideScope } from '../store/guard.js'
import { parseLesson } from '../store/frontmatter.js'
import { exportAll } from '../store/export.js'
import { sessionIdOf } from '../scope/resolver.js'
import type { StoreRegistry, ScopeStore } from '../store/store.js'
import type { Layer, MemoryRecord, MemoryScope } from '../store/types.js'
import { ScopeResolver } from '../scope/resolver.js'
import type { AgentLike } from '../scope/resolver.js'
import { recall, renderRecallPack } from '../recall/engine.js'
import type { SessionState } from '../recall/session-state.js'
import { buildQuery } from '../recall/query.js'
import { saveTool, refuseWrite } from './save.js'
import { consolidateTool, forgetTool } from './consolidate.js'
import { syncTool } from './sync.js'
import { statsTool } from './stats.js'
import { rebuildScope } from '../store/rebuild.js'
import { ensureEmbeddings, indexStats } from '../recall/semantic.js'
import type { AutoCommitter } from '../sync/autocommit.js'
import type { EmbeddingProvider, QueryVectorCache } from '../recall/semantic.js'

export interface ToolDeps {
    config: MemoryConfig
    registry: StoreRegistry
    resolver: ScopeResolver
    state: SessionState
    committer: AutoCommitter
    semantic?: { provider?: EmbeddingProvider | undefined; cache?: QueryVectorCache } | undefined
}

type TextOutput = { type: 'string' }

const TEXT_OUTPUT: TextOutput = { type: 'string' }

const LAYER_ENUM = ['project', 'global', 'profile', 'episodic'] as const

/**
 * Outcome of one registration pass. Capabilities (and therefore the prompt
 * protocol) are derived from `registered`/`failed`, never from what the plugin
 * *intended* to register.
 */
export interface ToolRegistration {
    /** Disposers for `ctx.effect`, one per successfully registered tool. */
    disposers: (() => void)[]
    /** Tool names the host actually accepted, in registration order. */
    registered: string[]
    /** Tool names whose `ctx.tools.register` threw. */
    failed: string[]
}

/**
 * Register every tool and report what the host accepted: `disposers` for
 * `ctx.effect`, plus the names that registered and the names that failed, which
 * is what the prompt capabilities are derived from.
 */
export function registerTools(ctx: Context, deps: ToolDeps): ToolRegistration {
    const disposers: (() => void)[] = []
    const registered: string[] = []
    const failed: string[] = []
    const register = (definition: ReturnType<typeof defineTool>): void => {
        try {
            disposers.push(ctx.tools.register(definition))
            registered.push(definition.name)
        } catch (error) {
            failed.push(definition.name)
            // Not fatal — but a half-registered surface must not be advertised:
            // `src/index.ts` derives the protocol capabilities from this result.
            log(
                'warn',
                `memory: registering tool ${definition.name} failed — it is unavailable and the protocol section will not advertise it:`,
                error,
            )
        }
    }

    register(saveTool(deps))
    register(consolidateTool(deps))
    register(syncTool(deps))
    register(forgetTool(deps))
    register(recallTool(deps))
    register(searchTool(deps))
    register(getTool(deps))
    register(statsTool(deps))
    register(reindexTool(deps))
    register(configTool(deps))
    register(importTool(deps))
    return { disposers, registered, failed }
}

/** Which open stores a call should consult. */
function targetStores(deps: ToolDeps, agent: AgentLike | undefined, scope: 'auto' | 'project' | 'global' | 'all'): ScopeStore[] {
    const primary = deps.registry.open(deps.resolver.resolve({ agent }))
    const stores: ScopeStore[] = []
    // An explicit scope means exactly that scope: `global` used to still include
    // the session root, and the search tool collapsed `project`/`global` into
    // 'auto', so the parameter only ever worked for 'all'.
    if (scope !== 'global' && primary !== undefined) stores.push(primary)
    if (scope === 'global' || scope === 'all') {
        const global = deps.registry.open(deps.resolver.globalScope())
        if (global !== undefined && !stores.some((store) => store.scope.root === global.scope.root)) stores.push(global)
    }
    return stores
}

function recallTool(deps: ToolDeps) {
    return defineTool({
        name: 'memory_recall',
        description:
            'Fetch the memory pack for a task in one call: project memory plus keyword-matched global lessons, already ranked and trimmed to a token budget. Use it when you want the full recall set explicitly (the same pack is injected automatically at the start of each turn).',
        parameters: {
            task: {
                type: 'string',
                required: true,
                description: 'Task description, question or keywords to recall memory for.',
            },
            budgetTokens: { type: 'number', description: 'Token budget for the pack (default from config, capped at 4000).' },
            maxItems: { type: 'number', description: 'Maximum records to include (default from config, capped at 20).' },
            includeGlobal: { type: 'boolean', description: 'Also search global memory (default: yes for project sessions).' },
            layer: { type: 'string', enum: [...LAYER_ENUM], description: 'Restrict recall to one memory layer.' },
        },
        output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
            const agent = exec.agent as unknown as AgentLike | undefined
            const query = buildQuery([{ content: [{ type: 'text', text: args.task }] }])
            if (query.terms.length === 0) return 'task text contained no searchable terms'
            // A model-supplied budget must not blow up the calling context.
            const budgetTokens =
                args.budgetTokens !== undefined
                    ? Math.max(50, Math.min(4_000, Math.floor(args.budgetTokens)))
                    : undefined
            const maxItems = args.maxItems !== undefined ? Math.max(1, Math.min(20, Math.floor(args.maxItems))) : undefined
            const sessionId = exec.agent === undefined ? undefined : (exec.agent as unknown as AgentLike).session?.id
            const outcome = await recall(deps, {
                agent,
                terms: query.terms,
                text: args.task,
                ...(args.layer !== undefined
                    ? { layers: [args.layer as Layer] }
                    : deps.config.recall.layers.length > 0
                      ? { layers: deps.config.recall.layers }
                      : {}),
                ...(budgetTokens !== undefined ? { budgetTokens } : {}),
                ...(maxItems !== undefined ? { maxItems } : {}),
                ...(args.includeGlobal !== undefined ? { includeGlobal: args.includeGlobal } : {}),
                exclude: (id) => typeof sessionId === 'string' && deps.state.hasInjected(sessionId, id),
            })
            if (outcome.hits.length === 0) {
                return `no memory matched "${args.task}" (considered ${outcome.considered} record(s) in ${outcome.scopes.map((scope) => scope.kind).join(' + ') || 'no scope'})`
            }
            return renderRecallPack(outcome.hits, outcome.dropped)
        },
    })
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
                enum: ['auto', 'project', 'global', 'all'],
                description:
                    'auto = the scope owning this session plus global; project = this session only; global = global memory only; all = the same as auto.',
            },
        },
        output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
            const agent = exec.agent as unknown as AgentLike | undefined
            const stores = targetStores(deps, agent, args.scope ?? 'auto')
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
            embeddings: {
                type: 'boolean',
                description: 'Also (re)build the semantic index for every changed record. Requires semantic.enabled.',
            },
        },
        output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
            const agent = exec.agent as unknown as AgentLike | undefined
            // "Read-only with respect to memory content" still writes: the
            // derived database is dropped/reimported, the index file exported and
            // embeddings stored — so a subagent may not run it either.
            const refusal = refuseWrite(deps, agent, '`memory_reindex` (rebuilding the derived index)')
            if (refusal !== undefined) return refusal
            const targets: MemoryScope[] = []
            targets.push(deps.resolver.resolve({ agent }))
            if (args.scope === 'global' || args.scope === 'all') targets.push(deps.resolver.globalScope())
            const lines: string[] = []
            if (args.embeddings === true) {
                const provider = deps.semantic?.provider
                if (provider === undefined || !deps.config.semantic.enabled) {
                    return 'semantic recall is disabled (set semantic.enabled=true and configure semantic.baseUrl/model)'
                }
                const model = deps.config.semantic.model
                for (const scope of targets) {
                    const store = deps.registry.open(scope)
                    if (store === undefined) continue
                    const embedded = await ensureEmbeddings(store.db, provider, model, { limit: -1 })
                    const stats = indexStats(store.db, model)
                    lines.push(
                        `${scope.kind} (${scope.root}): embedded ${embedded} record(s) — indexed ${stats.indexed}, pending ${stats.pending}${provider.lastError() !== undefined ? ` (last error: ${provider.lastError()})` : ''}`,
                    )
                }
                return lines.join('\n') || 'no scope resolved'
            }
            for (const scope of targets) {
                if (args.rebuild === true) {
                    const store = deps.registry.open(scope)
                    if (store === undefined) {
                        lines.push(`${scope.kind} (${scope.root}): store unavailable`)
                        continue
                    }
                    const result = rebuildScope(store.db, store.scope, store.fts5)
                    lines.push(
                        `${scope.kind} (${scope.root}): rebuilt — imported ${result.imported}, removed ${result.removed}, metrics ${result.metrics}, episodes ${result.episodes}${result.errors.length > 0 ? ` (errors: ${result.errors.join('; ')})` : ''}`,
                    )
                    continue
                }
                const imported = deps.registry.reimport(scope)
                deps.registry.exportIndexOnly(scope)
                lines.push(`${scope.kind} (${scope.root}): imported ${imported} lesson file(s)`)
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

/**
 * `memory_config` — session-scoped quieting (DESIGN §4.2).
 *
 * Deliberately not persistent: it changes how *this* session behaves (turn off
 * automatic recall while debugging), and a fresh session starts with the
 * configured defaults again. Durable switches live in the profile patch.
 */
export function configTool(deps: ToolDeps) {
    return defineTool({
        name: 'memory_config',
        description:
            'Adjust memory behaviour for the current session only (not persisted). Currently: autoRecall=false stops automatic recall injection while the memory tools keep working. Call without arguments to see the effective settings.',
        parameters: {
            autoRecall: { type: 'boolean', description: 'false = stop injecting recalled memory into this session.' },
        },
        output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
            const agent = exec.agent as unknown as AgentLike | undefined
            const sessionId = sessionIdOf(agent)
            if (sessionId === undefined) return 'no session context — memory_config needs an agent session'
            if (args.autoRecall !== undefined) {
                deps.state.setOverride(sessionId, { autoRecall: args.autoRecall })
                log('info', `memory: session ${sessionId.slice(0, 12)}… autoRecall=${args.autoRecall}`)
            }
            const override = deps.state.override(sessionId)
            return [
                `session overrides: autoRecall=${String(override.autoRecall ?? deps.config.recall.autoInject)}`,
                `configured defaults: autoInject=${String(deps.config.recall.autoInject)}, budgetTokens=${deps.config.recall.budgetTokens}, maxItems=${deps.config.recall.maxItems}, minScore=${deps.config.recall.minScore}`,
                'note: overrides last for this session only; durable settings belong in the profile patch.',
            ].join('\n')
        },
    })
}

/**
 * `memory_import` — pull one lesson file into the store (DESIGN §4).
 *
 * The store already adopts files inside its own root on every export; this is
 * for a lesson that lives *elsewhere* (another project, a scratch file) and is
 * worth keeping here.
 */
export function importTool(deps: ToolDeps) {
    return defineTool({
        name: 'memory_import',
        description:
            'Import one lesson markdown file (with the memory frontmatter) into this project or the global store. Use when a lesson was written outside the memory root, e.g. copied from another project. Returns the record id and how it was absorbed.',
        parameters: {
            path: { type: 'string', description: 'Absolute path of the lesson file to import.' },
            layer: { type: 'string', enum: ['project', 'global'], description: 'Target store. Default: project.' },
        },
        output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
            const agent = exec.agent as unknown as AgentLike | undefined
            const refusal = refuseWrite(deps, agent, '`memory_import`')
            if (refusal !== undefined) return refusal
            if (typeof args.path !== 'string' || args.path.trim() === '') return 'rejected: path is required'
            const file = path.resolve(args.path)
            if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return `rejected: ${file} is not a readable file`
            let text: string
            try {
                text = fs.readFileSync(file, 'utf8')
            } catch (error) {
                return `rejected: cannot read ${file} (${error instanceof Error ? error.message : String(error)})`
            }
            const parsed = parseLesson(text)
            if (parsed === undefined) {
                return 'rejected: not a lesson document — it needs the memory frontmatter (title, confidence, expires…).'
            }
            const scope = deps.resolver.resolve({ agent, ...(args.layer === 'global' ? { explicit: 'global' as const } : {}) })
            const store = deps.registry.open(scope)
            if (store === undefined) return 'memory store unavailable (SQLite driver missing or memory root unwritable)'
            const id = path.basename(file, '.md')
            if (id.trim() === '') return 'rejected: the file name must yield a record id'
            // Copying the file into the root and letting the importer adopt it
            // reuses every rule the store already has — dash-equivalent id
            // merging, evidence gap-filling, "no new information means no merge" —
            // instead of a raw upsert that would replace detail rows with counts.
            const lessons = path.join(store.scope.root, 'lessons')
            const target = path.join(lessons, `${id}.md`)
            try {
                assertInsideScope(store.scope, target)
                fs.mkdirSync(lessons, { recursive: true })
                if (fs.existsSync(target) && path.resolve(target) !== file) {
                    return `rejected: ${target} already exists in this store — import would overwrite it`
                }
                if (path.resolve(target) !== file) fs.copyFileSync(file, target)
            } catch (error) {
                return `rejected: cannot place the lesson in ${lessons} (${error instanceof Error ? error.message : String(error)})`
            }
            const before = countRecords(store.db).total
            const report = importLessons(store.db, store.scope)
            exportAll(store.db, store.scope)
            const after = countRecords(store.db).total
            return [
                `${after > before ? 'imported' : 'merged into an existing record'} ${id} → ${scope.kind} store`,
                `title: ${parsed.frontmatter.title}`,
                `confidence: ${parsed.frontmatter.confidence}, expires: ${parsed.frontmatter.expires}`,
                `importer: scanned ${report.scanned}, imported ${report.imported}, merged ${report.merged}, skipped ${report.skipped}`,
                `root: ${scope.root}`,
            ].join('\n')
        },
    })
}
