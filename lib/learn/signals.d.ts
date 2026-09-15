/**
 * Pain-signal collection (DESIGN §7, "Observe").
 *
 * Objective signals — a failed tool, a failed request, a user correction — are
 * what make learning trustworthy: model self-reports alone are the weakest
 * evidence in the store, and a turn with no signal never costs an LLM call.
 */
import type { EvidenceKind } from '../store/types.js';
export type SignalKind = Extract<EvidenceKind, 'tool-failure' | 'request-error' | 'user-correction' | 'rework' | 'test-failure' | 'permission-prompt'>;
export interface Signal {
    sessionId: string;
    kind: SignalKind;
    turn: number;
    step?: number;
    tool?: string;
    detail?: string;
    at: string;
}
/** Longest marker found in the text, or undefined. */
export declare function detectCorrection(text: string): string | undefined;
/**
 * Tools whose results are command output, so their content may be read for
 * failures. `isError` is honoured for every tool; this list only governs the
 * content heuristics.
 */
export declare const DEFAULT_COMMAND_TOOLS: readonly string[];
export interface ResultFailure {
    kind: 'tool-failure' | 'test-failure';
    detail: string;
}
export interface FailureDetectionOptions {
    /** The tool result was already flagged as an error by the registry. */
    isError: boolean;
    /** `learn.exitCodeSignals`. */
    exitCodeMode?: 'strong' | 'all' | 'off';
    /**
     * Tool that produced the result.
     *
     * Content heuristics only make sense for command runners: a healthy
     * `read docs/DESIGN.md` whose text mentions "No such file or directory"
     * is not a failure, and treating it as one spends an LLM call and can
     * distil a lesson out of nothing. Registry-level `isError` always counts.
     */
    tool?: string;
    /** Tools whose *content* may be read as command output. */
    commandTools?: readonly string[];
}
/**
 * Decide whether a tool result shows a real failure, including the common case
 * the harness does not flag: a command that ran fine but exited non-zero.
 *
 * Conservative by default — `strong` ignores exit code 1 so that `grep` with no
 * match or a deliberate "expect this to fail" check does not spend a
 * distillation call on every turn.
 */
export declare function detectResultFailure(content: string, options: FailureDetectionOptions): ResultFailure | undefined;
export declare function looksLikeTestFailure(text: string): boolean;
/** First meaningful line of a tool result, for the signal detail. */
export declare function summarize(text: string, maxChars?: number): string;
export interface TurnSignals {
    sessionId: string;
    turn: number;
    signals: Signal[];
}
/**
 * Bounded per-session signal buffer (L0). `take` drains a turn's signals so a
 * turn is distilled at most once.
 */
export declare class SignalBuffer {
    private readonly maxSessions;
    private readonly maxSignalsPerSession;
    private readonly bySession;
    private readonly order;
    constructor(maxSessions?: number, maxSignalsPerSession?: number);
    add(signal: Signal): void;
    /** Signals recorded for one turn. */
    peek(sessionId: string, turn: number): Signal[];
    /** Signals for one turn, removing them from the buffer. */
    take(sessionId: string, turn: number): TurnSignals;
    count(sessionId: string): number;
    forget(sessionId: string): void;
    get size(): number;
    private touch;
}
/**
 * Classify one turn: any pain signal means the recalled memory did not prevent
 * the problem, which is what the verdict feeds back into record confidence.
 */
//# sourceMappingURL=signals.d.ts.map