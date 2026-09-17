/**
 * Configuration resolution (DESIGN §9.2).
 *
 * Defaults mirror the plugin's own `cordis.patch.yml`; a profile may override
 * any field by re-declaring the same loader id `memory` with a `config:` block.
 * Resolution is total: malformed input falls back to defaults rather than
 * throwing, so a bad profile edit can never break session startup.
 */
import type { Layer } from './store/types.js';
export interface MemoryConfig {
    enabled: boolean;
    /** Plugin log file (home-expandable). Never stdout. */
    logFile: string;
    /** Override for the dsh home used to locate the global memory root. */
    memoryHome?: string;
    routing: {
        defaultScope: 'project' | 'global';
        /** Subagent sessions do not author memory by default (DESIGN §9.3). */
        subagentWrite: boolean;
    };
    prompt: {
        protocol: {
            enabled: boolean;
            budgetTokens: number;
            order: number;
        };
        indexSummary: {
            enabled: boolean;
            budgetTokens: number;
            maxTitles: number;
            order: number;
            /** L5 (preferences) budget inside the resident section. */
            profileBudgetTokens: number;
        };
    };
    recall: {
        autoInject: boolean;
        budgetTokens: number;
        maxItems: number;
        minScore: number;
        layers: Layer[];
        /**
         * Cumulative budget for memory *tool* output in one session.
         *
         * Every read tool is individually capped, but a model can call them in a
         * loop and fill its own context one capped answer at a time.
         */
        sessionToolBudgetTokens: number;
    };
    learn: {
        collectSignals: boolean;
        autoDistill: boolean;
        /**
         * Distillation route. Empty (the default) means "inherit the session's
         * own provider/model" — the plugin then follows whatever the user
         * already configured, with no separate LLM settings to keep in sync.
         */
        distillModel: {
            provider: string;
            model: string;
        };
        maxDistillPerSession: number;
        maxDistillTokensPerDay: number;
        distillTimeoutMs: number;
        /** Output budget for one distillation call (reasoning tokens count). */
        distillMaxTokens: number;
        /** Adapter-owned reasoning effort id; empty = adapter default. */
        distillReasoningEffort: string;
        minSignals: number;
        /**
         * `inline` keeps distillation inside turn-stopping (bounded await);
         * `jobs` hands it to `ctx.jobs` so the turn closes immediately and the
         * work becomes observable/cancellable. Signals stay in L1 either way,
         * because neither runner survives process exit.
         */
        distillRunner: 'inline' | 'jobs';
        /**
         * Non-zero exits are *not* tool errors in this harness (only spawn
         * failures and aborts are), yet a failed command is the most common
         * real pain signal. `strong` reacts to exit >= 2 and to error markers
         * (`grep`-style exit 1 stays quiet), `all` reacts to any non-zero exit,
         * `off` ignores exit codes entirely.
         */
        exitCodeSignals: 'strong' | 'all' | 'off';
        /**
         * Undistilled signal groups picked up when a session starts. This is what
         * makes `distillRunner: 'jobs'` safe on one-shot surfaces (the job is
         * cancelled with its agent) and survives crashes mid-distillation.
         */
        maxRecoverPerSession: number;
        /** Wall-clock budget for one recovery pass (never stalls turn closure). */
        recoverBudgetMs: number;
    };
    episodic: {
        enabled: boolean;
        retentionDays: number;
        captureUserText: 'redacted' | 'full' | 'none';
    };
    consolidate: {
        /** Days of recall bookkeeping kept (aggregates already live on records). */
        usageRetentionDays: number;
        enabled: boolean;
        everyNTasks: number;
        everyDays: number;
        archiveInsteadOfDelete: boolean;
    };
    git: {
        enabled: boolean;
        autoCommit: 'off' | 'task-end' | 'immediate';
        checkpointMinutes: number;
        /** Never automatic: pushing requires an explicit user instruction. */
        autoPush: false;
    };
    sqlite: {
        journalMode: 'wal' | 'delete';
        busyTimeoutMs: number;
        fallback: 'none' | 'json';
        /** Open memory roots kept alive; the least recently used are closed. */
        maxOpenRoots: number;
    };
    /**
     * Optional semantic recall (DESIGN §14.3). Off by default: it is the only
     * feature that can spend money *outside* the bounded distillation path.
     */
    semantic: {
        enabled: boolean;
        /** `remote` = OpenAI-compatible /embeddings endpoint. */
        provider: 'remote' | 'none';
        baseUrl: string;
        /** Read the base URL from this env var instead of `baseUrl`. */
        baseUrlEnv: string;
        model: string;
        apiKeyEnv: string;
        apiKey: string;
        timeoutMs: number;
        /** Wall-clock budget for one embedding run across all batches. */
        budgetMs: number;
        /** Days a *previous* model's vectors are kept before being dropped. */
        foreignModelGraceDays: number;
        /** Blend weight: 0 = lexical only, 1 = semantic only. */
        weight: number;
        /** Only embed the query when lexical recall returned fewer hits than this. */
        minLexicalHits: number;
        /** Records embedded per recall pass (backfill is incremental). */
        maxRecordsPerRun: number;
        /** Minimum cosine similarity for a semantic-only hit to count. */
        minSimilarity: number;
        /**
         * Cap on semantic-only candidates per query. Without it, semantically
         * "nearby" lessons pad every pack and the injected token count grows
         * ~2× for no accuracy gain (measured on the real corpus).
         */
        maxAdditions: number;
    };
}
export declare const DEFAULT_CONFIG: MemoryConfig;
/** Resolve raw loader config into a total, validated configuration. */
export declare function resolveConfig(raw: unknown): MemoryConfig;
//# sourceMappingURL=config.d.ts.map