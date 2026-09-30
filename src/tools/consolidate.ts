/**
 * `memory_consolidate` and `memory_forget` (DESIGN §8, §11 M3).
 *
 * Consolidation is safe by default: without `dryRun: false` nothing is written,
 * and contradicting lessons are only *proposed* for supersession unless the
 * caller passes `resolveConflicts`. Promotion to a skill is never automatic —
 * the pass leaves a reviewable `proposals/<id>.SKILL.md` draft and an open
 * proposal; installing that skill into the host's skills directory happens only
 * when a human accepts the proposal (`acceptProposal`).
 *
 * `memory_forget` retires either one named record or a reviewed *selection*
 * (query/layer/olderThanDays), and the selection is a dry run by default: a
 * bulk archive that listed nothing first is how a store loses its good records.
 */
import fs from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DatabaseSync } from 'node:sqlite'
import type { MemoryConfig } from '../config.js'
import { log } from '../log.js'
import { consolidate, openProposals, renderReport, resolveProposal } from '../learn/consolidate.js'
import { installSkillDraft, pruneSkillDrafts, renderSkillDraft, skillDraftPath } from '../learn/promote.js'
import { ScopeResolver } from '../scope/resolver.js'
import type { AgentLike } from '../scope/resolver.js'
import { getRecord, listRecords } from '../store/sqlite/records.js'
import type { StoreRegistry } from '../store/store.js'
import type { Layer, MemoryRecord, MemoryScope } from '../store/types.js'
import { refuseWrite } from './save.js'

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
            'Run a memory-quality pass over one scope: expire and archive stale lessons, halve confidence of unreinforced records, detect contradicting lessons, and propose skills for repeatedly-verified lessons. Dry-run by default — pass dryRun=false to apply. Promotion proposals are never installed automatically: a pass writes a reviewable proposals/<id>.SKILL.md draft, and acceptProposal (a human decision) installs it into the host skills directory.',
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
                description:
                    'Record id whose promotion proposal the user approved. Installs the reviewed draft as <dsh home>/skills/<name>/SKILL.md (creating the directory), marks the proposal accepted and reports the path; the host loads it after a restart.',
            },
            overwrite: {
                type: 'boolean',
                description:
                    'With acceptProposal only: replace an existing skill whose content differs. Default false — a differing file is refused so a hand-written skill is never clobbered silently.',
            },
            rejectProposal: { type: 'string', description: 'Record id whose promotion proposal the user declined (its draft file is removed).' },
        },
        output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
            const agent = exec.agent as unknown as AgentLike | undefined
            // `dryRun` (the default) and `listProposals` only read; everything
            // else archives, decays, supersedes or closes a proposal — a write.
            const applies =
                args.dryRun === false || args.acceptProposal !== undefined || args.rejectProposal !== undefined
            if (applies) {
                const refusal = refuseWrite(deps, agent, '`memory_consolidate` with dryRun=false or a proposal decision')
                if (refusal !== undefined) return refusal
            }
            const targets = resolveTargets(deps, agent, args.scope ?? 'auto')
            if (targets.length === 0) return 'memory store unavailable'

            if (args.acceptProposal !== undefined || args.rejectProposal !== undefined) {
                const target = args.acceptProposal ?? args.rejectProposal ?? ''
                const accepting = args.acceptProposal !== undefined
                const lines: string[] = []
                for (const scope of targets) {
                    const store = deps.registry.open(scope)
                    if (store === undefined) continue
                    const where = scope.kind === 'project' ? `project:${scope.repo ?? scope.root}` : 'global'
                    if (!accepting) {
                        const closed = resolveProposal(store.db, target, 'rejected')
                        // A rejected promotion leaves no draft behind: the file
                        // exists to be reviewed, and its proposal is gone.
                        const open = openProposals(store.db, 500).map((proposal) => proposal.recordId)
                        const removed = pruneSkillDrafts(scope, open)
                        if (closed > 0 || removed > 0) {
                            lines.push(
                                `rejected proposal for ${target} (${where})${removed > 0 ? ` — removed ${removed} draft(s)` : ''}`,
                            )
                        }
                        continue
                    }
                    const record = getRecord(store.db, target)
                    if (record === undefined) {
                        lines.push(`not found: no record "${target}" in ${where}`)
                        continue
                    }
                    // The reviewed artefact is the draft file; re-rendering is
                    // only the fallback for a draft that was pruned by hand.
                    const draft = readDraft(scope, record)
                    const install = installSkillDraft(deps.resolver.home(), draft, {
                        overwrite: args.overwrite === true,
                    })
                    if (install.action === 'invalid-name' || install.action === 'conflict' || install.action === 'failed') {
                        // Nothing landed, so the proposal stays open: a promotion
                        // reported as accepted but not installed is worse than a
                        // refusal the caller can act on.
                        lines.push(`acceptProposal for ${target} (${where}): ${install.message}`)
                        continue
                    }
                    const closed = resolveProposal(store.db, target, 'accepted')
                    log(
                        'info',
                        `memory: promotion accepted for ${target} (${where}) — ${install.message}${closed === 0 ? ' (no open proposal row)' : ''}`,
                    )
                    lines.push(`accepted proposal for ${target} (${where}) — ${install.message}`)
                    lines.push(
                        `  the host loads it after a restart (or in a new session): ${install.file}`,
                    )
                    lines.push('  the lesson itself stays in memory until it is demoted')
                    if (install.action === 'unchanged') lines.push('  (already installed — nothing was rewritten)')
                    if (closed === 0) lines.push('  note: no open proposal row matched this record')
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
            'Retire memory records (archive them, keeping the files under archive/lessons for review — never delete). Two shapes: one record by `id` (archived immediately), or a *selection* by `query`/`layer`/`olderThanDays`, which is a dry run by default: call it once to see the list (id, title and why each matched), then call it again with dryRun=false to archive that list. Use it when a lesson turned out to be wrong or obsolete, or when the user asks to forget something.',
        parameters: {
            id: { type: 'string', description: 'Single-record mode: record id (slug) to retire. Omit it to forget a selection.' },
            query: { type: 'string', description: 'Selection mode: keep records whose title or body contains this text (case-insensitive).' },
            layer: {
                type: 'string',
                enum: ['project', 'global', 'profile', 'episodic'],
                description: 'Selection mode: only records in this layer.',
            },
            olderThanDays: {
                type: 'number',
                description: 'Selection mode: only records not updated in the last N days (a record a merge refreshed is not stale).',
            },
            dryRun: {
                type: 'boolean',
                description:
                    'Selection mode: default true — list what would be archived and change nothing; pass false to archive. With an explicit `id`, the archive happens immediately unless dryRun=true is passed explicitly.',
            },
            limit: {
                type: 'number',
                description: 'Selection mode: cap on records archived in one call (default learn.bulkForgetLimit). The list is oldest-first, so the stalest go.',
            },
            reason: { type: 'string', description: 'Why it is being retired (recorded in the run log and the audit row).' },
            scope: { type: 'string', enum: ['auto', 'global', 'all'], description: 'Where to look for the record(s).' },
        },
        output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
            const agent = exec.agent as unknown as AgentLike | undefined
            // Archiving is always a write: check before resolving targets so no
            // scope is even opened for a caller that may not write. (That also
            // means a selection dry run is refused for a subagent: it is the
            // first half of an archive, and the guard has to be the same on both.)
            const refusal = refuseWrite(deps, agent, '`memory_forget` (archiving a record)')
            if (refusal !== undefined) return refusal
            const targets = resolveTargets(deps, agent, args.scope ?? 'auto')
            const id = args.id?.trim() ?? ''
            if (id === '') {
                return bulkForget(deps, targets, {
                    ...(args.query !== undefined ? { query: args.query } : {}),
                    ...(args.layer !== undefined ? { layer: args.layer } : {}),
                    ...(args.olderThanDays !== undefined ? { olderThanDays: args.olderThanDays } : {}),
                    dryRun: args.dryRun !== false,
                    limit: Math.max(
                        1,
                        Math.floor(args.limit ?? deps.config.learn.bulkForgetLimit),
                    ),
                    ...(args.reason !== undefined ? { reason: args.reason } : {}),
                })
            }
            for (const scope of targets) {
                const store = deps.registry.open(scope)
                if (store === undefined) continue
                const existing = store.db.prepare('SELECT title, status FROM records WHERE id = ?').get(id)
                if (existing === undefined) continue
                const title = typeof existing['title'] === 'string' ? existing['title'] : id
                if (args.dryRun === true) {
                    return [
                        'dry-run — nothing archived:',
                        `  · ${id} (${title})`,
                        `pass dryRun: false to move the file to ${scope.root}/archive/lessons/${id}.md (archived ≠ deleted)`,
                    ].join('\n')
                }
                try {
                    store.db
                        .prepare("UPDATE records SET status = 'archived', updated_at = ? WHERE id = ?")
                        .run(new Date().toISOString(), id)
                    store.db
                        .prepare("INSERT INTO consolidate_runs (at, project, archived, decayed, conflicts, proposals, note) VALUES (?, ?, 1, 0, 0, 0, ?)")
                        .run(new Date().toISOString(), scope.kind === 'project' ? `project:${scope.repo ?? scope.root}` : 'global', `forget ${id}: ${args.reason ?? 'no reason given'}`)
                    deps.registry.exportScope(store.scope)
                } catch (error) {
                    log('error', `memory: forget ${id} failed:`, error)
                    return `failed to retire ${id}: ${error instanceof Error ? error.message : String(error)}`
                }
                return [
                    `retired: ${id} (${title})`,
                    `scope: ${scope.kind}${scope.repo !== undefined ? ` (${scope.repo})` : ''}`,
                    `file moved to: ${scope.root}/archive/lessons/${id}.md`,
                    `reason: ${args.reason ?? 'not given'}`,
                ].join('\n')
            }
            return `record "${id}" not found in ${targets.map((scope) => scope.kind).join(' + ') || 'any scope'}`
        },
    })
}

