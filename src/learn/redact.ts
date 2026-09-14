/**
 * Redaction for anything the plugin persists (DESIGN §7, D5).
 *
 * Episode logs and distillation prompts are the only places where free-form
 * text leaves the session, so both go through here first. The default policy is
 * `redacted`: secrets and home paths are masked and long text is truncated.
 */

const PATTERNS: { re: RegExp; replacement: string }[] = [
    // API keys / tokens
    { re: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replacement: 'sk-***' },
    { re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, replacement: 'gh*_***' },
    { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replacement: 'xox*-***' },
    { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: 'jwt.***' },
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '-----BEGIN PRIVATE KEY-----***' },
    // `Authorization: Bearer <token>` and `token=…` / `password: …` assignments
    { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: 'Bearer ***' },
    { re: /\b(token|apikey|api_key|secret|password|passwd|access_key)\s*[:=]\s*\S{6,}/gi, replacement: '$1: ***' },
    // home paths leak user names into shared memory
    { re: /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+/g, replacement: '~' },
]

export type RedactPolicy = 'none' | 'redacted' | 'full'

/** Mask secrets/home paths and truncate to `maxChars`. */
export function redact(text: string, policy: RedactPolicy = 'redacted', maxChars = 400): string {
    if (policy === 'none') return ''
    const collapsed = text.replace(/\s+/g, ' ').trim()
    const masked = policy === 'full' ? collapsed : applyPatterns(collapsed)
    return masked.length > maxChars ? `${masked.slice(0, maxChars)}…` : masked
}

function applyPatterns(text: string): string {
    let out = text
    for (const pattern of PATTERNS) out = out.replace(pattern.re, pattern.replacement)
    return out
}
