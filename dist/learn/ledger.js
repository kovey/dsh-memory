/**
 * Per-turn ledger (L0): how much real work a turn contained.
 *
 * Without it, "the turn ended quietly" would be indistinguishable from "the
 * turn never did anything", and success attribution for recalled memory would
 * be meaningless.
 */
export class TurnLedger {
    maxSessions;
    bySession = new Map();
    order = [];
    constructor(maxSessions = 128) {
        this.maxSessions = maxSessions;
    }
    record(sessionId, turn) {
        this.touch(sessionId);
        let turns = this.bySession.get(sessionId);
        if (turns === undefined) {
            turns = new Map();
            this.bySession.set(sessionId, turns);
        }
        let entry = turns.get(turn);
        if (entry === undefined) {
            entry = { toolCalls: 0, toolErrors: 0, corrections: 0, recalled: 0 };
            turns.set(turn, entry);
            // keep only the newest 50 turns per session
            if (turns.size > 50) {
                const oldest = [...turns.keys()].sort((a, b) => a - b)[0];
                if (oldest !== undefined && oldest !== turn)
                    turns.delete(oldest);
            }
        }
        return entry;
    }
    noteToolCall(sessionId, turn, isError) {
        const entry = this.record(sessionId, turn);
        entry.toolCalls += 1;
        if (isError)
            entry.toolErrors += 1;
    }
    noteCorrection(sessionId, turn) {
        this.record(sessionId, turn).corrections += 1;
    }
    noteRecalled(sessionId, turn, count) {
        this.record(sessionId, turn).recalled += count;
    }
    /** Tool calls across every turn this process observed for a session. */
    sessionToolCalls(sessionId) {
        const turns = this.bySession.get(sessionId);
        if (turns === undefined)
            return 0;
        let total = 0;
        for (const entry of turns.values())
            total += entry.toolCalls;
        return total;
    }
    peek(sessionId, turn) {
        return this.bySession.get(sessionId)?.get(turn) ?? { toolCalls: 0, toolErrors: 0, corrections: 0, recalled: 0 };
    }
    take(sessionId, turn) {
        const entry = this.peek(sessionId, turn);
        this.bySession.get(sessionId)?.delete(turn);
        return entry;
    }
    forget(sessionId) {
        this.bySession.delete(sessionId);
        const index = this.order.indexOf(sessionId);
        if (index !== -1)
            this.order.splice(index, 1);
    }
    touch(sessionId) {
        const index = this.order.indexOf(sessionId);
        if (index !== -1)
            this.order.splice(index, 1);
        this.order.push(sessionId);
        while (this.order.length > this.maxSessions) {
            const evicted = this.order.shift();
            if (evicted !== undefined)
                this.bySession.delete(evicted);
        }
    }
}
//# sourceMappingURL=ledger.js.map