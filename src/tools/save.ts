/**
 * `memory_save` — the model-facing write door (DESIGN §8).
 *
 * Routing is deliberate: project memory by default, global only for
 * cross-project toolchain facts (or when the caller insists). Every write goes
 * through the same gate as automatic distillation, so hand-written memory and
 * distilled memory cannot diverge in quality rules.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendPreference } from '../learn/profile.js'
import { log } from '../log.js'
import { applyDraft } from '../learn/gate.js'
import type { CandidateDraft } from '../learn/gate.js'
import { ScopeResolver, sessionIdOf } from '../scope/resolver.js'
import type { AgentLike } from '../scope/resolver.js'
import type { StoreRegistry } from '../store/store.js'
import type { Evidence, EvidenceKind } from '../store/types.js'
import type { MemoryConfig } from '../config.js'

export interface SaveToolDeps {
    config: MemoryConfig
    registry: StoreRegistry
    resolver: ScopeResolver
}

const TEXT_OUTPUT = { type: 'string' } as const

const EVIDENCE_KINDS: readonly EvidenceKind[] = [
    'tool-failure',
    'request-error',
    'user-correction',
    'rework',
    'permission-prompt',
    'test-failure',
    'user-statement',
    'self-report',
]

/** `permanent` | `30d` | `2026-12-31` → expiry date or undefined. */
export function parseTtl(ttl: string | undefined, now = new Date()): string | undefined {
    if (ttl === undefined || ttl === '' || ttl === 'permanent') return undefined
    const relative = /^(\d+)d$/.exec(ttl.trim())
    if (relative !== null) {
        const days = Number(relative[1])
        if (!Number.isFinite(days) || days <= 0) return undefined
        return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10)
    }
    return /^\d{4}-\d{2}-\d{2}$/.test(ttl.trim()) ? ttl.trim() : undefined
}

/** The evidence kind the caller passed, before defaults are applied. */
function evidenceKind0(args: { evidence?: string }): string {
    return args.evidence ?? 'self-report'
}

/** Caps that keep a model from bloating the text view or the memory pack. */
export const MAX_SAVE_BODY_CHARS = 4_000
export const MAX_SAVE_TITLE_CHARS = 120
export const MAX_SAVE_TAGS = 8

/**
 * The one refusal text every write-class tool returns to a subagent
 * (`routing.subagentWrite` off). Shared verbatim so the model gets the same
 * explanation no matter which write door it tried.
 */
export function subagentWriteRefusal(operation: string): string {
    return [
        `refused: ${operation} writes memory, and subagent sessions do not write memory by default (routing.subagentWrite is off).`,
        'A subagent may search, read and report; saving, archiving, rebuilding, syncing/pushing a memory repo and freezing a baseline stay with the top-level session.',
        'To allow subagent writes, set routing.subagentWrite=true in the dsh-memory config.',
    ].join('\n')
}

/**
 * `undefined` when `agent` may perform a memory-writing operation, otherwise the
 * refusal text to return verbatim *before* touching anything.
 *
 * Every write door goes through this — `memory_save`, `memory_forget`,
 * `memory_consolidate` (when it applies), `memory_sync`, `memory_reindex` and
 * `memory_stats(setBaseline)` — so a subagent hits the same wall on all of them
 * and can never perform a partial write first.
 */
export function refuseWrite(
    deps: { resolver: ScopeResolver },
    agent: AgentLike | undefined,
    operation: string,
): string | undefined {
    return deps.resolver.mayWrite(agent) ? undefined : subagentWriteRefusal(operation)
}

