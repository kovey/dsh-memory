/**
 * `memory_save` — the model-facing write door (DESIGN §8).
 *
 * Routing is deliberate: project memory by default, global only for
 * cross-project toolchain facts (or when the caller insists). Every write goes
 * through the same gate as automatic distillation, so hand-written memory and
 * distilled memory cannot diverge in quality rules.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
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
                enum: ['project', 'global'],
                description: 'Where to store it. Default: project. Global is only for cross-project toolchain facts.',
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
            if (!deps.resolver.mayWrite(agent)) {
                return 'refused: subagent sessions do not author memory (routing.subagentWrite is off)'
            }
            const scope = deps.resolver.resolve({ agent, ...(args.layer === 'global' ? { explicit: 'global' as const } : {}) })
            const store = deps.registry.open(scope)
            if (store === undefined) return 'memory store unavailable (SQLite driver missing or memory root unwritable)'

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
                title: args.title,
                body: args.body,
                confidence: typeof args.confidence === 'number' ? args.confidence : evidenceKind === 'self-report' ? 0.6 : 0.8,
                ...(args.tags !== undefined ? { tags: args.tags } : {}),
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
