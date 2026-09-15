/**
 * Bounded automatic distillation (DESIGN §4.2, §7).
 *
 * The only path in this plugin that spends money, so every guardrail is
 * deliberate: pain-signal turns only, a fixed cheap model, a hard wall-clock
 * timeout, per-session and per-day caps, full audit rows, and a write gate on
 * everything that comes back. A timeout or a bad model answer costs nothing but
 * a log line — the signals stay in L1 for the skill-based fallback path.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryConfig } from '../config.js';
import type { SessionState } from '../recall/session-state.js';
import { ScopeResolver } from '../scope/resolver.js';
import type { AgentLike } from '../scope/resolver.js';
import type { StoreRegistry, ScopeStore } from '../store/store.js';
import type { Evidence, MemoryScope } from '../store/types.js';
import type { Signal } from './signals.js';
export interface DistillDeps {
    ctx: Context;
    config: MemoryConfig;
    registry: StoreRegistry;
    resolver: ScopeResolver;
    state: SessionState;
}
export interface DistillRequest {
    agent?: AgentLike | undefined;
    sessionId: string;
    turn: number;
    signals: readonly Signal[];
    /**
     * External cancellation (a job being killed, a session shutting down). The
     * timeout controller is local, so without this a "cancelled" distillation
     * kept running: it spent tokens, wrote records and reported `completed`.
     */
    signal?: AbortSignal;
    recalled: readonly string[];
}
export interface DistillOutcome {
    status: 'created' | 'merged' | 'rejected' | 'skipped' | 'timeout' | 'error';
    created: number;
    merged: number;
    rejected: number;
    tokensIn: number;
    tokensOut: number;
    reason?: string;
    recordIds: string[];
}
export interface ModelRoute {
    provider: string;
    model: string;
}
/**
 * Which route the distillation call uses.
 *
 * An explicit `learn.distillModel` wins; otherwise the session's own route is
 * inherited, so the plugin follows the user's existing configuration instead of
 * asking for a second set of LLM settings. `undefined` = no route available at
 * all, and distillation is skipped (signals stay in L1).
 */
export declare function resolveDistillRoute(config: MemoryConfig, agent: AgentLike | undefined): ModelRoute | undefined;
/** Today's distillation spend, in estimated tokens. */
export declare function dailyDistillTokens(db: DatabaseSync, now?: Date): number;
/** Whether this turn may spend an LLM call at all (DESIGN §4.2). */
export declare function distillAllowed(deps: DistillDeps, request: DistillRequest): {
    allowed: boolean;
    reason?: string;
};
/** Distil one painful turn into gated memory records. */
export declare function distillTurn(deps: DistillDeps, request: DistillRequest): Promise<DistillOutcome>;
/** Compact, redacted digest of one turn's signals. */
export declare function buildPrompt(request: DistillRequest): string;
export interface ParsedCandidate {
    title: string;
    body: string;
    confidence: number;
    tags: string[];
}
/** Tolerant JSON extraction: models sometimes wrap the array in prose/fences. */
export declare function parseCandidates(text: string): ParsedCandidate[];
/** Objective evidence attached to every distilled record. */
export declare function evidenceFromSignals(signals: readonly Signal[]): Evidence[];
/** Scope helper for callers that already resolved a store. */
export declare function scopeOf(store: ScopeStore): MemoryScope;
//# sourceMappingURL=distill.d.ts.map