/** Which roots a consolidation call should touch. */
function resolveTargets(deps: ConsolidateToolDeps, agent: AgentLike | undefined, scope: string): MemoryScope[] {
    // `scope: 'global'` means "the global root only": always including the
    // session's own root made it an alias of 'all', so a global pass also
    // decayed, archived and rewrote the project store.
    const targets: MemoryScope[] = scope === 'global' ? [] : [deps.resolver.resolve({ agent })]
    if (scope === 'global' || scope === 'all') {
        const global = deps.resolver.globalScope()
        if (!targets.some((candidate) => candidate.root === global.root)) targets.push(global)
    }
    return targets
}

/** One record a bulk forget would archive, with the reason it matched. */
export interface ForgetTarget {
    id: string
    title: string
    layer: Layer
    updatedAt: string
    /** Why this record is in the list — one clause per criterion that matched. */
    reason: string
}

/**
 * Records a bulk forget would touch.
 *
 * Only `active`/`pending` records are candidates: archiving an archived record
 * is a no-op, and listing them would make the pre-flight count a lie. The result
 * is oldest-first (by `updated_at`), so when `limit` truncates the list it is
 * the stalest records that are dropped from it.
 */
export function selectForgetTargets(
    db: DatabaseSync,
    options: { query?: string; layer?: Layer; olderThanDays?: number; now?: Date } = {},
): ForgetTarget[] {
    const now = options.now ?? new Date()
    const query = options.query?.trim().toLowerCase() ?? ''
    const cutoff =
        options.olderThanDays !== undefined && options.olderThanDays > 0
            ? new Date(now.getTime() - options.olderThanDays * 86_400_000).toISOString()
            : undefined
    const records = listRecords(db, {
        status: ['active', 'pending'],
        ...(options.layer !== undefined ? { layers: [options.layer] } : {}),
    })
    const matched: ForgetTarget[] = []
    for (const record of records) {
        const reasons: string[] = []
        if (query !== '') {
            const inTitle = record.title.toLowerCase().includes(query)
            const inBody = record.body.toLowerCase().includes(query)
            if (!inTitle && !inBody) continue
            const shown = options.query?.trim() ?? query
            reasons.push(
                inTitle ? `query "${shown}" matches the title` : `query "${shown}" matches the body`,
            )
        }
        if (cutoff !== undefined) {
            if (record.updatedAt >= cutoff) continue
            reasons.push(`not updated since ${record.updatedAt.slice(0, 10)} (older than ${options.olderThanDays}d)`)
        }
        matched.push({
            id: record.id,
            title: record.title,
            layer: record.layer,
            updatedAt: record.updatedAt,
            reason: reasons.length > 0 ? reasons.join('; ') : 'selected by the layer/scope filter',
        })
    }
    matched.sort((a, b) => (a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : a.updatedAt < b.updatedAt ? -1 : 1))
    return matched
}

