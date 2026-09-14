/**
 * `memory_consolidate` and `memory_forget` (DESIGN §8, §11 M3).
 *
 * Consolidation is safe by default: without `dryRun: false` nothing is written,
 * and contradicting lessons are only *proposed* for supersession unless the
 * caller passes `resolveConflicts`. Promotion to a skill is never automatic —
 * it is a proposal a human accepts through the `memory-merge` skill.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryConfig } from '../config.js'
import { log } from '../log.js'
import { consolidate, openProposals, renderReport, resolveProposal } from '../learn/consolidate.js'
import { ScopeResolver } from '../scope/resolver.js'
import type { AgentLike } from '../scope/resolver.js'
import type { StoreRegistry } from '../store/store.js'
import type { MemoryScope } from '../store/types.js'

export interface ConsolidateToolDeps {
    config: MemoryConfig
    registry: StoreRegistry
    resolver: ScopeResolver
}

const TEXT_OUTPUT = { type: 'string' } as const

export function consolidateTool(deps: ConsolidateToolDeps) {
    return defineTool({
        name: 'memory_consolidate',
        description:
            'Run a memory-quality pass over one scope: expire and archive stale lessons, halve confidence of unreinforced records, detect contradicting lessons, and propose skills for repeatedly-verified lessons. Dry-run by default — pass dryRun=false to apply. Promotion proposals are always reported, never executed.',
        parameters: {
            scope: {
                type: 'string',
                enum: ['auto', 'global', 'all'],
                description: 'auto = the scope owning this session; all = also the global store.',
            },
            dryRun: { type: 'boolean', description: 'Default true: report only, change nothing.' },
            resolveConflicts: {
                type: 'boolean',
                description: 'When true (and dryRun=false), mark the weaker lesson as superseded by the stronger one.',
            },
            listProposals: { type: 'boolean', description: 'Only list open promotion proposals.' },
            acceptProposal: {
                type: 'string',
                description: 'Record id whose promotion proposal the user approved (closes the proposal).',
            },
            rejectProposal: { type: 'string', description: 'Record id whose promotion proposal the user declined.' },
        },
        output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
            const agent = exec.agent as unknown as AgentLike | undefined
            const targets = resolveTargets(deps, agent, args.scope ?? 'auto')
            if (targets.length === 0) return 'memory store unavailable'

            if (args.acceptProposal !== undefined || args.rejectProposal !== undefined) {
                const target = args.acceptProposal ?? args.rejectProposal ?? ''
                const status = args.acceptProposal !== undefined ? 'accepted' : 'rejected'
                const lines: string[] = []
                for (const scope of targets) {
                    const store = deps.registry.open(scope)
                    if (store === undefined) continue
                    const changed = resolveProposal(store.db, target, status)
                    if (changed > 0) lines.push(`${status} proposal for ${target} (${scope.kind}) — now write the skill yourself, then it is done`)
                }
                return lines.join('\n') || `no open proposal for "${target}"`
            }

            if (args.listProposals === true) {
                const lines: string[] = []
                for (const scope of targets) {
                    const store = deps.registry.open(scope)
                    if (store === undefined) continue
                    const proposals = openProposals(store.db)
                    lines.push(`${scope.kind}${scope.repo !== undefined ? ` (${scope.repo})` : ''}: ${proposals.length} open proposal(s)`)
                    for (const proposal of proposals) {
                        lines.push(`  · ${proposal.title} (${proposal.recordId}) — ${proposal.rationale}`)
                    }
                }
                return lines.join('\n') || 'no open proposals'
            }

            const dryRun = args.dryRun !== false
            const reports: string[] = []
            for (const scope of targets) {
                const store = deps.registry.open(scope)
                if (store === undefined) continue
                const report = consolidate(store.db, store.scope, store.fts5, {
                    dryRun,
                    resolveConflicts: args.resolveConflicts === true && !dryRun,
                })
                reports.push(renderReport(report))
            }
            return reports.join('\n\n') || 'no scope resolved'
        },
    })
}

export function forgetTool(deps: ConsolidateToolDeps) {
    return defineTool({
        name: 'memory_forget',
        description:
            'Retire one memory record (archive it, keeping the file under archive/lessons for review). Use when a lesson turned out to be wrong or obsolete, or when the user asks to forget something.',
        parameters: {
            id: { type: 'string', required: true, description: 'Record id (slug) to retire.' },
            reason: { type: 'string', description: 'Why it is being retired (recorded in the run log).' },
            scope: { type: 'string', enum: ['auto', 'global', 'all'], description: 'Where to look for the record.' },
        },
        output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
            const agent = exec.agent as unknown as AgentLike | undefined
            const targets = resolveTargets(deps, agent, args.scope ?? 'auto')
            for (const scope of targets) {
                const store = deps.registry.open(scope)
                if (store === undefined) continue
                const existing = store.db.prepare('SELECT title, status FROM records WHERE id = ?').get(args.id)
                if (existing === undefined) continue
                const title = typeof existing['title'] === 'string' ? existing['title'] : args.id
                try {
                    store.db
                        .prepare("UPDATE records SET status = 'archived', updated_at = ? WHERE id = ?")
                        .run(new Date().toISOString(), args.id)
                    store.db
                        .prepare("INSERT INTO consolidate_runs (at, project, archived, decayed, conflicts, proposals, note) VALUES (?, ?, 1, 0, 0, 0, ?)")
                        .run(new Date().toISOString(), scope.kind === 'project' ? `project:${scope.repo ?? scope.root}` : 'global', `forget ${args.id}: ${args.reason ?? 'no reason given'}`)
                    deps.registry.exportScope(store.scope)
                } catch (error) {
                    log('error', `memory: forget ${args.id} failed:`, error)
                    return `failed to retire ${args.id}: ${error instanceof Error ? error.message : String(error)}`
                }
                return [
                    `retired: ${args.id} (${title})`,
                    `scope: ${scope.kind}${scope.repo !== undefined ? ` (${scope.repo})` : ''}`,
                    `file moved to: ${scope.root}/archive/lessons/${args.id}.md`,
                    `reason: ${args.reason ?? 'not given'}`,
                ].join('\n')
            }
            return `record "${args.id}" not found in ${targets.map((scope) => scope.kind).join(' + ') || 'any scope'}`
        },
    })
}

/** Which roots a consolidation call should touch. */
function resolveTargets(deps: ConsolidateToolDeps, agent: AgentLike | undefined, scope: string): MemoryScope[] {
    const targets: MemoryScope[] = []
    const primary = deps.resolver.resolve({ agent })
    targets.push(primary)
    if (scope === 'global' || scope === 'all') {
        const global = deps.resolver.globalScope()
        if (!targets.some((candidate) => candidate.root === global.root)) targets.push(global)
    }
    return targets
}

/** Used by tests: accept a proposal without going through the tool surface. */
export function acceptProposal(deps: ConsolidateToolDeps, scope: MemoryScope, recordId: string): number {
    const store = deps.registry.open(scope)
    if (store === undefined) return 0
    return resolveProposal(store.db, recordId, 'accepted')
}
