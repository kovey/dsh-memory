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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MemoryConfig } from '../config.js'
import { log } from '../log.js'
import type { MemoryScope } from '../store/types.js'
import { commitMemory, ensureGitignore } from './git.js'

/** Lock file name inside the memory root — deliberately not under `.git/`. */
export const LOCK_FILE_NAME = '.dsh-memory-commit.lock'
/** A lock older than this (mtime) *may* belong to a dead holder. */
export const STALE_LOCK_MS = 120_000
/** Deadline used when no usable `timeoutMs` reaches {@link acquireCommitLock}. */
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000
/** Poll interval while another process holds the lock. */
const POLL_MS = 50

export interface CommitOutcome {
    committed: boolean
    files: number
    detail: string
    /** Why a commit did not happen, when it was not simply "nothing to commit". */
    skipped?: 'lock-timeout' | 'lock-unavailable' | 'in-process'
}

/** Who holds the lock, as far as the lock file says. */
export interface LockHolder {
    pid?: number
    host?: string
    at?: string
    /** Identity of one acquisition, so we only ever release our own lock. */
    token?: string
}

export interface CommitLock {
    root: string
    file: string
    token: string
    /** True when an existing, stale lock was preempted to get here. */
    preempted: boolean
}

export interface CommitLockFailure {
    reason: 'lock-timeout' | 'lock-unavailable'
    waitedMs: number
    holder?: LockHolder
}

export function lockFilePath(root: string): string {
    return path.join(root, LOCK_FILE_NAME)
}

function sleepSync(ms: number): void {
    if (ms <= 0) return
    // The only way to wait synchronously. `Atomics.wait` is allowed on Node's
    // main thread; the wait is always bounded by `config.git.lockTimeoutMs`.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function readHolder(file: string): LockHolder | undefined {
    try {
        const raw = fs.readFileSync(file, 'utf8')
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const holder: LockHolder = {}
        if (typeof parsed['pid'] === 'number') holder.pid = parsed['pid']
        if (typeof parsed['host'] === 'string') holder.host = parsed['host']
        if (typeof parsed['at'] === 'string') holder.at = parsed['at']
        if (typeof parsed['token'] === 'string') holder.token = parsed['token']
        return Object.keys(holder).length > 0 ? holder : undefined
    } catch {
        // Unreadable or malformed: the mtime still tells us whether it is stale.
        return undefined
    }
}

function describeHolder(holder: LockHolder | undefined): string {
    if (holder === undefined || holder.pid === undefined) return 'an unknown process'
    const since = holder.at !== undefined ? ` since ${holder.at}` : ''
    const host = holder.host !== undefined ? `@${holder.host}` : ''
    return `pid ${holder.pid}${host}${since}`
}

function lockAgeMs(file: string): number | undefined {
    try {
        return Date.now() - fs.statSync(file).mtimeMs
    } catch {
        return undefined
    }
}

/**
 * Take over a lock whose holder is gone. Re-checks the age immediately before
 * unlinking: a fresh lock created by another process in the meantime must
 * survive (that process then wins the re-created lock).
 */
function preemptStaleLock(file: string, holder: LockHolder | undefined, ageMs: number): boolean {
    const again = lockAgeMs(file)
    if (again === undefined || again <= STALE_LOCK_MS) return false
    try {
        fs.rmSync(file, { force: true })
    } catch (error) {
        log('debug', `memory: could not remove the stale commit lock ${file}:`, error)
        return false
    }
    log(
        'warn',
        `memory: preempted a stale commit lock ${file} — held by ${describeHolder(holder)}, mtime ${Math.round(ageMs / 1000)}s old (stale after ${STALE_LOCK_MS / 1000}s), assuming the holder died without releasing`,
    )
    return true
}

