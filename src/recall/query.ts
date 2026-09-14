/**
 * Query construction for automatic recall (DESIGN §6).
 *
 * The query is built from the messages entering the step, ignoring messages the
 * plugin itself injected: recalling from our own recall pack would make the
 * store self-reinforcing.
 */
import { extractTerms } from '../store/sqlite/records.js'

export const MEMORY_PLUGIN_ID = 'dsh-memory'

/** Structural view of an LLM message — enough to read text and provenance. */
export interface MessageLike {
    content?: unknown
    source?: { kind?: string; plugin?: string; form?: string; summary?: string }
}

export interface RecallQuery {
    /** Raw text the query was derived from. */
    text: string
    /** Search terms (CJK runs stay whole; ASCII words lowercase). */
    terms: string[]
    /** How many messages contributed text. */
    sources: number
}

/** True when this message was injected by the memory plugin itself. */
export function isMemoryMessage(message: MessageLike | undefined): boolean {
    return message?.source?.plugin === MEMORY_PLUGIN_ID
}

/** Concatenate the text blocks of one message. */
export function messageText(message: MessageLike | undefined): string {
    const content = message?.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    const parts: string[] = []
    for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        const record = block as { type?: unknown; text?: unknown }
        if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    }
    return parts.join('\n')
}

export interface BuildQueryOptions {
    /** Cap on the number of terms (DESIGN §6 keeps queries small). */
    maxTerms?: number
    /** Cap on characters taken from the head of the conversation text. */
    maxChars?: number
}

/**
 * Build a recall query from the messages entering a step. Only the most recent
 * user-authored text is used: older messages are already covered by earlier
 * recall passes in the same session.
 */
export function buildQuery(messages: readonly MessageLike[], options: BuildQueryOptions = {}): RecallQuery {
    const maxTerms = options.maxTerms ?? 12
    const maxChars = options.maxChars ?? 2_000
    const texts: string[] = []
    for (const message of messages) {
        if (isMemoryMessage(message)) continue
        const text = messageText(message).trim()
        if (text === '') continue
        texts.push(text)
    }
    const text = texts.join('\n').slice(0, maxChars)
    return { text, terms: extractTerms(text, maxTerms), sources: texts.length }
}
