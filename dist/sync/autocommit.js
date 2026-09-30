/**
 * Automatic commits for the memory text view (DESIGN D6).
 *
 * Commits are local and path-scoped: `task-end` (throttled by
 * `git.checkpointMinutes`) or `immediate`. Pushing is deliberately absent from
 * this module — it only ever happens when a human asks for it through
 * `memory_sync({ push: true })`.
 *
 * ## Cross-process coordination (multi-host)
 *
 * Two hosts (nvim-tui and web) can export and commit the same memory root at the
 * same time. SQLite serializes its own writes, but the text-view export and the
 * git commit had no coordination at all: the second host could stage a
 * half-written view, commit an interleaved tree, or leave a momentarily stale
 * `MEMORY.md` behind. The export+commit critical section is therefore wrapped in
 * a lock file, `config.git.lockTimeoutMs` (default 10s) bounding the wait.
 *
 * Design constraints, in order of importance:
 *
 *   1. **Never block a session.** Acquisition polls to the timeout and then
 *      *skips the commit*, logging who holds the lock. It never throws and never
 *      waits forever — a missed checkpoint is re-tried on the next turn
 *      (`task-end` is throttled anyway) or by `memory_sync`.
 *   2. **The lock lives in the memory root, not in `.git/`** (`.git` can be a
 *      file for a worktree, and git itself never looks inside it). The name
 *      says what it is; pid + host + timestamp say who holds it. The name is
 *      added to the root's `.gitignore`, so a lock can never be committed.
 *   3. **A crashed holder must not wedge the root forever**: a lock whose mtime
 *      is older than `STALE_LOCK_MS` (2 min) is stale and is preempted with a
 *      `warn` that names the reason.
 *
 * Everything here is synchronous, because the callers are (turn-stopping and
 * session-disposed handlers return `void`). In-process serialization comes from
 * two places: synchronous sections cannot interleave in a single-threaded
 * runtime, and `commitAsync` adds a per-root promise chain for callers that want
 * to queue several commits (e.g. a host committing on behalf of two agents).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';
import { commitMemory, ensureGitignore } from './git.js';
/** Lock file name inside the memory root — deliberately not under `.git/`. */
export const LOCK_FILE_NAME = '.dsh-memory-commit.lock';
/** A lock older than this (mtime) belongs to a dead holder and may be taken. */
export const STALE_LOCK_MS = 120_000;
/** Poll interval while another process holds the lock. */
const POLL_MS = 50;
export function lockFilePath(root) {
    return path.join(root, LOCK_FILE_NAME);
}
function sleepSync(ms) {
    if (ms <= 0)
        return;
    // The only way to wait synchronously. `Atomics.wait` is allowed on Node's
    // main thread; the wait is always bounded by `config.git.lockTimeoutMs`.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function readHolder(file) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        const holder = {};
        if (typeof parsed['pid'] === 'number')
            holder.pid = parsed['pid'];
        if (typeof parsed['host'] === 'string')
            holder.host = parsed['host'];
        if (typeof parsed['at'] === 'string')
            holder.at = parsed['at'];
        if (typeof parsed['token'] === 'string')
            holder.token = parsed['token'];
        return Object.keys(holder).length > 0 ? holder : undefined;
    }
    catch {
        // Unreadable or malformed: the mtime still tells us whether it is stale.
        return undefined;
    }
}
function describeHolder(holder) {
    if (holder === undefined || holder.pid === undefined)
        return 'an unknown process';
    const since = holder.at !== undefined ? ` since ${holder.at}` : '';
    const host = holder.host !== undefined ? `@${holder.host}` : '';
    return `pid ${holder.pid}${host}${since}`;
}
function lockAgeMs(file) {
    try {
        return Date.now() - fs.statSync(file).mtimeMs;
    }
    catch {
        return undefined;
    }
}
/**
 * Take over a lock whose holder is gone. Re-checks the age immediately before
 * unlinking: a fresh lock created by another process in the meantime must
 * survive (that process then wins the re-created lock).
 */
