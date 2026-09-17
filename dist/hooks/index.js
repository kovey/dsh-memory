import { log } from '../log.js';
import { SessionState } from '../recall/session-state.js';
import { ScopeResolver } from '../scope/resolver.js';
import { AutoCommitter } from '../sync/autocommit.js';
import { ensureRepo } from '../sync/git.js';
import { consolidate } from '../learn/consolidate.js';
import { pruneEpisodes, pruneSignals } from '../learn/episodic.js';
import { pruneForeignModels, pruneVectors } from '../recall/semantic.js';
import { pruneUsage } from '../recall/usage.js';
import { buildLedgerRow, recordSessionMetric, sessionStats, withLearningCounters } from '../learn/task-metrics.js';
import { consolidationDue } from '../learn/decay.js';
import { TurnLedger } from '../learn/ledger.js';
import { SignalBuffer } from '../learn/signals.js';
import { recoverPendingDistillations, registerLearnHooks } from './learn.js';
import { createPreStepHook } from './pre-step.js';
import { registerAgentIndexSection, registerProtocolSection } from './prompt.js';
/** Build the shared dependency bag (tools and hooks use the same one). */
export function createHookDeps(config, registry, resolver, capabilities, semantic) {
    return {
        config,
        registry,
        resolver,
        capabilities,
        state: new SessionState(),
        signals: new SignalBuffer(),
        ledger: new TurnLedger(),
        committer: new AutoCommitter(config),
        ...(semantic !== undefined ? { semantic } : {}),
    };
}
/** Register every hook and prompt contribution. */
export function registerHooks(ctx, deps) {
    const disposers = [];
    // ① prompt sections: protocol (global) + index summary (per agent).
    disposers.push(...registerProtocolSection(ctx, deps));
    ctx.on('agent/created', (payload) => {
        try {
            const agent = payload?.agent;
            if (agent === undefined)
                return;
            registerAgentIndexSection(agent, deps);
            // Recovery deliberately does NOT run here: a timer races host
            // teardown on one-shot surfaces ("database is not open"). It runs at
            // the end of the first turn instead — see handleTurnEnd.
        }
        catch (error) {
            log('warn', 'memory: agent/created index registration failed:', error);
        }
    });
    // ② automatic recall at the first step of every turn.
    ctx.on('agent/pre-step', createPreStepHook(deps));
    // ③ learning loop: signals, turn-end distillation, recall attribution.
    disposers.push(...registerLearnHooks(ctx, { ...deps, ctx }));
    // ③.4 git: make the root versionable, then commit local changes at a
    // task-end cadence. Pushing never happens here (DESIGN D6).
    if (deps.config.git.enabled) {
        ctx.on('agent/turn-stopping', (payload) => {
            try {
                const scope = deps.resolver.resolve({ cwd: payload?.agent?.session?.header?.cwd });
                deps.committer.maybeCommit(scope, `turn end (${scope.kind})`);
            }
            catch (error) {
                log('debug', 'memory: auto-commit skipped:', error);
            }
        });
    }
    // ③.5 lazy consolidation: at most one pass per scope per interval, never
    // blocking session start (DESIGN §7 "周期" row).
    const inFlight = new Set();
    ctx.on('session/created', (session) => {
        try {
            // Duration for the metric ledger starts here, not at the first turn.
            if (typeof session?.id === 'string')
                deps.state.markSessionStart(session.id);
        }
        catch (error) {
            log('debug', 'memory: session start bookkeeping failed:', error);
        }
        try {
            if (deps.config.git.enabled) {
                const scope = deps.resolver.resolve({ cwd: session?.header?.cwd });
                const timer = setTimeout(() => ensureRepo(scope.root), 1_000);
                timer.unref?.();
            }
        }
        catch (error) {
            log('debug', 'memory: git init scheduling failed:', error);
        }
        try {
            if (!deps.config.consolidate.enabled)
                return;
            const scope = deps.resolver.resolve({ cwd: session?.header?.cwd });
            if (inFlight.has(scope.root))
                return;
            const timer = setTimeout(() => {
                inFlight.delete(scope.root);
                runLazyConsolidation(deps, scope);
            }, 2_000);
            timer.unref?.();
            inFlight.add(scope.root);
        }
        catch (error) {
            log('debug', 'memory: lazy consolidation scheduling failed:', error);
        }
    });
    // ④ per-session state cleanup.
    ctx.on('session/disposed', (session) => {
        try {
            if (typeof session?.id !== 'string')
                return;
            // Ledger row before the state is forgotten: this is the only point
            // where a session's aggregates are still known.
            const store = deps.registry.open(deps.resolver.resolve({ cwd: session?.header?.cwd }));
            if (store !== undefined) {
                const startedAt = deps.state.sessionStart(session.id);
                const base = sessionStats(store.db, {
                    sessionId: session.id,
                    ...(startedAt !== undefined ? { startedAt } : {}),
                    turns: deps.state.lastTurn(session.id),
                    toolCalls: deps.ledger.sessionToolCalls(session.id),
                    signals: 0,
                    rework: 0,
                    corrections: 0,
                });
                const row = buildLedgerRow(base);
                if (row !== undefined) {
                    const full = withLearningCounters(store.db, row, session.id);
                    recordSessionMetric(store.db, store.scope, full);
                    log('info', `memory: session metric ${full.taskId} (${full.outcome}, ${full.durationMin}min, signals ${base.signals}, lessons ${full.lessons})`);
                }
            }
            // Bounded resources (DESIGN §5.2): a long-lived host opening many
            // project roots must not keep every connection.
            try {
                const released = deps.registry.closeIdle(deps.config.sqlite.maxOpenRoots);
                if (released.length > 0)
                    log('debug', `memory: released ${released.length} idle store(s)`);
            }
            catch (error) {
                log('debug', 'memory: idle store release failed:', error);
            }
            deps.state.forget(session.id);
            deps.signals.forget(session.id);
            deps.ledger.forget(session.id);
            if (deps.config.git.enabled) {
                const scope = deps.resolver.resolve({ cwd: session?.header?.cwd });
                deps.committer.commitNow(scope, 'session end');
            }
        }
        catch (error) {
            log('debug', 'memory: session cleanup failed:', error);
        }
    });
    return {
        deps,
        dispose: () => {
            for (const dispose of disposers) {
                try {
                    dispose();
                }
                catch (error) {
                    log('warn', 'memory: hook disposer failed:', error);
                }
            }
        },
    };
}
/**
 * One consolidation pass, scheduled off the session-start path. Deterministic
 * work only: expiry, staleness, decay and *detection* of contradictions.
 * Superseding a lesson needs an explicit `memory_consolidate` call, and a
 * promotion always waits for a human.
 */
