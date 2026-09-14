/**
 * Per-turn ledger (L0): how much real work a turn contained.
 *
 * Without it, "the turn ended quietly" would be indistinguishable from "the
 * turn never did anything", and success attribution for recalled memory would
 * be meaningless.
 */

export interface TurnRecord {
    toolCalls: number
    toolErrors: number
    corrections: number
    recalled: number
}

export class TurnLedger {
    private readonly bySession = new Map<string, Map<number, TurnRecord>>()
    private readonly order: string[] = []

    constructor(private readonly maxSessions = 128) {}

    private record(sessionId: string, turn: number): TurnRecord {
        this.touch(sessionId)
        let turns = this.bySession.get(sessionId)
        if (turns === undefined) {
            turns = new Map()
            this.bySession.set(sessionId, turns)
        }
        let entry = turns.get(turn)
        if (entry === undefined) {
            entry = { toolCalls: 0, toolErrors: 0, corrections: 0, recalled: 0 }
            turns.set(turn, entry)
            // keep only the newest 50 turns per session
            if (turns.size > 50) {
                const oldest = [...turns.keys()].sort((a, b) => a - b)[0]
                if (oldest !== undefined && oldest !== turn) turns.delete(oldest)
            }
        }
        return entry
    }

    noteToolCall(sessionId: string, turn: number, isError: boolean): void {
        const entry = this.record(sessionId, turn)
        entry.toolCalls += 1
        if (isError) entry.toolErrors += 1
    }

    noteCorrection(sessionId: string, turn: number): void {
        this.record(sessionId, turn).corrections += 1
    }

    noteRecalled(sessionId: string, turn: number, count: number): void {
        this.record(sessionId, turn).recalled += count
    }

    /** Tool calls across every turn this process observed for a session. */
    sessionToolCalls(sessionId: string): number {
        const turns = this.bySession.get(sessionId)
        if (turns === undefined) return 0
        let total = 0
        for (const entry of turns.values()) total += entry.toolCalls
        return total
    }

    peek(sessionId: string, turn: number): TurnRecord {
        return this.bySession.get(sessionId)?.get(turn) ?? { toolCalls: 0, toolErrors: 0, corrections: 0, recalled: 0 }
    }

    take(sessionId: string, turn: number): TurnRecord {
        const entry = this.peek(sessionId, turn)
        this.bySession.get(sessionId)?.delete(turn)
        return entry
    }

    forget(sessionId: string): void {
        this.bySession.delete(sessionId)
        const index = this.order.indexOf(sessionId)
        if (index !== -1) this.order.splice(index, 1)
    }

    private touch(sessionId: string): void {
        const index = this.order.indexOf(sessionId)
        if (index !== -1) this.order.splice(index, 1)
        this.order.push(sessionId)
        while (this.order.length > this.maxSessions) {
            const evicted = this.order.shift()
            if (evicted !== undefined) this.bySession.delete(evicted)
        }
    }
}
