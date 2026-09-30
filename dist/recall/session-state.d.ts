/**
 * Per-session working memory (L0, DESIGN §3).
 *
 * Holds what must not be recomputed or repeated inside one session: which
 * records were already injected (idempotence, §6) and how much LLM budget the
 * learning loop has spent (M2). Entries are dropped on `session/disposed` and
 * capped so a long-lived host cannot grow without bound.
 */
export interface DistillBudget {
    runs: number;
    tokens: number;
    lastRunAt?: number;
}
export declare class SessionState {
    private readonly maxSessions;
    private readonly injected;
    private readonly distill;
    private readonly turns;
    /** Current step per session, keyed by turn (`observeStep`). */
    private readonly steps;
    private readonly startedAt;
    private readonly overrides;
    private readonly toolTokens;
    private readonly order;
    constructor(maxSessions?: number);
    private touch;
    /** True when this record was already injected into this session. */
    hasInjected(sessionId: string, recordId: string): boolean;
    markInjected(sessionId: string, recordIds: readonly string[]): void;
    injectedCount(sessionId: string): number;
    /**
     * Charge tool output against this session's cumulative budget.
     *
     * Each read tool is individually bounded, but a model can call them in a
     * loop; without a session total it could fill its own context one capped
     * answer at a time. Returns how much is left after this charge (never
     * negative), and whether the charge fit.
     */
    chargeToolBudget(sessionId: string, tokens: number, budget: number): {
        allowed: boolean;
        used: number;
        remaining: number;
    };
    toolTokensUsed(sessionId: string): number;
    /** Session-scoped overrides set by `memory_config` (never persisted). */
    setOverride(sessionId: string, patch: {
        autoRecall?: boolean;
    }): void;
    override(sessionId: string | undefined): {
        autoRecall?: boolean;
    };
    /** Remember when a session was first seen (duration for the metric ledger). */
    markSessionStart(sessionId: string, at?: number): void;
    sessionStart(sessionId: string): number | undefined;
    /** Record the highest turn number observed, for metric bookkeeping. */
    observeTurn(sessionId: string, turn: number): void;
    lastTurn(sessionId: string): number;
    /**
     * Record the step the agent loop is currently in.
     *
     * `agent/pre-step` is the only place the harness tells the plugin its step,
     * so it is also the single source for everyone else: a tool result carries no
     * turn/step (see `ToolExecution`), and attribution needs to know *when* a
     * failure happened to decide which injections the model had already seen.
     * Only a later step of the same turn (or a newer turn) replaces the mark, so
     * a late event cannot be labelled with a stale step.
     */
    observeStep(sessionId: string, turn: number, step: number): void;
    /**
     * Step last observed for `turn` — `undefined` when that turn was never seen
     * (or when nothing was observed at all, e.g. a session that started before
     * the hooks were registered). Callers must treat `undefined` as "unknown"
     * rather than "step 1".
     */
    lastStep(sessionId: string, turn?: number): number | undefined;
    distillBudget(sessionId: string): DistillBudget;
    chargeDistill(sessionId: string, tokens: number): void;
    forget(sessionId: string): void;
    get size(): number;
}
//# sourceMappingURL=session-state.d.ts.map