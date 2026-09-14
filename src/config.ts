/**
 * Configuration resolution (DESIGN §9.2).
 *
 * Defaults mirror the plugin's own `cordis.patch.yml`; a profile may override
 * any field by re-declaring the same loader id `memory` with a `config:` block.
 * Resolution is total: malformed input falls back to defaults rather than
 * throwing, so a bad profile edit can never break session startup.
 */
import type { Layer } from './store/types.js'

export interface MemoryConfig {
    enabled: boolean
    /** Plugin log file (home-expandable). Never stdout. */
    logFile: string
    /** Override for the dsh home used to locate the global memory root. */
    memoryHome?: string
    routing: {
        defaultScope: 'project' | 'global'
        /** Subagent sessions do not author memory by default (DESIGN §9.3). */
        subagentWrite: boolean
    }
    prompt: {
        protocol: { enabled: boolean; budgetTokens: number; order: number }
        indexSummary: { enabled: boolean; budgetTokens: number; maxTitles: number; order: number }
    }
    recall: {
        autoInject: boolean
        budgetTokens: number
        maxItems: number
        minScore: number
        layers: Layer[]
    }
    learn: {
        collectSignals: boolean
        autoDistill: boolean
        distillModel: { provider: string; model: string }
        maxDistillPerSession: number
        maxDistillTokensPerDay: number
        distillTimeoutMs: number
        minSignals: number
    }
    episodic: {
        enabled: boolean
        retentionDays: number
        captureUserText: 'redacted' | 'full' | 'none'
    }
    consolidate: {
        enabled: boolean
        everyNTasks: number
        everyDays: number
        archiveInsteadOfDelete: boolean
    }
    git: {
        enabled: boolean
        autoCommit: 'off' | 'task-end' | 'immediate'
        checkpointMinutes: number
        /** Never automatic: pushing requires an explicit user instruction. */
        autoPush: false
    }
    sqlite: {
        journalMode: 'wal' | 'delete'
        busyTimeoutMs: number
        fallback: 'none' | 'json'
    }
}

export const DEFAULT_CONFIG: MemoryConfig = {
    enabled: true,
    logFile: '~/.dsh/memory-plugin.log',
    routing: { defaultScope: 'project', subagentWrite: false },
    prompt: {
        protocol: { enabled: true, budgetTokens: 240, order: 60 },
        indexSummary: { enabled: true, budgetTokens: 150, maxTitles: 12, order: 61 },
    },
    recall: {
        autoInject: true,
        budgetTokens: 600,
        maxItems: 5,
        minScore: 0.35,
        layers: ['project', 'global', 'profile'],
    },
    learn: {
        collectSignals: true,
        autoDistill: true,
        distillModel: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        maxDistillPerSession: 3,
        maxDistillTokensPerDay: 200_000,
        distillTimeoutMs: 3_000,
        minSignals: 1,
    },
    episodic: { enabled: true, retentionDays: 90, captureUserText: 'redacted' },
    consolidate: { enabled: true, everyNTasks: 5, everyDays: 7, archiveInsteadOfDelete: true },
    git: { enabled: true, autoCommit: 'task-end', checkpointMinutes: 30, autoPush: false },
    sqlite: { journalMode: 'wal', busyTimeoutMs: 5_000, fallback: 'none' },
}

type Dict = Record<string, unknown>

function obj(value: unknown): Dict {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : {}
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback
}

function num(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, value))
}