/**
 * Liveness of the holder, when it can be decided at all.
 *
 * `true`/`false` are answers for a holder on *this* host (the lock records pid
 * and hostname); `undefined` means "cannot tell" — another machine sharing the
 * root, or a malformed lock — and the mtime is then the only evidence.
 *
 * This is what keeps a *slow* holder from being preempted: an export or a git
 * commit that takes longer than `STALE_LOCK_MS` used to look exactly like a
 * crashed process, and two holders then sat in the critical section together.
 */
function holderIsAlive(holder: LockHolder | undefined): boolean | undefined {
    if (holder?.pid === undefined) return undefined
    if (holder.host !== undefined && holder.host !== os.hostname()) return undefined
    try {
        // signal 0 = "does this process exist and may I signal it", no delivery
        process.kill(holder.pid, 0)
        return true
    } catch (error) {
        // EPERM means the process exists but belongs to another user.
        return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
}

/**
 * Refresh a held lock's mtime — the heartbeat of a long critical section.
 *
 * The section is synchronous, so a timer cannot fire inside it: the holder
 * instead touches its own lock at each phase boundary (acquire, after the
 * export, before the commit). A *single* phase longer than `STALE_LOCK_MS`
 * therefore still looks stale to a foreign host; a same-host contender is
 * covered by {@link holderIsAlive} instead.
 */
export function touchCommitLock(lock: CommitLock, now = Date.now()): void {
    try {
        const stamp = new Date(now)
        fs.utimesSync(lock.file, stamp, stamp)
    } catch (error) {
        log('debug', `memory: refreshing the commit lock ${lock.file} failed:`, error)
    }
}

/**
 * Try to create the lock file exclusively. Creation is the atomic step:
 * `wx` fails with `EEXIST` when another process got there first, and any other
 * errno means this root cannot be locked at all (sandbox, read-only mount).
 */
function createLock(file: string): CommitLock | 'busy' | 'unavailable' {
    const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    let fd: number | undefined
    try {
        fd = fs.openSync(file, 'wx')
        fs.writeSync(
            fd,
            JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), token }),
        )
        fs.closeSync(fd)
        fd = undefined
        return { root: path.dirname(file), file, token, preempted: false }
    } catch (error) {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd)
            } catch {
                // nothing left to do: the acquisition already failed
            }
        }
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST') return 'busy'
        log('debug', `memory: commit lock ${file} could not be created:`, error)
        return 'unavailable'
    }
}

/**
 * Acquire the export+commit lock for one memory root, waiting up to `timeoutMs`
 * for another process. Returns a failure record (never throws) when the lock
 * stayed busy or could not be created at all.
 *
 * `timeoutMs` falls back to {@link DEFAULT_LOCK_TIMEOUT_MS} for anything that is
 * not a usable non-negative number. `waited >= undefined` is false forever, so a
 * caller that omitted the value (a partially built config object is enough) used
 * to spin in this loop without ever reaching the deadline.
 */
export function acquireCommitLock(root: string, timeoutMs?: number): CommitLock | CommitLockFailure {
    const deadlineMs =
        typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 0
            ? timeoutMs
            : DEFAULT_LOCK_TIMEOUT_MS
    const file = lockFilePath(root)
    const started = Date.now()
    let holder: LockHolder | undefined
    let preempted = false
    let warnedAlive = false
    try {
        fs.mkdirSync(root, { recursive: true })
    } catch (error) {
        log('debug', `memory: memory root ${root} is not creatable:`, error)
    }
    for (;;) {
        const created = createLock(file)
        if (created === 'unavailable') {
            return { reason: 'lock-unavailable', waitedMs: Date.now() - started, ...(holder !== undefined ? { holder } : {}) }
        }
        if (created !== 'busy') {
            if (preempted) created.preempted = true
            if (holder !== undefined) log('info', `memory: commit lock ${file} taken over from ${describeHolder(holder)}`)
            return created
        }
        holder = readHolder(file) ?? holder

        const age = lockAgeMs(file)
        const alive = holderIsAlive(holder)
        if (age !== undefined && age > STALE_LOCK_MS && alive !== true && preemptStaleLock(file, holder, age)) {
            preempted = true
            continue
        }
        if (alive === true && age !== undefined && age > STALE_LOCK_MS && !warnedAlive) {
            warnedAlive = true
            log(
                'info',
                `memory: commit lock ${file} looks stale (mtime ${Math.round(age / 1000)}s) but ${describeHolder(holder)} is alive on this host — waiting instead of preempting it`,
            )
        }

        const waited = Date.now() - started
        if (waited >= deadlineMs) {
            log(
                'info',
                `memory: commit lock ${file} is held by ${describeHolder(holder)} — skipping this commit after ${waited}ms (git.lockTimeoutMs)`,
            )
            return { reason: 'lock-timeout', waitedMs: waited, ...(holder !== undefined ? { holder } : {}) }
        }
        sleepSync(Math.max(1, Math.min(POLL_MS, deadlineMs - waited)))
    }
}