function preemptStaleLock(file, holder, ageMs) {
    const again = lockAgeMs(file);
    if (again === undefined || again <= STALE_LOCK_MS)
        return false;
    try {
        fs.rmSync(file, { force: true });
    }
    catch (error) {
        log('debug', `memory: could not remove the stale commit lock ${file}:`, error);
        return false;
    }
    log('warn', `memory: preempted a stale commit lock ${file} — held by ${describeHolder(holder)}, mtime ${Math.round(ageMs / 1000)}s old (stale after ${STALE_LOCK_MS / 1000}s), assuming the holder died without releasing`);
    return true;
}
/**
 * Try to create the lock file exclusively. Creation is the atomic step:
 * `wx` fails with `EEXIST` when another process got there first, and any other
 * errno means this root cannot be locked at all (sandbox, read-only mount).
 */
function createLock(file) {
    const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    let fd;
    try {
        fd = fs.openSync(file, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), token }));
        fs.closeSync(fd);
        fd = undefined;
        return { root: path.dirname(file), file, token, preempted: false };
    }
    catch (error) {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch {
                // nothing left to do: the acquisition already failed
            }
        }
        const code = error.code;
        if (code === 'EEXIST')
            return 'busy';
        log('debug', `memory: commit lock ${file} could not be created:`, error);
        return 'unavailable';
    }
}
/**
 * Acquire the export+commit lock for one memory root, waiting up to `timeoutMs`
 * for another process. Returns a failure record (never throws) when the lock
 * stayed busy or could not be created at all.
 */
