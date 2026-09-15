import { log } from '../log.js';
import { distillTurn } from './distill.js';
/** Optional service lookup that never throws and never requires inject. */
export function optionalJobs(ctx) {
    try {
        const reflect = ctx.reflect;
        const jobs = reflect?.get?.('jobs', false);
        if (jobs === undefined || jobs === null)
            return undefined;
        if (typeof jobs.start !== 'function')
            return undefined;
        return jobs;
    }
    catch {
        return undefined;
    }
}
/**
 * Groups this process is distilling *right now*, keyed by `sessionId\0turn`.
 *
 * A distillation call may run for `distillTimeoutMs` and only writes its audit
 * row at the very end, so for that entire window the group still *looks*
 * unattempted to `pending.ts`. Without this set a quiet turn in the same process
 * distils the same signals a second time: two audit rows, `times_seen=2`, and a
 * confidence the merge path raises without a single new piece of evidence —
 * exactly the "越学越自信" failure DESIGN §12 warns about.
 */
const inFlight = new Map();
/** A mark may outlive its (hard-bounded) call by this much before it is stale. */
const IN_FLIGHT_GRACE_MS = 10_000;
function distillationKey(sessionId, turn) {
    return `${sessionId}\u0000${turn}`;
}
/** Mark a group as being distilled; visible to `isDistilling` immediately. */
export function beginDistillation(sessionId, turn) {
    inFlight.set(distillationKey(sessionId, turn), Date.now());
}
/** Clear the mark once the attempt settled (audit row written, or the job died). */
export function endDistillation(sessionId, turn) {
    inFlight.delete(distillationKey(sessionId, turn));
}
/**
 * Whether this process is already distilling that group.
 *
 * `ttlMs` bounds how long a mark may outlive its distillation: a job that is
 * killed before its producer ever runs would otherwise hide the group from
 * recovery for the rest of the process's life.
 */
export function isDistilling(sessionId, turn, ttlMs) {
    const key = distillationKey(sessionId, turn);
    const at = inFlight.get(key);
    if (at === undefined)
        return false;
    if (Date.now() - at <= ttlMs)
        return true;
    inFlight.delete(key);
    return false;
}
/** How long an in-flight mark stays trustworthy, derived from the call bound. */
export function distillInFlightTtlMs(distillTimeoutMs) {
    return Math.max(0, distillTimeoutMs) + IN_FLIGHT_GRACE_MS;
}
/**
 * Run — or hand off — one turn's distillation according to
 * `learn.distillRunner`. Never throws: a failing job submission falls back to
 * the inline path.
 *
 * Both runners mark the group in flight for as long as it is being distilled —
 * for the jobs path that starts *before* `jobs.start`, because the job's own LLM
 * call is what makes the group look unattempted.
 */
export async function runDistillation(deps, request) {
    const mode = request.mode ?? deps.config.learn.distillRunner;
    if (mode === 'jobs') {
        const jobs = optionalJobs(deps.ctx);
        if (jobs !== undefined) {
            beginDistillation(request.sessionId, request.turn);
            try {
                const jobId = jobs.start({
                    kind: 'memory-distill',
                    label: `distil memory from turn ${request.turn} (${request.signals.length} signal(s))`,
                    ...(request.ownerAgent !== undefined ? { owner: request.ownerAgent } : {}),
                    run: () => startJob(deps, request),
                });
                return { mode: 'jobs', jobId };
            }
            catch (error) {
                endDistillation(request.sessionId, request.turn);
                log('warn', 'memory: job submission failed, falling back to inline distillation:', error);
            }
        }
        else {
            log('debug', 'memory: ctx.jobs unavailable — distilling inline');
        }
    }
    beginDistillation(request.sessionId, request.turn);
    try {
        const outcome = await distillTurn({ ctx: deps.ctx, config: deps.config, registry: deps.registry, resolver: deps.resolver, state: deps.state }, request);
        return { mode: 'inline', outcome };
    }
    finally {
        endDistillation(request.sessionId, request.turn);
    }
}
/** Producer hooks for one distillation job. */
function startJob(deps, request) {
    const controller = new AbortController();
    const promise = distillTurn({ ctx: deps.ctx, config: deps.config, registry: deps.registry, resolver: deps.resolver, state: deps.state }, { ...request, signal: controller.signal })
        .then((outcome) => {
        log('info', `memory: job distillation finished (${outcome.status}, +${outcome.created}/~${outcome.merged})`);
        return {
            status: (outcome.status === 'error' ? 'failed' : 'completed'),
            detail: `${outcome.status}: +${outcome.created} new, ~${outcome.merged} merged, -${outcome.rejected} rejected`,
            output: outcome.recordIds.join(', '),
        };
    })
        .catch((error) => ({
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
    }))
        // A cancelled or crashed job must stop hiding its group from recovery.
        .finally(() => {
        endDistillation(request.sessionId, request.turn);
    });
    return {
        cancel: (reason) => {
            log('debug', `memory: distillation job cancelled${reason !== undefined ? ` (${reason})` : ''}`);
            controller.abort();
        },
        done: promise,
    };
}
//# sourceMappingURL=distill-runner.js.map