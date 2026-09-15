/**
 * Per-turn ledger (L0): how much real work a turn contained.
 *
 * Without it, "the turn ended quietly" would be indistinguishable from "the
 * turn never did anything", and success attribution for recalled memory would
 * be meaningless.
 */
export interface TurnRecord {
    toolCalls: number;
    toolErrors: number;
    corrections: number;
    recalled: number;
}
export declare class TurnLedger {
    private readonly maxSessions;
    private readonly bySession;
    private readonly order;
    constructor(maxSessions?: number);
    private record;
    noteToolCall(sessionId: string, turn: number, isError: boolean): void;
    noteCorrection(sessionId: string, turn: number): void;
    noteRecalled(sessionId: string, turn: number, count: number): void;
    /** Tool calls across every turn this process observed for a session. */
    sessionToolCalls(sessionId: string): number;
    peek(sessionId: string, turn: number): TurnRecord;
    take(sessionId: string, turn: number): TurnRecord;
    forget(sessionId: string): void;
    private touch;
}
//# sourceMappingURL=ledger.d.ts.map