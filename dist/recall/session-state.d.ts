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
    distillBudget(sessionId: string): DistillBudget;
    chargeDistill(sessionId: string, tokens: number): void;
    forget(sessionId: string): void;
    get size(): number;
}
//# sourceMappingURL=session-state.d.ts.map