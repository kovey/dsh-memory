/**
 * Confidence arithmetic (DESIGN §7).
 *
 * Conservative on purpose: repetition and demonstrated usefulness raise a
 * record, age decays it, and a failed recall lowers it. The negative feedback is
 * what stops memory from becoming confidently wrong.
 */
export function clamp01(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.min(1, Math.max(0, value));
}
/** Repetition gain with diminishing returns. */
export function seenFactor(timesSeen) {
    return 1 + 0.04 * Math.log(1 + Math.max(0, timesSeen));
}
/** Usage verdict: records that paid off gain, records that failed lose. */
export function usageFactor(successAfterRecall, failAfterRecall) {
    const total = successAfterRecall + failAfterRecall;
    if (total === 0)
        return 1;
    const ratio = (successAfterRecall - failAfterRecall) / total;
    return Math.max(0.7, Math.min(1.15, 1 + 0.1 * ratio));
}
/** Time decay: halves every `halfLifeDays`, floored so records fade slowly. */
export function decayFactor(updatedAt, now, halfLifeDays = 180) {
    const updated = Date.parse(updatedAt);
    if (!Number.isFinite(updated))
        return 0.9;
    const ageDays = Math.max(0, (now.getTime() - updated) / 86_400_000);
    return Math.max(0.5, Math.pow(0.5, ageDays / halfLifeDays));
}
/** The full update rule (DESIGN §7). */
export function nextConfidence(input) {
    const now = input.now ?? new Date();
    const value = clamp01(input.base) *
        seenFactor(input.timesSeen) *
        usageFactor(input.successAfterRecall, input.failAfterRecall) *
        decayFactor(input.updatedAt, now, input.halfLifeDays ?? 180);
    return Math.round(Math.min(0.99, value) * 1000) / 1000;
}
/** Proposed confidence for a freshly distilled candidate. */
export function candidateConfidence(suggested, evidenceCount, now = new Date()) {
    const evidenceBoost = 1 + 0.05 * Math.min(evidenceCount, 4);
    const base = clamp01(suggested) * evidenceBoost;
    void now;
    return Math.min(0.85, Math.round(base * 1000) / 1000);
}
/** Records below this are hypotheses: surfaced, never executed (DESIGN §7). */
/** Records below this enter the store as `pending` rather than `active`. */
export const PENDING_THRESHOLD = 0.6;
export function statusFor(confidence) {
    return confidence < PENDING_THRESHOLD ? 'pending' : 'active';
}
//# sourceMappingURL=confidence.js.map