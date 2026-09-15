/**
 * Confidence arithmetic (DESIGN §7).
 *
 * Conservative on purpose: repetition and demonstrated usefulness raise a
 * record, age decays it, and a failed recall lowers it. The negative feedback is
 * what stops memory from becoming confidently wrong.
 */
export interface ConfidenceInput {
    /** Existing confidence, or the drafted one for a new record. */
    base: number;
    timesSeen: number;
    successAfterRecall: number;
    failAfterRecall: number;
    updatedAt: string;
    /** Days after which the freshness factor halves. */
    halfLifeDays?: number;
    now?: Date;
}
export declare function clamp01(value: number): number;
/** Repetition gain with diminishing returns. */
export declare function seenFactor(timesSeen: number): number;
/** Usage verdict: records that paid off gain, records that failed lose. */
export declare function usageFactor(successAfterRecall: number, failAfterRecall: number): number;
/** Time decay: halves every `halfLifeDays`, floored so records fade slowly. */
export declare function decayFactor(updatedAt: string, now: Date, halfLifeDays?: number): number;
/** The full update rule (DESIGN §7). */
export declare function nextConfidence(input: ConfidenceInput): number;
/** Proposed confidence for a freshly distilled candidate. */
export declare function candidateConfidence(suggested: number, evidenceCount: number, now?: Date): number;
/** Records below this are hypotheses: surfaced, never executed (DESIGN §7). */
/** Records below this enter the store as `pending` rather than `active`. */
export declare const PENDING_THRESHOLD = 0.6;
export declare function statusFor(confidence: number): 'active' | 'pending';
//# sourceMappingURL=confidence.d.ts.map