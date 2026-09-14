/**
 * Optional access to the LLM service.
 *
 * Cordis refuses a plain property read for a service that was not declared in
 * `inject` ("cannot get property "llm" without inject"), and the error only
 * shows up in a real composition — a fake context happily exposes `.llm`.
 *
 * `llm` is used for exactly one optional feature (bounded distillation), so the
 * plugin must not hard-require it: a composition without an LLM keeps working
 * and distillation degrades to "signals stay in L1".
 */
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

export interface LlmStreamLike {
    stream(options: unknown): AsyncIterable<StreamChunk>
}

/**
 * Resolve the LLM runtime through `ctx.reflect` (the sanctioned optional-service
 * lookup), falling back to a direct property read for test doubles.
 */
export function optionalLlm(ctx: Context): LlmStreamLike | undefined {
    try {
        const reflect = (ctx as unknown as { reflect?: { get?: (name: string, strict?: boolean) => unknown } }).reflect
        const service = reflect?.get?.('llm', false)
        if (isLlm(service)) return service
    } catch {
        // fall through to the direct read
    }
    try {
        const direct = (ctx as unknown as { llm?: unknown }).llm
        if (isLlm(direct)) return direct
    } catch {
        // cordis throws for a non-injected service; treat it as unavailable
    }
    return undefined
}

function isLlm(value: unknown): value is LlmStreamLike {
    return value !== null && typeof value === 'object' && typeof (value as LlmStreamLike).stream === 'function'
}
