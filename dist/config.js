export const DEFAULT_CONFIG = {
    enabled: true,
    logFile: '~/.dsh/memory-plugin.log',
    routing: { defaultScope: 'project', subagentWrite: false },
    prompt: {
        protocol: { enabled: true, budgetTokens: 240, order: 60 },
        indexSummary: { enabled: true, budgetTokens: 150, maxTitles: 12, order: 61, profileBudgetTokens: 200 },
    },
    recall: {
        autoInject: true,
        budgetTokens: 600,
        maxItems: 5,
        minScore: 0.35,
        layers: ['project', 'global', 'profile'],
        sessionToolBudgetTokens: 20_000,
    },
    learn: {
        collectSignals: true,
        autoDistill: true,
        distillModel: { provider: '', model: '' },
        maxDistillPerSession: 3,
        maxDistillTokensPerDay: 200_000,
        // Measured live: a flash-model JSON distillation turn takes >3s, so the
        // old 3s bound aborted every real call. The bound still exists — it just
        // reflects reality; `distillRunner: 'jobs'` is the escape hatch for
        // people who do not want the turn to wait at all.
        distillTimeoutMs: 15_000,
        distillMaxTokens: 2_000,
        distillReasoningEffort: '',
        minSignals: 1,
        distillRunner: 'inline',
        exitCodeSignals: 'strong',
        maxRecoverPerSession: 2,
        recoverBudgetMs: 20_000,
    },
    episodic: { enabled: true, retentionDays: 90, captureUserText: 'redacted' },
    consolidate: { enabled: true, everyNTasks: 5, everyDays: 7, archiveInsteadOfDelete: true, usageRetentionDays: 180 },
    git: { enabled: true, autoCommit: 'task-end', checkpointMinutes: 30, autoPush: false },
    sqlite: { journalMode: 'wal', busyTimeoutMs: 5_000, fallback: 'none', maxOpenRoots: 4 },
    semantic: {
        enabled: false,
        provider: 'remote',
        baseUrl: '',
        baseUrlEnv: '',
        model: '',
        apiKeyEnv: '',
        apiKey: '',
        timeoutMs: 1_500,
        budgetMs: 8_000,
        foreignModelGraceDays: 30,
        weight: 0.5,
        minLexicalHits: 3,
        maxRecordsPerRun: 200,
        minSimilarity: 0.35,
        maxAdditions: 2,
    },
};
function obj(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function bool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
function num(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.min(max, Math.max(min, value));
}
function str(value, fallback) {
    return typeof value === 'string' && value !== '' ? value : fallback;
}
function oneOf(value, allowed, fallback) {
    return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}
const LAYERS = ['project', 'global', 'profile', 'episodic'];
function layers(value, fallback) {
    if (!Array.isArray(value))
        return fallback;
    const picked = value.filter((v) => typeof v === 'string' && LAYERS.includes(v));
    return picked.length > 0 ? picked : fallback;
}
/** Resolve raw loader config into a total, validated configuration. */
export function resolveConfig(raw) {
    const root = obj(raw);
    const routing = obj(root['routing']);
    const prompt = obj(root['prompt']);
    const protocol = obj(prompt['protocol']);
    const indexSummary = obj(prompt['indexSummary']);
    const recall = obj(root['recall']);
    const learn = obj(root['learn']);
    const distillModel = obj(learn['distillModel']);
    const episodic = obj(root['episodic']);
    const consolidate = obj(root['consolidate']);
    const git = obj(root['git']);
    const sqlite = obj(root['sqlite']);
    const semantic = obj(root['semantic']);
    const d = DEFAULT_CONFIG;
    const memoryHome = root['memoryHome'];
    return {
        enabled: bool(root['enabled'], d.enabled),
        logFile: str(root['logFile'], d.logFile),
        ...(typeof memoryHome === 'string' && memoryHome !== '' ? { memoryHome } : {}),
        routing: {
            defaultScope: oneOf(routing['defaultScope'], ['project', 'global'], d.routing.defaultScope),
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
                profileBudgetTokens: num(indexSummary['profileBudgetTokens'], d.prompt.indexSummary.profileBudgetTokens, 0, 600),
            },
        },
        recall: {
            autoInject: bool(recall['autoInject'], d.recall.autoInject),
            budgetTokens: num(recall['budgetTokens'], d.recall.budgetTokens, 0, 20_000),
            maxItems: num(recall['maxItems'], d.recall.maxItems, 0, 100),
            minScore: num(recall['minScore'], d.recall.minScore, 0, 1),
            sessionToolBudgetTokens: num(recall['sessionToolBudgetTokens'], d.recall.sessionToolBudgetTokens, 0, 1_000_000),
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
            distillTimeoutMs: num(learn['distillTimeoutMs'], d.learn.distillTimeoutMs, 500, 60_000),
            distillMaxTokens: num(learn['distillMaxTokens'], d.learn.distillMaxTokens, 64, 32_000),
            distillReasoningEffort: str(learn['distillReasoningEffort'], d.learn.distillReasoningEffort),
            minSignals: num(learn['minSignals'], d.learn.minSignals, 0, 50),
            distillRunner: oneOf(learn['distillRunner'], ['inline', 'jobs'], d.learn.distillRunner),
            exitCodeSignals: oneOf(learn['exitCodeSignals'], ['strong', 'all', 'off'], d.learn.exitCodeSignals),
            maxRecoverPerSession: num(learn['maxRecoverPerSession'], d.learn.maxRecoverPerSession, 0, 20),
            recoverBudgetMs: num(learn['recoverBudgetMs'], d.learn.recoverBudgetMs, 1_000, 120_000),
        },
        episodic: {
            enabled: bool(episodic['enabled'], d.episodic.enabled),
            retentionDays: num(episodic['retentionDays'], d.episodic.retentionDays, 1, 3_650),
            captureUserText: oneOf(episodic['captureUserText'], ['redacted', 'full', 'none'], d.episodic.captureUserText),
        },
        consolidate: {
            enabled: bool(consolidate['enabled'], d.consolidate.enabled),
            everyNTasks: num(consolidate['everyNTasks'], d.consolidate.everyNTasks, 1, 1_000),
            everyDays: num(consolidate['everyDays'], d.consolidate.everyDays, 1, 365),
            archiveInsteadOfDelete: bool(consolidate['archiveInsteadOfDelete'], d.consolidate.archiveInsteadOfDelete),
            usageRetentionDays: num(consolidate['usageRetentionDays'], d.consolidate.usageRetentionDays, 7, 3_650),
        },
        git: {
            enabled: bool(git['enabled'], d.git.enabled),
            autoCommit: oneOf(git['autoCommit'], ['off', 'task-end', 'immediate'], d.git.autoCommit),
            checkpointMinutes: num(git['checkpointMinutes'], d.git.checkpointMinutes, 1, 1_440),
            autoPush: false,
        },
        sqlite: {
            journalMode: oneOf(sqlite['journalMode'], ['wal', 'delete'], d.sqlite.journalMode),
            busyTimeoutMs: num(sqlite['busyTimeoutMs'], d.sqlite.busyTimeoutMs, 0, 60_000),
            fallback: oneOf(sqlite['fallback'], ['none', 'json'], d.sqlite.fallback),
            maxOpenRoots: num(sqlite['maxOpenRoots'], d.sqlite.maxOpenRoots, 0, 64),
        },
        semantic: {
            enabled: bool(semantic['enabled'], d.semantic.enabled),
            provider: oneOf(semantic['provider'], ['remote', 'none'], d.semantic.provider),
            baseUrl: str(semantic['baseUrl'], d.semantic.baseUrl),
            baseUrlEnv: str(semantic['baseUrlEnv'], d.semantic.baseUrlEnv),
            model: str(semantic['model'], d.semantic.model),
            apiKeyEnv: str(semantic['apiKeyEnv'], d.semantic.apiKeyEnv),
            apiKey: str(semantic['apiKey'], d.semantic.apiKey),
            timeoutMs: num(semantic['timeoutMs'], d.semantic.timeoutMs, 100, 30_000),
            weight: num(semantic['weight'], d.semantic.weight, 0, 1),
            minLexicalHits: num(semantic['minLexicalHits'], d.semantic.minLexicalHits, 0, 100),
            maxRecordsPerRun: num(semantic['maxRecordsPerRun'], d.semantic.maxRecordsPerRun, 0, 5_000),
            minSimilarity: num(semantic['minSimilarity'], d.semantic.minSimilarity, 0, 1),
            maxAdditions: num(semantic['maxAdditions'], d.semantic.maxAdditions, 0, 50),
            budgetMs: num(semantic['budgetMs'], d.semantic.budgetMs, 200, 120_000),
            foreignModelGraceDays: num(semantic['foreignModelGraceDays'], d.semantic.foreignModelGraceDays, 1, 3_650),
        },
    };
}
//# sourceMappingURL=config.js.map