function runLazyConsolidation(deps, scope) {
    try {
        const store = deps.registry.open(scope);
        if (store === undefined)
            return;
        const due = consolidationDue(store.db, {
            everyDays: deps.config.consolidate.everyDays,
            everyNTasks: deps.config.consolidate.everyNTasks,
        });
        if (!due.due)
            return;
        const report = consolidate(store.db, store.scope, store.fts5, { dryRun: false, resolveConflicts: false });
        // Retention belongs to the same periodic pass: without it the episode
        // files and the signals table grow forever (the setting existed but had
        // no caller).
        const prunedFiles = pruneEpisodes(store.scope, deps.config.episodic.retentionDays);
        const prunedRows = pruneSignals(store.db, deps.config.episodic.retentionDays);
        // Derived / audit data that would otherwise grow forever.
        const prunedUsage = pruneUsage(store.db, deps.config.consolidate.usageRetentionDays);
        let prunedVectors = pruneVectors(store.db, deps.config.semantic.model);
        if (deps.config.semantic.enabled && deps.config.semantic.model !== '') {
            prunedVectors += pruneForeignModels(store.db, deps.config.semantic.model, deps.config.semantic.foreignModelGraceDays);
        }
        log('info', `memory: consolidation (${due.reason}) on ${report.scope} — archived ${report.archived}, decayed ${report.decayed}, conflicts ${report.conflictsFound}, proposals ${report.proposals.length}, pruned ${prunedFiles} episode file(s) / ${prunedRows} signal / ${prunedUsage} usage / ${prunedVectors} vector row(s)`);
    }
    catch (error) {
        log('warn', 'memory: lazy consolidation failed:', error);
    }
}
//# sourceMappingURL=index.js.map