export function saveTool(deps: SaveToolDeps) {
    return defineTool({
        name: 'memory_save',
        description:
            'Record a durable lesson in agent memory. Use it when a real trap was hit and fixed, when the user explicitly asks you to remember something, or when a workflow proved reliably better. Defaults to project memory; use layer "global" only for cross-project toolchain facts (harness/plugin behaviour, sandbox rules, generic scripts). The write is deduplicated and merged with similar existing lessons.',
        parameters: {
            title: { type: 'string', required: true, description: 'Short lesson title (becomes the record id).' },
            body: {
                type: 'string',
                required: true,
                description:
                    'Trigger situation + the correct action (include the exact command, flag or path). Vague advice is rejected.',
            },
            layer: {
                type: 'string',
                enum: ['project', 'global', 'profile'],
                description:
                    'Where to store it. Default: project. Global is only for cross-project toolchain facts; profile (L5) is for a standing preference the user stated — it is also written to profile/preferences.md and stays resident in the prompt.',
            },
            confidence: { type: 'number', description: '0..1. Verified fixes ≈0.9; observations ≈0.7; guesses ≤0.6.' },
            ttl: { type: 'string', description: '"permanent" (default), "30d"/"180d", or an ISO date.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional keywords.' },
            evidence: {
                type: 'string',
                enum: [...EVIDENCE_KINDS],
                description: 'What backs this lesson: tool-failure, user-correction, test-failure, self-report…',
            },
            evidenceDetail: { type: 'string', description: 'One-line description of the concrete evidence.' },
        },
        output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
            const agent = exec.agent as unknown as AgentLike | undefined
            const refusal = refuseWrite(deps, agent, '`memory_save`')
            if (refusal !== undefined) return refusal
            const title = args.title.trim().slice(0, MAX_SAVE_TITLE_CHARS)
            const body = args.body.trim()
            if (title.length < 4) return 'rejected: title is too short to be a useful lesson id'
            if (body.length > MAX_SAVE_BODY_CHARS) {
                return `rejected: body is ${body.length} characters (limit ${MAX_SAVE_BODY_CHARS}). Keep the trigger situation plus the concrete action; put longer detail in the project's docs instead.`
            }
            // `routing.defaultScope` is the user's configured default layer; an
            // explicit `layer` argument still wins.
            const explicitGlobal = args.layer === 'global' || (args.layer === undefined && deps.config.routing.defaultScope === 'global')
            const scope = deps.resolver.resolve({ agent, ...(explicitGlobal ? { explicit: 'global' as const } : {}) })
            const store = deps.registry.open(scope)
            if (store === undefined) return 'memory store unavailable (SQLite driver missing or memory root unwritable)'

            // L5 (DESIGN §3): a standing preference is *also* written to the
            // plain-markdown profile layer, which the resident prompt section
            // reads — that is what makes it effective without being recalled.
            // Only a user-stated preference belongs here, so require that the
            // caller says so explicitly.
            if (args.layer === 'profile') {
                if (evidenceKind0(args) !== 'user-statement') {
                    return 'rejected: the profile layer holds standing user preferences — pass evidence="user-statement" (and only when the user actually stated one).'
                }
                const file = appendPreference(store.scope, `${title}：${body}`)
                if (file === undefined) return 'rejected: could not write the profile layer for this scope'
            }
            const evidenceKind = (args.evidence ?? 'self-report') as EvidenceKind
            const evidence: Evidence[] = [
                {
                    kind: evidenceKind,
                    ...(args.evidenceDetail !== undefined ? { detail: args.evidenceDetail } : {}),
                    at: new Date().toISOString(),
                },
            ]
            const sessionId = sessionIdOf(agent)
            const draft: CandidateDraft = {
                title,
                body,
                confidence: typeof args.confidence === 'number' ? args.confidence : evidenceKind === 'self-report' ? 0.6 : 0.8,
                ...(args.tags !== undefined ? { tags: args.tags.slice(0, MAX_SAVE_TAGS) } : {}),
                ...(parseTtl(args.ttl) !== undefined ? { expiresAt: parseTtl(args.ttl) as string } : {}),
                evidence,
                origin: 'user',
                ...(sessionId !== undefined ? { source: { sessionId } } : {}),
            }

            try {
                const result = applyDraft(store.db, store.scope, store.fts5, draft)
                if (result.action === 'reject') {
                    return `rejected by the memory gate: ${result.reason}. Write a concrete trigger + action (include command/flag/path), or raise confidence if the fix was verified.`
                }
                deps.registry.exportScope(store.scope)
                const where = scope.kind === 'project' ? `项目记忆 (${scope.repo ?? scope.root})` : '全局记忆'
                const verb = result.action === 'merge' ? 'merged into existing lesson' : 'saved'
                return [
                    `${verb}: ${result.recordId}`,
                    `scope: ${where}`,
                    `confidence: ${result.confidence.toFixed(2)} · status: ${result.record?.status ?? 'active'}`,
                    `path: ${scope.root}/lessons/${result.recordId}.md`,
                    result.action === 'merge' ? `merge reason: ${result.reason}` : '',
                ]
                    .filter((line) => line !== '')
                    .join('\n')
            } catch (error) {
                log('error', 'memory: save failed:', error)
                return `memory save failed: ${error instanceof Error ? error.message : String(error)}`
            }
        },
    })
}
