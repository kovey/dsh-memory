export declare const MEMORY_PLUGIN_ID = "dsh-memory";
/**
 * Producer-owned source kind for messages this plugin injects.
 *
 * dsh 0.1.7 removed the shared catch-all `plugin` kind: `MessageSourceMap` is a
 * merge-extensible sum type and each producer declares its own kind, while the
 * session format v4 REJECTS `kind: 'plugin'` outright ("refuses retired plugin
 * wrappers"). The declaration lives in `src/message-source.ts`.
 */
export declare const MEMORY_SOURCE_KIND = "dsh-memory";
/** Structural view of an LLM message — enough to read text and provenance. */
export interface MessageLike {
    content?: unknown;
    source?: {
        kind?: string;
        plugin?: string;
        form?: string;
        summary?: string;
    };
}
export interface RecallQuery {
    /** Raw text the query was derived from. */
    text: string;
    /** Search terms (CJK runs stay whole; ASCII words lowercase). */
    terms: string[];
    /** How many messages contributed text. */
    sources: number;
}
/** True when this message was injected by the memory plugin itself.
 *
 * Reads BOTH shapes on purpose: sessions written before the 0.1.7 migration
 * carry `{kind:'plugin', plugin:'dsh-memory'}`, newer ones `{kind:'dsh-memory'}`.
 * Missing the legacy shape would let an old recall pack be re-ingested as query
 * text (self-reinforcing store). */
export declare function isMemoryMessage(message: MessageLike | undefined): boolean;
/** Concatenate the text blocks of one message. */
export declare function messageText(message: MessageLike | undefined): string;
export interface BuildQueryOptions {
    /** Cap on the number of terms (DESIGN §6 keeps queries small). */
    maxTerms?: number;
    /** Cap on characters taken from the head of the conversation text. */
    maxChars?: number;
}
/**
 * Build a recall query from the messages entering a step. Only the most recent
 * user-authored text is used: older messages are already covered by earlier
 * recall passes in the same session.
 */
/**
 * Source kinds that carry *mechanical* text rather than the user's own task
 * statement, so they must not steer recall.
 *
 * `user-question-reply` arrived with dsh 0.2.0-rc.2 (the answer to a question
 * tool): its payload is a structured outcome (`callId` + `outcome`), and the
 * text it may carry is a choice token — searching memory for it would let a bare
 * "B" dilute the query that the actual task produced.
 */
export declare const NON_TASK_SOURCES: readonly string[];
/** True when a message represents what the user is asking for (not plugin or tool plumbing). */
export declare function isTaskBearing(message: MessageLike | undefined): boolean;
export declare function buildQuery(messages: readonly MessageLike[], options?: BuildQueryOptions): RecallQuery;
//# sourceMappingURL=query.d.ts.map