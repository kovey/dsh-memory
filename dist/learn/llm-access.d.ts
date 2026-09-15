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
import type { Context } from '@deepseek-ai/cordis';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
export interface LlmStreamLike {
    stream(options: unknown): AsyncIterable<StreamChunk>;
}
/**
 * Resolve the LLM runtime through `ctx.reflect` (the sanctioned optional-service
 * lookup), falling back to a direct property read for test doubles.
 */
export declare function optionalLlm(ctx: Context): LlmStreamLike | undefined;
//# sourceMappingURL=llm-access.d.ts.map