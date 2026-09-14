/**
 * Per-session working memory (L0, DESIGN §3).
 *
 * Holds what must not be recomputed or repeated inside one session: which
 * records were already injected (idempotence, §6) and how much LLM budget the
 * learning loop has spent (M2). Entries are dropped on `session/disposed` and
 * capped so a long-lived host cannot grow without bound.
 */

export interface DistillBudget {
    runs: number
    tokens: number
    lastRunAt?: number
}

export class SessionState {
    private readonly injected = new Map<string, Set<string>>()
    private readonly distill = new Map<string, DistillBudget>()
    private readonly turns = new Map<string, number>()
    private readonly startedAt = new Map<string, number>()
    private readonly overrides = new Map<string, { autoRecall?: boolean }>()
    private readonly order: string[] = []

    constructor(private readonly maxSessions = 256) {}

    private touch(sessionId: string): void {
        const index = this.order.indexOf(sessionId)
        if (index !== -1) this.order.splice(index, 1)
        this.order.push(sessionId)
        while (this.order.length > this.maxSessions) {
            const evicted = this.order.shift()
            if (evicted !== undefined) this.forget(evicted)
        }
    }

    /** True when this record was already injected into this session. */
    hasInjected(sessionId: string, recordId: string): boolean {
        return this.injected.get(sessionId)?.has(recordId) ?? false
    }

    markInjected(sessionId: string, recordIds: readonly string[]): void {
        if (recordIds.length === 0) return
        this.touch(sessionId)
        let set = this.injected.get(sessionId)
        if (set === undefined) {
            set = new Set()
            this.injected.set(sessionId, set)
        }
        for (const id of recordIds) set.add(id)
    }

    injectedCount(sessionId: string): number {
        return this.injected.get(sessionId)?.size ?? 0
    }

    /** Session-scoped overrides set by `memory_config` (never persisted). */
    setOverride(sessionId: string, patch: { autoRecall?: boolean }): void {
        const current = this.overrides.get(sessionId) ?? {}
        this.overrides.set(sessionId, { ...current, ...patch })
        this.touch(sessionId)
    }

    override(sessionId: string | undefined): { autoRecall?: boolean } {
        if (sessionId === undefined) return {}
        const found = this.overrides.get(sessionId)
        this.touch(sessionId)
        return found ?? {}
    }

    /** Remember when a session was first seen (duration for the metric ledger). */
    markSessionStart(sessionId: string, at: number = Date.now()): void {
        if (this.startedAt.has(sessionId)) return
        this.startedAt.set(sessionId, at)
        this.touch(sessionId)
    }

    sessionStart(sessionId: string): number | undefined {
        return this.startedAt.get(sessionId)
    }

    /** Record the highest turn number observed, for metric bookkeeping. */
    observeTurn(sessionId: string, turn: number): void {
        const current = this.turns.get(sessionId) ?? 0
        if (turn > current) {
            this.turns.set(sessionId, turn)
            this.touch(sessionId)
        }
    }

    lastTurn(sessionId: string): number {
        return this.turns.get(sessionId) ?? 0
    }

    distillBudget(sessionId: string): DistillBudget {
        let budget = this.distill.get(sessionId)
        if (budget === undefined) {
            budget = { runs: 0, tokens: 0 }
            this.distill.set(sessionId, budget)
        }
        return budget
    }

    chargeDistill(sessionId: string, tokens: number): void {
        const budget = this.distillBudget(sessionId)
        budget.runs += 1
        budget.tokens += Math.max(0, tokens)
        budget.lastRunAt = Date.now()
        this.touch(sessionId)
    }

    forget(sessionId: string): void {
        this.injected.delete(sessionId)
        this.distill.delete(sessionId)
        this.turns.delete(sessionId)
        this.startedAt.delete(sessionId)
        this.overrides.delete(sessionId)
        const index = this.order.indexOf(sessionId)
        if (index !== -1) this.order.splice(index, 1)
    }

    get size(): number {
        return this.order.length
    }
}
