/**
 * Resolve the LLM runtime through `ctx.reflect` (the sanctioned optional-service
 * lookup), falling back to a direct property read for test doubles.
 */
export function optionalLlm(ctx) {
    try {
        const reflect = ctx.reflect;
        const service = reflect?.get?.('llm', false);
        if (isLlm(service))
            return service;
    }
    catch {
        // fall through to the direct read
    }
    try {
        const direct = ctx.llm;
        if (isLlm(direct))
            return direct;
    }
    catch {
        // cordis throws for a non-injected service; treat it as unavailable
    }
    return undefined;
}
function isLlm(value) {
    return value !== null && typeof value === 'object' && typeof value.stream === 'function';
}
//# sourceMappingURL=llm-access.js.map