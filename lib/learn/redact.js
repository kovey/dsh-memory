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
/** Mask secrets/home paths and truncate to `maxChars`. */
export function redact(text, policy = 'redacted', maxChars = 400) {
    if (policy === 'none')
        return '';
    const collapsed = text.replace(/\s+/g, ' ').trim();
    const masked = policy === 'full' ? collapsed : applyPatterns(collapsed);
    return masked.length > maxChars ? `${masked.slice(0, maxChars)}…` : masked;
}
function applyPatterns(text) {
    let out = text;
    for (const pattern of PATTERNS)
        out = out.replace(pattern.re, pattern.replacement);
    return out;
}
//# sourceMappingURL=redact.js.map