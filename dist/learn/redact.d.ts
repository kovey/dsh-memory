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
 *
 * Two *shape* heuristics close the gap left by the enumerated prefixes — a
 * format nobody has written a rule for yet still lands in L1 episodes, in the
 * distillation prompt and in the git-tracked text view, and a commit makes it
 * unrecoverable:
 *
 *   1. a JWT (`eyJ…` header, >= 2 dots, >= 60 chars) is masked whole;
 *   2. a high-entropy run (>= 48 chars of `[A-Za-z0-9_+/=-]` carrying upper
 *      case, lower case and a digit) is masked whole.
 *
 * Both stay on the "rather miss than over-mask" side: a git SHA (7-40 hex
 * chars, and any pure hex digest) never matches, English text and lowercase
 * identifiers have no mixed case, ordinary camelCase identifiers carry no
 * digit, and anything shorter than the length floor is left alone. They are
 * only applied under the `redacted` policy: `full` is the operator's explicit
 * "store the text as-is" switch and `none` still discards the text entirely.
 */
export type RedactPolicy = 'none' | 'redacted' | 'full';
/** Mask secrets/home paths and truncate to `maxChars`. */
export declare function redact(text: string, policy?: RedactPolicy, maxChars?: number): string;
//# sourceMappingURL=redact.d.ts.map