/** Release a lock this process holds; never touches a lock someone else took. */
export function releaseCommitLock(lock: CommitLock): void {
    try {
        const holder = readHolder(lock.file)
        if (holder !== undefined && holder.token !== undefined && holder.token !== lock.token) {
            log('debug', `memory: not releasing ${lock.file}: it now belongs to ${describeHolder(holder)}`)
            return
        }
        fs.rmSync(lock.file, { force: true })
    } catch (error) {
        log('debug', `memory: releasing the commit lock ${lock.file} failed:`, error)
    }
}

/** Keep the lock file out of the versioned text view (idempotent, append-only). */
function ensureLockIgnored(root: string): void {
    try {
        const file = path.join(root, '.gitignore')
        const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
        if (existing.split('\n').includes(LOCK_FILE_NAME)) return
        const prefix = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`
        fs.writeFileSync(file, `${prefix}${LOCK_FILE_NAME}\n`)
    } catch (error) {
        log('debug', `memory: could not add ${LOCK_FILE_NAME} to ${root}/.gitignore:`, error)
    }
}

/** Text-view export hook, run inside the lock right before the commit. */
export interface CommitHooks {
    /**
     * Export the store's records to the git-tracked text view.
     *
     * `false` means "the export did not run" (a store that is not open, an
     * export error) and is logged as a `warn`: a commit that succeeds while the
     * text view silently misses records is how a later rebuild deletes them.
     */
    exportText?: (scope: MemoryScope) => void | boolean
}

/** Per-root in-process queue, so two committers in one process never race. */
const processChains = new Map<string, Promise<void>>()
/** Roots this process is inside the critical section for (re-entrancy guard). */
const inProcessHeld = new Map<string, string>()

export class AutoCommitter {
    private readonly lastCommit = new Map<string, number>()

    constructor(
        private readonly config: MemoryConfig,
        private readonly hooks: CommitHooks = {},
    ) {}

    /** Whether the configured mode allows a commit right now. */
    private allowed(scope: MemoryScope, now: number): boolean {
        const mode = this.config.git.autoCommit
        if (!this.config.git.enabled || mode === 'off') return false
        if (mode === 'immediate') return true
        const last = this.lastCommit.get(scope.root)
        if (last === undefined) return true
        return now - last >= this.config.git.checkpointMinutes * 60_000
    }

    /**
     * Commit the memory root when the policy allows it. Safe to call on every
     * turn end: a no-op commit is a no-op.
     */
    maybeCommit(scope: MemoryScope, reason: string, now = Date.now()): CommitOutcome | undefined {
        if (!this.allowed(scope, now)) return undefined
        return this.commitNow(scope, reason, now)
    }

    /**
     * Same as {@link maybeCommit}, but queued behind any in-flight commit for the
     * same root in this process (promise chain) — the entry point for callers
     * that are already asynchronous.
     */
    async maybeCommitAsync(scope: MemoryScope, reason: string, now = Date.now()): Promise<CommitOutcome | undefined> {
        if (!this.allowed(scope, now)) return undefined
        return this.commitAsync(scope, reason, now)
    }

    /** Force a commit (session end, explicit user request). */
    commitNow(scope: MemoryScope, reason: string, now = Date.now()): CommitOutcome {
        return this.commit(scope, reason, now)
    }

    /** Force a commit, queued behind in-flight commits for the same root. */
    async commitAsync(scope: MemoryScope, reason: string, now = Date.now()): Promise<CommitOutcome> {
        const previous = processChains.get(scope.root) ?? Promise.resolve()
        let release: () => void = () => undefined
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const tail = previous.then(() => gate)
        processChains.set(scope.root, tail)
        await previous.catch(() => undefined)
        try {
            return this.commit(scope, reason, now)
        } finally {
            release()
            if (processChains.get(scope.root) === tail) processChains.delete(scope.root)
        }
    }

    /** Last commit timestamp for one root (tests and stats). */
    lastCommitAt(root: string): number | undefined {
        return this.lastCommit.get(root)
    }

    /**
     * The export+commit critical section: export the text view, stage, commit.
     * Exactly one process (and one call inside this process) is inside at a time.
     */
    private commit(scope: MemoryScope, reason: string, now: number): CommitOutcome {
        if (inProcessHeld.has(scope.root)) {
            // Re-entrant call (an export hook that commits, two hosts sharing a
            // root): waiting would deadlock on our own lock file.
            log('debug', `memory: commit skipped for ${scope.root}: this process is already committing it (${reason})`)
            return { committed: false, files: 0, detail: 'already committing in this process', skipped: 'in-process' }
        }
        const token = `${process.pid}-${now}`
        inProcessHeld.set(scope.root, token)
        let lock: CommitLock | undefined
        try {
            const acquired = acquireCommitLock(scope.root, this.config.git.lockTimeoutMs)
            if (!('file' in acquired)) {
                return {
                    committed: false,
                    files: 0,
                    detail:
                        acquired.reason === 'lock-timeout'
                            ? `skipped: another process holds the commit lock (${describeHolder(acquired.holder)})`
                            : 'skipped: the commit lock could not be created',
                    skipped: acquired.reason,
                }
            }
            lock = acquired
            // Both ignore files are written inside the lock: the lock file must
            // never be staged, and the gitignore template must exist before add.
            ensureGitignore(scope.root)
            ensureLockIgnored(scope.root)
            // Phase boundary: the export and the git commit are each unbounded
            // work, so the lock is refreshed around them rather than relying on a
            // timer that cannot fire inside this synchronous section.
            touchCommitLock(lock)
            const exported = this.hooks.exportText?.(scope)
            if (exported === false) {
                // Not fatal for the commit itself (the text view may be complete
                // already), but a silent miss is unrecoverable: the next rebuild
                // reads the text view as the source of truth.
                log(
                    'warn',
                    `memory: text-view export failed for ${scope.root} (${reason}) — the commit may not carry this store's records; the export is skipped when its database is not open`,
                )
            }
            touchCommitLock(lock)
            const result = commitMemory(scope.root, {
                message: `${scope.kind === 'project' ? 'project' : 'global'} memory: ${reason}`,
            })
            if (result.committed) {
                this.lastCommit.set(scope.root, now)
                log('info', `memory: committed ${result.files} file(s) in ${scope.root} (${reason})`)
                return { committed: true, files: result.files, detail: reason }
            }
            if (!result.ok) log('debug', `memory: commit skipped for ${scope.root}: ${result.stderr.trim()}`)
            return { committed: false, files: 0, detail: result.ok ? 'nothing to commit' : result.stderr.trim() }
        } catch (error) {
            log('warn', `memory: commit failed for ${scope.root}:`, error)
            return { committed: false, files: 0, detail: error instanceof Error ? error.message : String(error) }
        } finally {
            // Release on every path, exceptions included: a leaked lock would
            // block both hosts until it goes stale.
            if (lock !== undefined) releaseCommitLock(lock)
            if (inProcessHeld.get(scope.root) === token) inProcessHeld.delete(scope.root)
        }
    }
}
