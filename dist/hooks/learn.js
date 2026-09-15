import { log } from '../log.js';
import { applyOutcome } from '../recall/usage.js';
import { ScopeResolver, sessionIdOf } from '../scope/resolver.js';
import { runDistillation, distillInFlightTtlMs, isDistilling } from '../learn/distill-runner.js';
import { recordEpisode } from '../learn/episodic.js';
import { TurnLedger } from '../learn/ledger.js';
import { loadGroupSignals, pendingDistillations, pendingMinAgeSeconds } from '../learn/pending.js';
import { detectResultFailure } from '../learn/signals.js';
/**
 * Pick up pain signals that were collected but never distilled — a job killed
 * with its agent on a one-shot surface, or a process that died mid-call.
 *
 * Runs off the turn-end path, uses the *new* session's route/model, and is
 * naturally idempotent: any attempt that passed the gate writes a `distill`
 * audit row, so a group is retried until its first attempt and never again.
 * Attempts refused by the gate (budget, no route) write nothing and stay
 * pending, which is why the caller must not latch a scope that recovered
 * nothing.
 */
export async function recoverPendingDistillations(deps, agent, options = {}) {
    const startedAt = Date.now();
    const budgetMs = options.budgetMs ?? deps.config.learn.recoverBudgetMs;
    const limit = deps.config.learn.maxRecoverPerSession;
    if (limit <= 0 || !deps.config.learn.autoDistill)
        return 0;
    if (!deps.resolver.mayWrite(agent))
        return 0;
    const store = deps.registry.open(deps.resolver.resolve({ agent }));
    if (store === undefined)
        return 0;
    const sessionId = sessionIdOf(agent);
    // Deliberately *not* "exclude the current session": the nvim-tui runner
    // resumes the previous session, so the group that needs recovery often
    // belongs to this very session id. Guard by "the turn has ended" instead —
    // a group is recoverable when its turn is behind the turn this process has
    // observed, and it is old enough not to be mid-flight.
    const currentTurn = sessionId !== undefined ? deps.state.lastTurn(sessionId) : 0;
    const minAgeSeconds = pendingMinAgeSeconds(deps.config.learn.distillTimeoutMs);
    const inFlightTtlMs = distillInFlightTtlMs(deps.config.learn.distillTimeoutMs);
    const groups = pendingDistillations(store.db, { limit: limit + 2, minAgeSeconds }).filter((group) => !(sessionId !== undefined && currentTurn > 0 && group.sessionId === sessionId && group.turn >= currentTurn) &&
        // A runner in this process is already distilling the group; it only
        // *looks* unattempted because its audit row is not written yet.
        !isDistilling(group.sessionId, group.turn, inFlightTtlMs));
    if (groups.length === 0) {
        log('debug', 'memory: no undistilled signals to recover');
        return 0;
    }
    let recovered = 0;
    for (const group of groups) {
        if (Date.now() - startedAt > budgetMs) {
            log('debug', `memory: recovery budget (${budgetMs}ms) reached — remaining groups stay pending`);
            break;
        }
        const signals = loadGroupSignals(store.db, group);
        if (signals.length === 0)
            continue;
        const runner = await runDistillation({ ctx: deps.ctx, config: deps.config, registry: deps.registry, resolver: deps.resolver, state: deps.state }, {
            agent,
            sessionId: group.sessionId,
            turn: group.turn,
            signals,
            recalled: [],
            ...(agent !== undefined ? { ownerAgent: agent } : {}),
            mode: 'inline',
        });
        if (runner.outcome !== undefined && runner.outcome.status !== 'skipped') {
            recovered += 1;
            log('info', `memory: recovered ${signals.length} undistilled signal(s) from session ${group.sessionId.slice(0, 18)}… turn ${group.turn} → ${runner.outcome.status}`);
        }
    }
    return recovered;
}
/** Register tool-result, request-error and turn-stopping listeners. */
export function registerLearnHooks(ctx, deps) {
    const disposers = [];
    if (deps.config.learn.collectSignals) {
        const onToolResult = (exec, result) => {
            try {
                const sessionId = exec?.agent?.session?.id;
                if (typeof sessionId !== 'string')
                    return undefined;
                const turn = deps.state.lastTurn(sessionId);
                // A non-zero exit is not a tool error in this harness, so the
                // failure has to be read out of the content (see signals.ts).
                const failure = detectResultFailure(contentText(result?.content), {
                    isError: result?.isError === true,
                    exitCodeMode: deps.config.learn.exitCodeSignals,
                    ...(typeof exec.name === 'string' ? { tool: exec.name } : {}),
                });
                deps.ledger.noteToolCall(sessionId, turn, failure !== undefined);
                if (failure === undefined)
                    return undefined;
                const tool = typeof exec.name === 'string' ? exec.name : undefined;
                deps.signals.add({
                    sessionId,
                    kind: failure.kind,
                    turn,
                    ...(tool !== undefined ? { tool } : {}),
                    detail: failure.detail,
                    at: new Date().toISOString(),
                });
                // The same tool failing twice in one turn is a rework loop, which
                // is stronger evidence than either failure alone.
                if (tool !== undefined) {
                    const repeats = deps.signals
                        .peek(sessionId, turn)
                        .filter((signal) => signal.tool === tool && signal.kind !== 'rework').length;
                    if (repeats >= 2) {
                        deps.signals.add({
                            sessionId,
                            kind: 'rework',
                            turn,
                            tool,
                            detail: `${tool} failed ${repeats}× in one turn`,
                            at: new Date().toISOString(),
                        });
                        log('info', `memory: rework signal recorded (${tool} ×${repeats}) turn ${turn}`);
                    }
                }
            }
            catch (error) {
                log('debug', 'memory: tool result observation failed:', error);
            }
            return undefined;
        };
        ctx.on('tools/result', onToolResult);
    }
    const onRequestError = async (payload, next) => {
        const action = await next();
        try {
            if (!deps.config.learn.collectSignals)
                return action;
            const sessionId = sessionIdOf(payload?.agent);
            if (sessionId === undefined)
                return action;
            deps.signals.add({
                sessionId,
                kind: 'request-error',
                turn: payload.turn ?? deps.state.lastTurn(sessionId),
                ...(payload.failure?.code !== undefined ? { detail: payload.failure.code } : {}),
                at: new Date().toISOString(),
            });
        }
        catch (error) {
            log('debug', 'memory: request-error observation failed:', error);
        }
        return action;
    };
    ctx.on('agent/request-error', onRequestError);
    const onTurnStopping = async (payload) => {
        const started = Date.now();
        const signal = payload?.signal;
        // Diagnostic: a turn-scoped abort during this await explains an LLM call
        // that reports "aborted by caller" while our own controller is live.
        const onAbort = () => {
            log('warn', `memory: turn ${payload.turn ?? '?'} signal aborted after ${Date.now() - started}ms (distillation may be cancelled with it)`);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            if (signal?.aborted === true)
                log('warn', `memory: turn-stopping entered with an already-aborted signal (turn ${payload.turn ?? '?'})`);
            await handleTurnEnd(deps, payload);
            log('debug', `memory: turn ${payload.turn ?? '?'} learning finished in ${Date.now() - started}ms`);
        }
        catch (error) {
            log('error', 'memory: turn-end learning failed:', error);
        }
        finally {
            signal?.removeEventListener('abort', onAbort);
        }
    };
    ctx.on('agent/turn-stopping', onTurnStopping);
    return disposers;
}
/**
 * Attribute an outcome in *every* open store that has unattributed usage rows
 * for this session and turn.
 *
 * Recall writes its usage rows into the store a record came from, so a turn that
 * injected both project and global memories has rows in two databases. Only
 * attributing the session's own store left global memory permanently
 * unattributed — its use-weight could never rise, and DESIGN §7's "a memory that
 * failed after recall loses confidence" never applied to it.
 */
