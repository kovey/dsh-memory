/**
 * `memory_sync` — bring a memory root in line with its remote (DESIGN D6).
 *
 * Pull is always fast-forward-or-rebase; conflicts in the text view are resolved
 * by rule where the shape allows it (`lessons/*.md` merge, `MEMORY.md`
 * regenerate) and reported as `manual` otherwise, with the rebase left intact
 * for a human instead of being force-resolved. Push happens only when the caller
 * explicitly asks for it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryConfig } from '../config.js'
import { log } from '../log.js'
import { ScopeResolver } from '../scope/resolver.js'
import type { AgentLike } from '../scope/resolver.js'
import { exportIndex } from '../store/export.js'
import { rebuildScope } from '../store/rebuild.js'
import type { StoreRegistry } from '../store/store.js'
import type { MemoryScope } from '../store/types.js'
import { AutoCommitter } from '../sync/autocommit.js'
import { abortRebase, continueRebase, ensureRepo, hasRemote, repoRootOf, sync } from '../sync/git.js'
import { assertInsideScope } from '../store/guard.js'
import { hasConflictMarkers, resolveConflict } from '../sync/merge.js'
import type { ConflictResolution } from '../sync/merge.js'

export interface SyncToolDeps {
    config: MemoryConfig
    registry: StoreRegistry
    resolver: ScopeResolver
    committer: AutoCommitter
}

const TEXT_OUTPUT = { type: 'string' } as const

export function syncTool(deps: SyncToolDeps) {
    return defineTool({
        name: 'memory_sync',
        description:
            'Synchronize a memory root with its git remote: commit local changes, fetch, rebase, resolve text-view conflicts by rule, and rebuild the database from the text view. Pushing only happens when push=true is passed explicitly.',
        parameters: {
            scope: { type: 'string', enum: ['auto', 'global', 'all'], description: 'Which memory root to sync.' },
            push: {
                type: 'boolean',
                description: 'Also push after a successful rebase. Only pass true when the user explicitly asked to push.',
            },
            resolveConflicts: {
                type: 'boolean',
                description: 'Resolve text-view conflicts by rule (lessons merge, MEMORY.md regenerates). Default true.',
            },
            rebuild: { type: 'boolean', description: 'Rebuild the database from the text view afterwards (default true).' },
            abortOnManual: {
                type: 'boolean',
                description: 'Abort the rebase when a conflict needs a human. Default false (leaves it for inspection).',
            },
        },
        output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
            const agent = exec.agent as unknown as AgentLike | undefined
            const targets = resolveTargets(deps, agent, args.scope ?? 'auto')
            const lines: string[] = []
            for (const scope of targets) {
                lines.push(...syncOne(deps, scope, {
                    push: args.push === true,
                    resolveConflicts: args.resolveConflicts !== false,
                    rebuild: args.rebuild !== false,
                    abortOnManual: args.abortOnManual === true,
                }))
            }
            return lines.join('\n') || 'no memory root resolved'
        },
    })
}

interface SyncOptions {
    push: boolean
    resolveConflicts: boolean
    rebuild: boolean
    abortOnManual: boolean
}

function syncOne(deps: SyncToolDeps, scope: MemoryScope, options: SyncOptions): string[] {
    const lines = [`[${scope.kind}] ${scope.root}`]
    try {
        ensureRepo(scope.root)
        const local = deps.committer.commitNow(scope, 'pre-sync checkpoint')
        lines.push(`  commit: ${local.committed ? `${local.files} file(s)` : local.detail}`)

        if (!hasRemote(scope.root)) {
            lines.push('  remote: none configured — nothing to fetch (local commits only)')
            if (options.rebuild) lines.push(...rebuildLine(deps, scope))
            return lines
        }

        const outcome = sync(scope.root, { push: options.push })
        lines.push(`  sync: ${outcome.action} — ${outcome.detail}`)

        if (outcome.action === 'conflict') {
            if (!options.resolveConflicts) {
                lines.push(`  conflicts left for review: ${outcome.conflicts.join(', ')}`)
                return lines
            }
            const store = deps.registry.open(scope)
            // `git diff --name-only` reports repo-relative paths: resolving them
            // against the process cwd either failed ("ENOENT → needs a human", so
            // automatic merges never happened) or, worse, wrote the merged lesson
            // to an unrelated file with the same relative path.
            const repoRoot = repoRootOf(scope.root) ?? scope.root
            const resolutions: ConflictResolution[] = outcome.conflicts.map((file) => {
                const absolute = path.resolve(repoRoot, file)
                assertInsideScope(scope, absolute)
                return resolveConflict(absolute, {
                    regenerateIndex: () => {
                        if (store === undefined) return ''
                        exportIndex(store.db, store.scope)
                        return fs.readFileSync(absolute, 'utf8')
                    },
                })
            })
            const manual = resolutions.filter((item) => item.strategy === 'manual')
            const resolved: string[] = []
            for (const item of resolutions) {
                if (item.strategy === 'manual' || item.content === undefined) continue
                if (hasConflictMarkers(item.content)) {
                    manual.push({ ...item, strategy: 'manual', note: 'refusing to write unresolved conflict markers' })
                    continue
                }
                try {
                    fs.writeFileSync(item.path, item.content)
                    resolved.push(item.path)
                    lines.push(`  resolved ${path.basename(item.path)}: ${item.strategy} — ${item.note}`)
                } catch (error) {
                    manual.push({ ...item, strategy: 'manual', note: `write failed: ${message(error)}` })
                }
            }
            if (manual.length > 0) {
                lines.push(`  needs a human: ${manual.map((item) => `${path.basename(item.path)} (${item.note})`).join('; ')}`)
                if (options.abortOnManual) {
                    abortRebase(scope.root)
                    lines.push('  rebase aborted — the working tree is back to its pre-sync state')
                }
                return lines
            }
            const continued = continueRebase(scope.root, resolved)
            lines.push(continued.ok ? '  rebase continued' : `  rebase continue failed: ${continued.stderr.trim()}`)
        }

        if (options.push && (outcome.action === 'pulled' || outcome.action === 'conflict')) {
            const pushed = sync(scope.root, { push: true })
            lines.push(`  push: ${pushed.action} — ${pushed.detail}`)
        }

        if (options.rebuild) lines.push(...rebuildLine(deps, scope))
        return lines
    } catch (error) {
        log('error', `memory: sync failed for ${scope.root}:`, error)
        lines.push(`  error: ${message(error)}`)
        return lines
    }
}

function rebuildLine(deps: SyncToolDeps, scope: MemoryScope): string[] {
    const store = deps.registry.open(scope)
    if (store === undefined) return ['  rebuild: skipped (store unavailable)']
    try {
        const result = rebuildScope(store.db, store.scope, store.fts5)
        return [
            `  rebuild: imported ${result.imported}, removed ${result.removed}, metrics ${result.metrics}, episodes ${result.episodes}${result.errors.length > 0 ? ` (errors: ${result.errors.join('; ')})` : ''}`,
        ]
    } catch (error) {
        return [`  rebuild: failed — ${message(error)}`]
    }
}

function resolveTargets(deps: SyncToolDeps, agent: AgentLike | undefined, scope: string): MemoryScope[] {
    // `scope: 'global'` must not drag the session's own root along: with push
    // enabled that committed and pushed the *project* memory repository.
    const globalOnly = scope === 'global'
    const targets: MemoryScope[] = globalOnly ? [] : [deps.resolver.resolve({ agent })]
    if (scope === 'global' || scope === 'all') {
        const global = deps.resolver.globalScope()
        if (!targets.some((candidate) => candidate.root === global.root)) targets.push(global)
    }
    return targets
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
