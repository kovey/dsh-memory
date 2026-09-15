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
];
/** Longest marker found in the text, or undefined. */
export function detectCorrection(text) {
    const lowered = text.toLowerCase();
    let found;
    for (const marker of CORRECTION_MARKERS) {
        if (!lowered.includes(marker))
            continue;
        if (found === undefined || marker.length > found.length)
            found = marker;
    }
    return found;
}
/**
 * Error markers that show up in *successful* tool calls whose content reports a
 * failure (a command that ran and exited non-zero is not a tool error in this
 * harness — only spawn failures and aborts are).
 */
const ERROR_MARKERS = [
    'command not found',
    'no such file or directory',
    'permission denied',
    'operation not permitted',
    'traceback (most recent call last)',
    'assertionerror',
    'syntaxerror',
    'fatal:',
    'err_pnpm',
    'errno',
    'eacces',
    'eperm',
    'enoent',
    'connection refused',
    'timed out',
    'timedout',
];
/**
 * Tools whose results are command output, so their content may be read for
 * failures. `isError` is honoured for every tool; this list only governs the
 * content heuristics.
 */
export const DEFAULT_COMMAND_TOOLS = [
    'bash',
    'sh',
    'shell',
    'zsh',
    'pwsh',
    'powershell',
    'cmd',
    'exec',
    'run_command',
    'run_terminal_cmd',
];
/** `[exit code: 3]` as rendered by the bash tool. */
const EXIT_CODE = /\[exit code:\s*(\d+)\]/i;
/**
 * Decide whether a tool result shows a real failure, including the common case
 * the harness does not flag: a command that ran fine but exited non-zero.
 *
 * Conservative by default — `strong` ignores exit code 1 so that `grep` with no
 * match or a deliberate "expect this to fail" check does not spend a
 * distillation call on every turn.
 */
export function detectResultFailure(content, options) {
    const text = content.replace(/\s+/g, ' ').trim();
    if (options.isError) {
        return { kind: looksLikeTestFailure(text) ? 'test-failure' : 'tool-failure', detail: summarize(text, 200) };
    }
    const commandTools = options.commandTools ?? DEFAULT_COMMAND_TOOLS;
    if (options.tool !== undefined && !commandTools.includes(options.tool.toLowerCase()))
        return undefined;
    const exit = EXIT_CODE.exec(text);
    const exitCode = exit !== null ? Number(exit[1]) : undefined;
    const mode = options.exitCodeMode ?? 'strong';
    const exitsBadly = exitCode !== undefined && exitCode !== 0 && mode !== 'off' && (mode === 'all' || exitCode >= 2);
    const marker = ERROR_MARKERS.find((candidate) => text.toLowerCase().includes(candidate));
    if (!exitsBadly && marker === undefined)
        return undefined;
    const reason = exitCode !== undefined && exitsBadly
        ? `exit code ${exitCode}`
        : `error output (${marker ?? 'unknown'})`;
    return {
        kind: looksLikeTestFailure(text) ? 'test-failure' : 'tool-failure',
        detail: summarize(`${reason}: ${text}`, 200),
    };
}
/** Markers that identify a failed automated check rather than a user complaint. */
const TEST_FAILURE_MARKERS = ['test failed', 'failing test', 'assertionerror', 'error ts', 'tsc error', 'fail ', '✖', 'tests failed'];
export function looksLikeTestFailure(text) {
    const lowered = text.toLowerCase();
    return TEST_FAILURE_MARKERS.some((marker) => lowered.includes(marker));
}
/** First meaningful line of a tool result, for the signal detail. */
export function summarize(text, maxChars = 200) {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}
/**
 * Bounded per-session signal buffer (L0). `take` drains a turn's signals so a
 * turn is distilled at most once.
 */
export class SignalBuffer {
    maxSessions;
    maxSignalsPerSession;
    bySession = new Map();
    order = [];
    constructor(maxSessions = 128, maxSignalsPerSession = 200) {
        this.maxSessions = maxSessions;
        this.maxSignalsPerSession = maxSignalsPerSession;
    }
    add(signal) {
        this.touch(signal.sessionId);
        const list = this.bySession.get(signal.sessionId) ?? [];
        list.push(signal);
        if (list.length > this.maxSignalsPerSession)
            list.splice(0, list.length - this.maxSignalsPerSession);
        this.bySession.set(signal.sessionId, list);
    }
    /** Signals recorded for one turn. */
    peek(sessionId, turn) {
        return (this.bySession.get(sessionId) ?? []).filter((signal) => signal.turn === turn);
    }
    /** Signals for one turn, removing them from the buffer. */
    take(sessionId, turn) {
        const all = this.bySession.get(sessionId) ?? [];
        const taken = all.filter((signal) => signal.turn === turn);
        this.bySession.set(sessionId, all.filter((signal) => signal.turn !== turn));
        return { sessionId, turn, signals: taken };
    }
    count(sessionId) {
        return this.bySession.get(sessionId)?.length ?? 0;
    }
    forget(sessionId) {
        this.bySession.delete(sessionId);
        const index = this.order.indexOf(sessionId);
        if (index !== -1)
            this.order.splice(index, 1);
    }
    get size() {
        return this.order.length;
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
/**
 * Classify one turn: any pain signal means the recalled memory did not prevent
 * the problem, which is what the verdict feeds back into record confidence.
 */
//# sourceMappingURL=signals.js.map