export function acquireCommitLock(root, timeoutMs) {
    const file = lockFilePath(root);
    const started = Date.now();
    let holder;
    let preempted = false;
    try {
        fs.mkdirSync(root, { recursive: true });
    }
    catch (error) {
        log('debug', `memory: memory root ${root} is not creatable:`, error);
    }
    for (;;) {
        const created = createLock(file);
        if (created === 'unavailable') {
            return { reason: 'lock-unavailable', waitedMs: Date.now() - started, ...(holder !== undefined ? { holder } : {}) };
        }
        if (created !== 'busy') {
            if (preempted)
                created.preempted = true;
            if (holder !== undefined)
                log('info', `memory: commit lock ${file} taken over from ${describeHolder(holder)}`);
            return created;
        }
        holder = readHolder(file) ?? holder;
        const age = lockAgeMs(file);
        if (age !== undefined && age > STALE_LOCK_MS && preemptStaleLock(file, holder, age)) {
            preempted = true;
            continue;
        }
        const waited = Date.now() - started;
        if (waited >= timeoutMs) {
            log('info', `memory: commit lock ${file} is held by ${describeHolder(holder)} — skipping this commit after ${waited}ms (git.lockTimeoutMs)`);
            return { reason: 'lock-timeout', waitedMs: waited, ...(holder !== undefined ? { holder } : {}) };
        }
        sleepSync(Math.max(1, Math.min(POLL_MS, timeoutMs - waited)));
    }
}
/** Release a lock this process holds; never touches a lock someone else took. */
export function releaseCommitLock(lock) {
    try {
        const holder = readHolder(lock.file);
        if (holder !== undefined && holder.token !== undefined && holder.token !== lock.token) {
            log('debug', `memory: not releasing ${lock.file}: it now belongs to ${describeHolder(holder)}`);
            return;
        }
        fs.rmSync(lock.file, { force: true });
    }
    catch (error) {
        log('debug', `memory: releasing the commit lock ${lock.file} failed:`, error);
    }
}
/** Keep the lock file out of the versioned text view (idempotent, append-only). */
function ensureLockIgnored(root) {
    try {
        const file = path.join(root, '.gitignore');
        const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        if (existing.split('\n').includes(LOCK_FILE_NAME))
            return;
        const prefix = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`;
        fs.writeFileSync(file, `${prefix}${LOCK_FILE_NAME}\n`);
    }
    catch (error) {
        log('debug', `memory: could not add ${LOCK_FILE_NAME} to ${root}/.gitignore:`, error);
    }
}
/** Per-root in-process queue, so two committers in one process never race. */
const processChains = new Map();
/** Roots this process is inside the critical section for (re-entrancy guard). */
const inProcessHeld = new Map();
export class AutoCommitter {
    config;
    hooks;
    lastCommit = new Map();
    constructor(config, hooks = {}) {
        this.config = config;
        this.hooks = hooks;
    }
    /** Whether the configured mode allows a commit right now. */
    allowed(scope, now) {
        const mode = this.config.git.autoCommit;
        if (!this.config.git.enabled || mode === 'off')
            return false;
        if (mode === 'immediate')
            return true;
        const last = this.lastCommit.get(scope.root);
        if (last === undefined)
            return true;
        return now - last >= this.config.git.checkpointMinutes * 60_000;
    }
    /**
     * Commit the memory root when the policy allows it. Safe to call on every
     * turn end: a no-op commit is a no-op.
     */
    maybeCommit(scope, reason, now = Date.now()) {
        if (!this.allowed(scope, now))
            return undefined;
        return this.commitNow(scope, reason, now);
    }
    /**
     * Same as {@link maybeCommit}, but queued behind any in-flight commit for the
     * same root in this process (promise chain) — the entry point for callers
     * that are already asynchronous.
     */
    async maybeCommitAsync(scope, reason, now = Date.now()) {
        if (!this.allowed(scope, now))
            return undefined;
        return this.commitAsync(scope, reason, now);
    }
    /** Force a commit (session end, explicit user request). */
    commitNow(scope, reason, now = Date.now()) {
        return this.commit(scope, reason, now);
    }
    /** Force a commit, queued behind in-flight commits for the same root. */
    async commitAsync(scope, reason, now = Date.now()) {
        const previous = processChains.get(scope.root) ?? Promise.resolve();
        let release = () => undefined;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => gate);
        processChains.set(scope.root, tail);
        await previous.catch(() => undefined);
        try {
            return this.commit(scope, reason, now);
        }
        finally {
            release();
            if (processChains.get(scope.root) === tail)
                processChains.delete(scope.root);
        }
    }
    /** Last commit timestamp for one root (tests and stats). */
    lastCommitAt(root) {
        return this.lastCommit.get(root);
    }
    /**
     * The export+commit critical section: export the text view, stage, commit.
     * Exactly one process (and one call inside this process) is inside at a time.
     */
    commit(scope, reason, now) {
        const held = inProcessHeld.get(scope.root);
        if (held !== undefined) {
            // Re-entrant call (an export hook that commits, two hosts sharing a
            // root): waiting would deadlock on our own lock file.
            log('debug', `memory: commit skipped for ${scope.root}: this process is already committing it (${reason})`);
            return { committed: false, files: 0, detail: 'already committing in this process', skipped: 'in-process' };
        }
        const token = `${process.pid}-${now}`;
        inProcessHeld.set(scope.root, token);
        let lock;
        try {
            const acquired = acquireCommitLock(scope.root, this.config.git.lockTimeoutMs);
            if (!('file' in acquired)) {
                return {
                    committed: false,
                    files: 0,
                    detail: acquired.reason === 'lock-timeout'
                        ? `skipped: another process holds the commit lock (${describeHolder(acquired.holder)})`
                        : 'skipped: the commit lock could not be created',
                    skipped: acquired.reason,
                };
            }
            lock = acquired;
            // Both ignore files are written inside the lock: the lock file must
            // never be staged, and the gitignore template must exist before add.
            ensureGitignore(scope.root);
            ensureLockIgnored(scope.root);
            this.hooks.exportText?.(scope);
            const result = commitMemory(scope.root, {
                message: `${scope.kind === 'project' ? 'project' : 'global'} memory: ${reason}`,
            });
            if (result.committed) {
                this.lastCommit.set(scope.root, now);
                log('info', `memory: committed ${result.files} file(s) in ${scope.root} (${reason})`);
                return { committed: true, files: result.files, detail: reason };
            }
            if (!result.ok)
                log('debug', `memory: commit skipped for ${scope.root}: ${result.stderr.trim()}`);
            return { committed: false, files: 0, detail: result.ok ? 'nothing to commit' : result.stderr.trim() };
        }
        catch (error) {
            log('warn', `memory: commit failed for ${scope.root}:`, error);
            return { committed: false, files: 0, detail: error instanceof Error ? error.message : String(error) };
        }
        finally {
            // Release on every path, exceptions included: a leaked lock would
            // block both hosts until it goes stale.
            if (lock !== undefined)
                releaseCommitLock(lock);
            if (inProcessHeld.get(scope.root) === token)
                inProcessHeld.delete(scope.root);
        }
    }
}
//# sourceMappingURL=autocommit.js.map