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
const PATTERNS = [
    // --- credentials with a provider-specific prefix -------------------------
    // AWS access key id (`AKIA…` long-lived, `ASIA…` temporary). The prefix is
    // what makes the id recognizable, so it stays readable.
    { re: /\b(AKIA|ASIA)[A-Z0-9]{12,}\b/gi, replacement: '$1***' },
    { re: /\bglpat-[A-Za-z0-9_-]{10,}\b/g, replacement: 'glpat-***' },
    // npm publish/automation token. `_` is outside the body charset on purpose:
    // it would otherwise swallow ordinary snake_case names such as
    // `npm_lifecycle_event`.
    { re: /\bnpm_[A-Za-z0-9]{10,}\b/g, replacement: 'npm_***' },
    { re: /\bAIza[A-Za-z0-9_-]{12,}\b/g, replacement: 'AIza***' },
    // --- API keys / tokens (generic shapes) ----------------------------------
    { re: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replacement: 'sk-***' },
    { re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, replacement: 'gh*_***' },
    { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replacement: 'xox*-***' },
    { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: 'jwt.***' },
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '-----BEGIN PRIVATE KEY-----***' },
    // `Authorization: Bearer <token>` and `token=…` / `password: …` assignments
    { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: 'Bearer ***' },
    { re: /\b(token|apikey|api_key|secret|password|passwd|access_key)\s*[:=]\s*\S{6,}/gi, replacement: '$1: ***' },
    // --- request headers that carry credentials ------------------------------
    // `x-api-key: …` (any case). The generic rule above cannot see it because
    // the header name ends in `key`, not `apikey`.
    { re: /\b(x-api-key)\s*[:=]\s*\S+/gi, replacement: '$1: ***' },
    // `Authorization: Basic <base64>`. `Basic` on its own is an ordinary English
    // word (and a file name), so only the authenticated-header context matches.
    { re: /\b(Authorization\s*:\s*Basic)\s+[A-Za-z0-9+/=._-]{4,}/gi, replacement: 'Authorization: Basic ***' },
    // `set-cookie: name=value; Path=/; …` — masks every `;`-separated pair, not
    // just the first one, but stops at the next whitespace-separated token so a
    // collapsed header dump keeps its other fields.
    { re: /\b(set-cookie)["']?\s*:\s*[^\s;]+(?:\s*;\s*[^\s;]+){0,8}/gi, replacement: '$1: ***' },
    // --- connection strings with an inline password --------------------------
    { re: /\b(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|mssql):\/\/([^:@/\s]*):([^@/\s]+)@/gi, replacement: '$1://$2:***@' },
    // home paths leak user names into shared memory
    { re: /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+/g, replacement: '~' },
];
/**
 * Heuristic 1 — JWT shape: `eyJ…` header plus at least one more dot-separated
 * base64url segment. The dots are only allowed *between* segments, so a
 * sentence-final period is not swallowed into the candidate.
 */
const JWT_CANDIDATE = /\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/g;
/** Shortest real JWT (`header.payload.signature`) the heuristic accepts. */
const JWT_MIN_CHARS = 60;
/** header.payload.signature → two separators. */
const JWT_MIN_DOTS = 2;
/**
 * Heuristic 2 — a continuous run that could be an opaque token. Same charset a
 * base64/base64url/hex secret uses; `.` is absent on purpose so a JWT is handled
 * by heuristic 1 and a dotted path is never one run.
 */
const TOKEN_RUN = /[A-Za-z0-9_+/=-]{48,}/g;
const TOKEN_MIN_CHARS = 48;
/** A hex digest is a git SHA / checksum, not a credential. */
const HEX_ONLY = /^[0-9a-fA-F]+$/;
/**
 * A word boundary inside a camelCase / PascalCase identifier.
 *
 * Two or more of these mean the run is built from words — a long API name such
 * as `parseISO8601DurationIntoMillisecondsWithTimezone` has five — while an
 * opaque token essentially never has that shape. The trade is deliberate: the
 * enumerated prefix rules (`sk-`, `glpat-`, …) still catch real credentials, and
 * the cost of masking an identifier is losing the evidence a lesson needs.
 *
 * A boundary count alone would also exempt an alternating-case secret
 * (`AbCdEf12…` is full of lower→upper steps), so one word-like lowercase run is
 * required as well: every name built from real words has one, the alternating
 * shape does not, and the existing regression test for it stays meaningful.
 */
const CAMEL_BOUNDARY = /[a-z][A-Z]/g;
const WORD_BOUNDARIES_REQUIRED = 2;
/** A run of lowercase letters long enough to be a word rather than alternation. */
const WORD_RUN = /[a-z]{3,}/;
/** Mask secrets/home paths and truncate to `maxChars`. */
export function redact(text, policy = 'redacted', maxChars = 400) {
    if (policy === 'none')
        return '';
    const collapsed = text.replace(/\s+/g, ' ').trim();
    const masked = policy === 'full' ? collapsed : applyPatterns(collapsed);
    return masked.length > maxChars ? `${masked.slice(0, maxChars)}…` : masked;
}
function applyPatterns(text) {
    // Shape heuristics bracket the enumerated rules: a JWT is recognized before
    // the narrow `eyJ…` prefix rule (so it gets the whole-token mask instead of
    // that rule's partial one), and the entropy sweep runs last so an
    // already-identified prefix (`Bearer …`, `sk-…`) keeps its informative label.
    let out = maskJwts(text);
    for (const pattern of PATTERNS)
        out = out.replace(pattern.re, pattern.replacement);
    return maskHighEntropy(out);
}
/** `eyJ…` triples that are long enough to be a real token are masked whole. */
function maskJwts(text) {
    return text.replace(JWT_CANDIDATE, (candidate) => {
        const dots = candidate.split('.').length - 1;
        return candidate.length >= JWT_MIN_CHARS && dots >= JWT_MIN_DOTS ? '[redacted:jwt]' : candidate;
    });
}
/**
 * Long runs that *look* like a secret: mixed case (a hex digest and an English
 * sentence do not have it), at least one digit, not pure hex, and not a word.
 *
 * The last condition is the identifier exemption: "at least one digit" was meant
 * to keep ordinary camelCase names out, but a *long* identifier usually carries a
 * version or a size (`…8601…`, `…2048…`) and was masked wholesale.
 */
function maskHighEntropy(text) {
    return text.replace(TOKEN_RUN, (run) => (looksHighEntropy(run) ? '[redacted:high-entropy]' : run));
}
function looksHighEntropy(run) {
    if (run.length < TOKEN_MIN_CHARS)
        return false;
    if (!/[a-z]/.test(run) || !/[A-Z]/.test(run) || !/[0-9]/.test(run))
        return false;
    if (HEX_ONLY.test(run))
        return false;
    // A name is a sequence of words; a token is alternation. Without the second
    // half of that test, `AbCdEf12GhIj…` would be "an identifier" too.
    const boundaries = (run.match(CAMEL_BOUNDARY) ?? []).length;
    return !(boundaries >= WORD_BOUNDARIES_REQUIRED && WORD_RUN.test(run));
}
//# sourceMappingURL=redact.js.map