function attributeAcrossRoots(deps, sessionId, outcome, turn) {
    let attributed = 0;
    for (const candidate of deps.registry.listOpen()) {
        try {
            attributed += applyOutcome(candidate.db, sessionId, outcome, turn);
        }
        catch (error) {
            log('debug', 'memory: outcome attribution failed for a root:', error);
        }
    }
    return attributed;
}
/**
 * Scopes whose pending debt has been *attempted* in this process.
 *
 * Latched only when a recovery pass really attempted at least one group. A pass
 * that was refused before spending anything (daily budget exhausted, no route)
 * writes no audit row and leaves the debt untouched, so it must not latch:
 * otherwise the first quiet turn of a long-lived session burns the one recovery
 * slot this process has, and a job cancelled later in that same process is never
 * picked up. Duplicate work is prevented by the in-flight marks in
 * `distill-runner.ts` plus the audit row itself, not by this set.
 */
const recoveredScopes = new Set();
async function handleTurnEnd(deps, payload) {
    const sessionId = sessionIdOf(payload?.agent);
    const turn = payload?.turn;
    if (sessionId === undefined || turn === undefined)
        return;
    const ledger = deps.ledger.take(sessionId, turn);
    const collected = deps.signals.take(sessionId, turn);
    const store = deps.registry.open(deps.resolver.resolve({ agent: payload.agent }));
    if (store === undefined)
        return;
    if (!deps.config.learn.collectSignals) {
        // learning disabled: only keep the session counters tidy
        deps.signals.forget(sessionId);
        return;
    }
    if (collected.signals.length === 0) {
        // Recovery rides a *quiet* turn: the store is open, the agent is alive,
        // and it never stacks on top of this turn's own distillation (whose
        // result the user is waiting for). It is wall-clock bounded so a debt of
        // groups cannot stall turn closure.
        if (deps.config.learn.autoDistill && !recoveredScopes.has(store.scope.root)) {
            try {
                const recovered = await recoverPendingDistillations(deps, payload.agent);
                // Latch only on real work. A pass that recovered nothing was
                // either refused by the gate (nothing spent, debt still pending)
                // or found nothing; leaving the scope unlatched lets the next
                // quiet turn try again, which is what a cancelled job needs.
                if (recovered > 0)
                    recoveredScopes.add(store.scope.root);
            }
            catch (error) {
                log('warn', 'memory: pending-distillation recovery failed:', error);
            }
        }
        // A quiet turn that did real work counts as evidence the recalled
        // memory did not mislead: attribute success, raise its weight.
        if (ledger.recalled > 0 && ledger.toolCalls > 0) {
            try {
                attributeAcrossRoots(deps, sessionId, 'success', turn);
            }
            catch (error) {
                log('debug', 'memory: success attribution failed:', error);
            }
        }
        return;
    }
    recordEpisode(store.db, store.scope, {
        sessionId,
        turn,
        signals: collected.signals,
        verdict: 'failure',
        recalled: [],
        captureUserText: deps.config.episodic.captureUserText,
    });
    try {
        attributeAcrossRoots(deps, sessionId, 'failure', turn);
    }
    catch (error) {
        log('debug', 'memory: failure attribution failed:', error);
    }
    const runner = await runDistillation({
        ctx: deps.ctx,
        config: deps.config,
        registry: deps.registry,
        resolver: deps.resolver,
        state: deps.state,
    }, {
        agent: payload.agent,
        sessionId,
        turn,
        signals: collected.signals,
        recalled: [],
        ownerAgent: payload.agent,
    });
    if (runner.mode === 'jobs') {
        log('info', `memory: turn ${turn} distillation handed to job ${runner.jobId ?? '?'} (${collected.signals.length} signal(s))`);
        return;
    }
    if (runner.outcome !== undefined)
        logOutcome(turn, collected.signals.length, runner.outcome);
}
function logOutcome(turn, signalCount, outcome) {
    if (outcome.status === 'skipped')
        return;
    log('info', `memory: turn ${turn} learning — ${signalCount} signal(s), distill=${outcome.status} (+${outcome.created}/~${outcome.merged}/-${outcome.rejected}, ${outcome.tokensIn + outcome.tokensOut} tok)`);
}
/** Read the text of a tool result's content blocks. */
export function contentText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (block === null || typeof block !== 'object')
            continue;
        const record = block;
        if (typeof record.text === 'string')
            parts.push(record.text);
    }
    return parts.join(' ');
}
//# sourceMappingURL=learn.js.map