function str(value: unknown, fallback: string): string {
    return typeof value === 'string' && value !== '' ? value : fallback
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

const LAYERS: readonly Layer[] = ['project', 'global', 'profile', 'episodic']

function layers(value: unknown, fallback: Layer[]): Layer[] {
    if (!Array.isArray(value)) return fallback
    const picked = value.filter((v): v is Layer => typeof v === 'string' && (LAYERS as readonly string[]).includes(v))
    return picked.length > 0 ? picked : fallback
}

/** Resolve raw loader config into a total, validated configuration. */
export function resolveConfig(raw: unknown): MemoryConfig {
    const root = obj(raw)
    const routing = obj(root['routing'])
    const prompt = obj(root['prompt'])
    const protocol = obj(prompt['protocol'])
    const indexSummary = obj(prompt['indexSummary'])
    const recall = obj(root['recall'])
    const learn = obj(root['learn'])
    const distillModel = obj(learn['distillModel'])
    const episodic = obj(root['episodic'])
    const consolidate = obj(root['consolidate'])
    const git = obj(root['git'])
    const sqlite = obj(root['sqlite'])
    const d = DEFAULT_CONFIG

    const memoryHome = root['memoryHome']
    return {
        enabled: bool(root['enabled'], d.enabled),
        logFile: str(root['logFile'], d.logFile),
        ...(typeof memoryHome === 'string' && memoryHome !== '' ? { memoryHome } : {}),
        routing: {
            defaultScope: oneOf(routing['defaultScope'], ['project', 'global'] as const, d.routing.defaultScope),
            subagentWrite: bool(routing['subagentWrite'], d.routing.subagentWrite),
        },
        prompt: {
            protocol: {
                enabled: bool(protocol['enabled'], d.prompt.protocol.enabled),
                budgetTokens: num(protocol['budgetTokens'], d.prompt.protocol.budgetTokens, 0, 4_000),
                order: num(protocol['order'], d.prompt.protocol.order, -10_000, 10_000),
            },
            indexSummary: {
                enabled: bool(indexSummary['enabled'], d.prompt.indexSummary.enabled),
                budgetTokens: num(indexSummary['budgetTokens'], d.prompt.indexSummary.budgetTokens, 0, 4_000),
                maxTitles: num(indexSummary['maxTitles'], d.prompt.indexSummary.maxTitles, 0, 200),
                order: num(indexSummary['order'], d.prompt.indexSummary.order, -10_000, 10_000),
            },
        },
        recall: {
            autoInject: bool(recall['autoInject'], d.recall.autoInject),
            budgetTokens: num(recall['budgetTokens'], d.recall.budgetTokens, 0, 20_000),
            maxItems: num(recall['maxItems'], d.recall.maxItems, 0, 100),
            minScore: num(recall['minScore'], d.recall.minScore, 0, 1),
            layers: layers(recall['layers'], d.recall.layers),
        },
        learn: {
            collectSignals: bool(learn['collectSignals'], d.learn.collectSignals),
            autoDistill: bool(learn['autoDistill'], d.learn.autoDistill),
            distillModel: {
                provider: str(distillModel['provider'], d.learn.distillModel.provider),
                model: str(distillModel['model'], d.learn.distillModel.model),
            },
            maxDistillPerSession: num(learn['maxDistillPerSession'], d.learn.maxDistillPerSession, 0, 100),
            maxDistillTokensPerDay: num(learn['maxDistillTokensPerDay'], d.learn.maxDistillTokensPerDay, 0, 100_000_000),
            distillTimeoutMs: num(learn['distillTimeoutMs'], d.learn.distillTimeoutMs, 500, 10_000),
            minSignals: num(learn['minSignals'], d.learn.minSignals, 0, 50),
        },
        episodic: {
            enabled: bool(episodic['enabled'], d.episodic.enabled),
            retentionDays: num(episodic['retentionDays'], d.episodic.retentionDays, 1, 3_650),
            captureUserText: oneOf(
                episodic['captureUserText'],
                ['redacted', 'full', 'none'] as const,
                d.episodic.captureUserText,
            ),
        },
        consolidate: {
            enabled: bool(consolidate['enabled'], d.consolidate.enabled),
            everyNTasks: num(consolidate['everyNTasks'], d.consolidate.everyNTasks, 1, 1_000),
            everyDays: num(consolidate['everyDays'], d.consolidate.everyDays, 1, 365),
            archiveInsteadOfDelete: bool(consolidate['archiveInsteadOfDelete'], d.consolidate.archiveInsteadOfDelete),
        },
        git: {
            enabled: bool(git['enabled'], d.git.enabled),
            autoCommit: oneOf(git['autoCommit'], ['off', 'task-end', 'immediate'] as const, d.git.autoCommit),
            checkpointMinutes: num(git['checkpointMinutes'], d.git.checkpointMinutes, 1, 1_440),
            autoPush: false,
        },
        sqlite: {
            journalMode: oneOf(sqlite['journalMode'], ['wal', 'delete'] as const, d.sqlite.journalMode),
            busyTimeoutMs: num(sqlite['busyTimeoutMs'], d.sqlite.busyTimeoutMs, 0, 60_000),
            fallback: oneOf(sqlite['fallback'], ['none', 'json'] as const, d.sqlite.fallback),
        },
    }
}
