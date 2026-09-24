/**
 * Producer-owned message source kind for this plugin (dsh 0.1.7+).
 *
 * `MessageSourceMap` is a merge-extensible sum type: dsh 0.1.7 removed the
 * shared catch-all `plugin` kind and requires every producer to declare its own
 * in its own module (the pattern `@deepseek-ai/dsh-tools` uses for
 * `tool-registry`). Session format **v4 refuses `kind: 'plugin'` outright**
 * ("refuses retired plugin wrappers"), so the old shape cannot be persisted on
 * 0.1.7 at all.
 *
 * Intersecting `ContextFormed` keeps `form: 'notice'` + `summary` available —
 * the consuming UI collapses that combination to a one-line notice row instead
 * of rendering the whole recall pack.
 *
 * @module dsh-memory/message-source
 */
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'dsh-memory': {
            kind: 'dsh-memory';
        } & ContextFormed;
    }
}
//# sourceMappingURL=message-source.d.ts.map