/**
 * The selection half of `memory_forget`.
 *
 * A bulk archive has no undo, so it is a dry run unless the caller says
 * otherwise, and a selection without a single criterion is refused outright:
 * "forget everything the store happens to hold" is never what a caller means.
 */
async function bulkForget(
    deps: ConsolidateToolDeps,
    targets: readonly MemoryScope[],
    options: {
        query?: string
        layer?: Layer
        olderThanDays?: number
        dryRun: boolean
        limit: number
        reason?: string
    },
): Promise<string> {
    const criteria: string[] = []
    if (options.query !== undefined && options.query.trim() !== '') criteria.push(`query "${options.query.trim()}"`)
    if (options.layer !== undefined) criteria.push(`layer ${options.layer}`)
    if (options.olderThanDays !== undefined) criteria.push(`not updated for ${options.olderThanDays}d`)
    if (criteria.length === 0) {
        return [
            'refused: a bulk forget needs at least one criterion — pass `query`, `layer` or `olderThanDays` (or `id` to retire a single record).',
            'Without one, this call would archive whatever the store happens to hold.',
        ].join('\n')
    }
    const label = criteria.join(' + ')
    const lines: string[] = []
    for (const scope of targets) {
        const store = deps.registry.open(scope)
        if (store === undefined) continue
        const where = scope.kind === 'project' ? `project:${scope.repo ?? scope.root}` : 'global'
        const matched = selectForgetTargets(store.db, {
            ...(options.query !== undefined ? { query: options.query } : {}),
            ...(options.layer !== undefined ? { layer: options.layer } : {}),
            ...(options.olderThanDays !== undefined ? { olderThanDays: options.olderThanDays } : {}),
        })
        const selected = matched.slice(0, options.limit)
        lines.push(
            `${options.dryRun ? 'dry-run (nothing archived)' : 'bulk forget'} — ${where} — ${matched.length} record(s) match [${label}]`,
        )
        for (const item of selected) lines.push(`  · ${item.id} — ${item.title} — ${item.reason}`)
        if (matched.length > selected.length) {
            lines.push(
                `  … ${matched.length - selected.length} more match(es) beyond limit ${options.limit} — narrow the criteria or pass a larger limit`,
            )
        }
        if (matched.length === 0) {
            lines.push('  nothing to do — no record matches (archived records are not candidates)')
            continue
        }
        if (options.dryRun) {
            lines.push(
                `re-run with dryRun: false to archive these ${selected.length} record(s) — archived ≠ deleted: files move to ${scope.root}/archive/lessons/`,
            )
            continue
        }
        const at = new Date().toISOString()
        const failures: string[] = []
        let archived = 0
        for (const item of selected) {
            try {
                const result = store.db
                    .prepare("UPDATE records SET status = 'archived', updated_at = ? WHERE id = ?")
                    .run(at, item.id)
                // Count what the database actually changed: a record that
                // disappeared between the listing and the write is not archived.
                if (Number(result.changes ?? 0) > 0) archived += 1
                else failures.push(`${item.id}: nothing to archive (record no longer present)`)
            } catch (error) {
                failures.push(`${item.id}: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
        if (archived > 0) {
            store.db
                .prepare('INSERT INTO consolidate_runs (at, project, archived, decayed, conflicts, proposals, note) VALUES (?, ?, ?, 0, 0, 0, ?)')
                .run(at, where, archived, `bulk forget [${label}]: ${options.reason ?? 'no reason given'}`)
            deps.registry.exportScope(store.scope)
            log('info', `memory: bulk forget archived ${archived} record(s) in ${where} [${label}]`)
        }
        lines.push(
            `archived ${archived} of ${selected.length} selected record(s) — files moved to ${scope.root}/archive/lessons/`,
        )
        if (failures.length > 0) lines.push(`errors: ${failures.join('; ')}`)
    }
    return lines.join('\n') || 'memory store unavailable'
}

/**
 * The draft a human reviewed.
 *
 * The file is preferred over a fresh render: it is the artefact the approval
 * referred to, and re-rendering would silently install whatever the record says
 * today (provenance date included). A missing draft is the one case where
 * rendering from the record is the only way to install the skill at all.
 */
function readDraft(scope: MemoryScope, record: MemoryRecord): string {
    const file = skillDraftPath(scope, record)
    if (file !== undefined) {
        try {
            return fs.readFileSync(file, 'utf8')
        } catch {
            // pruned or unreadable — fall through to a fresh render
        }
    }
    return renderSkillDraft(record)
}
