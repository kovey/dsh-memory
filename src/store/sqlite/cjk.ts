/**
 * CJK support for FTS5 (DESIGN §5.2).
 *
 * `unicode61` does not segment Chinese/Japanese/Korean text: a run such as
 * 写入可能被沙箱拒绝 becomes a single token, so a query for 沙箱 can never match
 * it. The store therefore keeps a `cjk` column holding the space-joined bigrams
 * of every CJK run, and queries are translated into bigram conjunctions. This
 * is the standard segmentation-free approach and needs no ICU build.
 */

const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g

/** True when the text contains at least one CJK character. */
export function hasCjk(text: string): boolean {
    return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(text)
}

/** Every CJK run in `text`, in order. */
export function cjkRuns(text: string): string[] {
    return text.match(CJK_RUN) ?? []
}

/**
 * Bigram decomposition of the CJK runs in `text`, space-joined and deduplicated.
 * Single-character runs are kept whole so one-character titles stay searchable.
 */
export function cjkBigrams(text: string): string {
    const tokens: string[] = []
    const seen = new Set<string>()
    for (const run of cjkRuns(text)) {
        const chars = [...run]
        if (chars.length === 1) {
            const single = chars[0]
            if (single !== undefined && !seen.has(single)) {
                seen.add(single)
                tokens.push(single)
            }
            continue
        }
        for (let i = 0; i + 1 < chars.length; i += 1) {
            const token = `${chars[i] ?? ''}${chars[i + 1] ?? ''}`
            if (token.length !== 2 || seen.has(token)) continue
            seen.add(token)
            tokens.push(token)
        }
    }
    return tokens.join(' ')
}

/** Bigrams of one query term (order preserved, duplicates kept). */
export function queryBigrams(term: string): string[] {
    const chars = [...term]
    if (chars.length < 2) return []
    const out: string[] = []
    for (let i = 0; i + 1 < chars.length; i += 1) {
        out.push(`${chars[i] ?? ''}${chars[i + 1] ?? ''}`)
    }
    return out
}

/**
 * FTS5 clause for one CJK query term.
 *
 * Short terms (<= 4 characters) use a conjunction of their bigrams, which is
 * precise; longer runs are OR-ed so a whole sentence still retrieves something
 * instead of demanding every bigram.
 */
export function cjkClause(term: string, longRunLimit = 4): string | undefined {
    const chars = [...term]
    if (chars.length === 0) return undefined
    if (chars.length === 1) return `"${escapeTerm(term)}"`
    if (chars.length <= longRunLimit) {
        return `(${queryBigrams(term)
            .map((bigram) => `"${escapeTerm(bigram)}"`)
            .join(' ')})`
    }
    const parts: string[] = []
    for (let i = 0; i + 1 < chars.length; i += 2) {
        const chunk = `${chars[i] ?? ''}${chars[i + 1] ?? ''}`
        if (chunk.length === 2) parts.push(`"${escapeTerm(chunk)}"`)
    }
    if (parts.length === 0) return undefined
    return `(${parts.join(' OR ')})`
}

function escapeTerm(term: string): string {
    return term.replace(/["*]/g, '')
}
