/**
 * Pain-signal collection (DESIGN §7, "Observe").
 *
 * Objective signals — a failed tool, a failed request, a user correction — are
 * what make learning trustworthy: model self-reports alone are the weakest
 * evidence in the store, and a turn with no signal never costs an LLM call.
 */
import type { EvidenceKind } from '../store/types.js'

export type SignalKind = Extract<
    EvidenceKind,
    'tool-failure' | 'request-error' | 'user-correction' | 'rework' | 'test-failure' | 'permission-prompt'
>

export interface Signal {
    sessionId: string
    kind: SignalKind
    turn: number
    step?: number
    tool?: string
    detail?: string
    at: string
}

/** Language-agnostic-ish correction markers; matched case-insensitively. */
const CORRECTION_MARKERS = [
    '不对',
    '不是',
    '错了',
    '错误',
    '重来',
    '重新做',
    '我说的是',
    '我说过',
    '又错',
    '还是不行',
    '仍然',
    '别再',
    '不要这样',
    '停',
    '为什么还',
    'wrong',
    'incorrect',
    'not what i',
    'stop',
    'redo',
    'again',
    'still failing',
]

/** Longest marker found in the text, or undefined. */
export function detectCorrection(text: string): string | undefined {
    const lowered = text.toLowerCase()
    let found: string | undefined
    for (const marker of CORRECTION_MARKERS) {
        if (!lowered.includes(marker)) continue
        if (found === undefined || marker.length > found.length) found = marker
    }
    return found
}

/** Markers that identify a failed automated check rather than a user complaint. */
const TEST_FAILURE_MARKERS = ['test failed', 'failing test', 'assertionerror', 'error ts', 'tsc error', 'fail ', '✖', 'tests failed']

export function looksLikeTestFailure(text: string): boolean {
    const lowered = text.toLowerCase()
    return TEST_FAILURE_MARKERS.some((marker) => lowered.includes(marker))
}

/** First meaningful line of a tool result, for the signal detail. */
export function summarize(text: string, maxChars = 200): string {
    const line = text.replace(/\s+/g, ' ').trim()
    return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line
}

export interface TurnSignals {
    sessionId: string
    turn: number
    signals: Signal[]
}

/**
 * Bounded per-session signal buffer (L0). `take` drains a turn's signals so a
 * turn is distilled at most once.
 */
export class SignalBuffer {
    private readonly bySession = new Map<string, Signal[]>()
    private readonly order: string[] = []

    constructor(
        private readonly maxSessions = 128,
        private readonly maxSignalsPerSession = 200,
    ) {}

    add(signal: Signal): void {
        this.touch(signal.sessionId)
        const list = this.bySession.get(signal.sessionId) ?? []
        list.push(signal)
        if (list.length > this.maxSignalsPerSession) list.splice(0, list.length - this.maxSignalsPerSession)
        this.bySession.set(signal.sessionId, list)
    }

    /** Signals recorded for one turn. */
    peek(sessionId: string, turn: number): Signal[] {
        return (this.bySession.get(sessionId) ?? []).filter((signal) => signal.turn === turn)
    }

    /** Signals for one turn, removing them from the buffer. */
    take(sessionId: string, turn: number): TurnSignals {
        const all = this.bySession.get(sessionId) ?? []
        const taken = all.filter((signal) => signal.turn === turn)
        this.bySession.set(
            sessionId,
            all.filter((signal) => signal.turn !== turn),
        )
        return { sessionId, turn, signals: taken }
    }

    count(sessionId: string): number {
        return this.bySession.get(sessionId)?.length ?? 0
    }

    forget(sessionId: string): void {
        this.bySession.delete(sessionId)
        const index = this.order.indexOf(sessionId)
        if (index !== -1) this.order.splice(index, 1)
    }

    get size(): number {
        return this.order.length
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

/**
 * Classify one turn: any pain signal means the recalled memory did not prevent
 * the problem, which is what the verdict feeds back into record confidence.
 */
export function turnVerdict(turn: TurnSignals): 'failure' | 'success' | 'neutral' {
    if (turn.signals.length > 0) return 'failure'
    return 'neutral'
}
