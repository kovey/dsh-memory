/**
 * L1 episodic persistence (DESIGN §3, D5).
 *
 * Episodes are structured signals, never raw conversation: one JSONL file per
 * session under the owning scope's `sessions/`, plus indexed rows in the
 * `signals` table. Project sessions write inside `<repo>/.dsh/memory` only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import { ensureDir } from '../paths.js';
import { assertInsideScope } from '../store/guard.js';
import { transact } from '../store/sqlite/db.js';
import { redact } from './redact.js';
/** Directory holding episode logs for one scope. */
export function sessionsDir(scope) {
    return path.join(scope.root, 'sessions');
}
/** Episode file name: date-stamped and session-scoped. */
export function sessionFilePath(scope, sessionId, now = new Date()) {
    const day = now.toISOString().slice(0, 10);
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
    return path.join(sessionsDir(scope), `${day}.${safe}.jsonl`);
}
/** Persist one turn's signals: JSONL view + `signals` rows. */
export function recordEpisode(db, scope, input, now = new Date()) {
    if (input.signals.length === 0)
        return 0;
    const at = now.toISOString();
    const file = sessionFilePath(scope, input.sessionId, now);
    assertInsideScope(scope, file);
    if (!ensureDir(path.dirname(file))) {
        log('warn', `memory: cannot create episode directory for ${scope.root} (sandbox denial?)`);
        return 0;
    }
    const policy = input.captureUserText ?? 'redacted';
    const lines = input.signals.map((signal) => {
        const detail = signal.detail !== undefined ? redact(signal.detail, policy) : '';
        return JSON.stringify({
            at: signal.at,
            session: input.sessionId,
            turn: signal.turn,
            ...(signal.step !== undefined ? { step: signal.step } : {}),
            kind: signal.kind,
            ...(signal.tool !== undefined ? { tool: signal.tool } : {}),
            ...(detail !== '' ? { detail } : {}),
        });
    });
    try {
        fs.appendFileSync(file, `${lines.join('\n')}\n`);
    }
    catch (error) {
        log('warn', `memory: episode append failed for ${file}:`, error);
    }
    try {
        transact(db, () => {
            const statement = db.prepare('INSERT INTO signals (session_id, turn, step, kind, tool, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)');
            for (const signal of input.signals) {
                statement.run(input.sessionId, signal.turn, signal.step ?? null, signal.kind, signal.tool ?? null, signal.detail !== undefined ? redact(signal.detail, policy) || null : null, signal.at);
            }
        });
    }
    catch (error) {
        log('warn', 'memory: signal rows failed:', error);
    }
    return input.signals.length;
}
/** Aggregate episode signals for `memory_stats`. */
export function episodeDigest(db, sinceDays = 90) {
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    const rows = db
        .prepare('SELECT kind, COUNT(*) AS n, COUNT(DISTINCT session_id) AS s FROM signals WHERE at >= ? GROUP BY kind')
        .all(since);
    const byKind = {};
    let signals = 0;
    let sessions = 0;
    for (const row of rows) {
        const kind = typeof row['kind'] === 'string' ? row['kind'] : 'unknown';
        const n = typeof row['n'] === 'number' ? row['n'] : 0;
        const s = typeof row['s'] === 'number' ? row['s'] : 0;
        byKind[kind] = n;
        signals += n;
        sessions = Math.max(sessions, s);
    }
    return { sessions, signals, byKind };
}
/**
 * Delete `signals` rows older than the retention window.
 *
 * The pending-distillation window is 14 days, so anything past the retention
 * period can no longer be recovered and only costs space. Rows are deleted only
 * when they have already been distilled *or* are far past recovery age — a debt
 * is never silently dropped.
 */
export function pruneSignals(db, retentionDays, now = new Date()) {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    const result = db
        .prepare(`DELETE FROM signals
             WHERE at < ?
               AND (EXISTS (SELECT 1 FROM distill d WHERE d.session_id = signals.session_id AND d.turn = signals.turn)
                    OR at < ?)`)
        .run(cutoff, new Date(now.getTime() - PENDING_RETENTION_DAYS * 86_400_000).toISOString());
    return typeof result.changes === 'number' ? result.changes : 0;
}
/** Signals older than this are never recovered, so they may be pruned. */
export const PENDING_RETENTION_DAYS = 14;
/** Delete episode files older than the retention window (D5: 90 days). */
export function pruneEpisodes(scope, retentionDays, now = new Date()) {
    const dir = sessionsDir(scope);
    assertInsideScope(scope, dir);
    let removed = 0;
    let entries;
    try {
        entries = fs.readdirSync(dir);
    }
    catch {
        return 0;
    }
    const cutoff = now.getTime() - retentionDays * 86_400_000;
    for (const name of entries) {
        if (!name.endsWith('.jsonl'))
            continue;
        const day = name.slice(0, 10);
        const stamp = Date.parse(`${day}T00:00:00.000Z`);
        if (!Number.isFinite(stamp) || stamp >= cutoff)
            continue;
        try {
            fs.rmSync(path.join(dir, name));
            removed += 1;
        }
        catch (error) {
            log('debug', `memory: pruning ${name} failed:`, error);
        }
    }
    return removed;
}
//# sourceMappingURL=episodic.js.map