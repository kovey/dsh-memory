/**
 * Query construction for automatic recall (DESIGN §6).
 *
 * The query is built from the messages entering the step, ignoring messages the
 * plugin itself injected: recalling from our own recall pack would make the
 * store self-reinforcing.
 */
import { extractTerms } from '../store/sqlite/records.js';
export const MEMORY_PLUGIN_ID = 'dsh-memory';
/**
 * Producer-owned source kind for messages this plugin injects.
 *
 * dsh 0.1.7 removed the shared catch-all `plugin` kind: `MessageSourceMap` is a
 * merge-extensible sum type and each producer declares its own kind, while the
 * session format v4 REJECTS `kind: 'plugin'` outright ("refuses retired plugin
 * wrappers"). The declaration lives in `src/message-source.ts`.
 */
export const MEMORY_SOURCE_KIND = MEMORY_PLUGIN_ID;
/** True when this message was injected by the memory plugin itself.
 *
 * Reads BOTH shapes on purpose: sessions written before the 0.1.7 migration
 * carry `{kind:'plugin', plugin:'dsh-memory'}`, newer ones `{kind:'dsh-memory'}`.
 * Missing the legacy shape would let an old recall pack be re-ingested as query
 * text (self-reinforcing store). */
export function isMemoryMessage(message) {
    const src = message?.source;
    if (src === undefined || src === null)
        return false;
    if (src.kind === MEMORY_SOURCE_KIND)
        return true;
    return src.kind === 'plugin' && src.plugin === MEMORY_PLUGIN_ID;
}
/** Concatenate the text blocks of one message. */
export function messageText(message) {
    const content = message?.content;
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (block === null || typeof block !== 'object')
            continue;
        const record = block;
        if (record.type === 'text' && typeof record.text === 'string')
            parts.push(record.text);
    }
    return parts.join('\n');
}
/**
 * Build a recall query from the messages entering a step. Only the most recent
 * user-authored text is used: older messages are already covered by earlier
 * recall passes in the same session.
 */
export function buildQuery(messages, options = {}) {
    const maxTerms = options.maxTerms ?? 12;
    const maxChars = options.maxChars ?? 2_000;
    const texts = [];
    for (const message of messages) {
        if (isMemoryMessage(message))
            continue;
        const text = messageText(message).trim();
        if (text === '')
            continue;
        texts.push(text);
    }
    const text = texts.join('\n').slice(0, maxChars);
    return { text, terms: extractTerms(text, maxTerms), sources: texts.length };
}
//# sourceMappingURL=query.js.map