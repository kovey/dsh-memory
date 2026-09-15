/**
 * Redaction for anything the plugin persists (DESIGN §7, D5).
 *
 * Episode logs and distillation prompts are the only places where free-form
 * text leaves the session, so both go through here first. The default policy is
 * `redacted`: secrets and home paths are masked and long text is truncated.
 *
 * The rules are deliberately anchored: credentials that carry a recognizable
 * prefix (AWS `AKIA…`, `glpat-`, `npm_`, `AIza`) are matched by prefix + a
 * token-length body, while generic-looking material (`Basic`, a bare
 * `set-cookie`, an ordinary URL) is only masked inside the context that makes it
 * a secret. Over-masking a path or an English word costs the operator the
 * evidence the lesson needs, so a miss is preferred over a false positive.
 */
export type RedactPolicy = 'none' | 'redacted' | 'full';
/** Mask secrets/home paths and truncate to `maxChars`. */
export declare function redact(text: string, policy?: RedactPolicy, maxChars?: number): string;
//# sourceMappingURL=redact.d.ts.map