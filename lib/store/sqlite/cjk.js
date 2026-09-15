/**
 * CJK support for FTS5 (DESIGN §5.2).
 *
 * `unicode61` does not segment Chinese/Japanese/Korean text: a run such as
 * 写入可能被沙箱拒绝 becomes a single token, so a query for 沙箱 can never match
 * it. The store therefore keeps a `cjk` column holding the space-joined bigrams
 * of every CJK run, and queries are translated into bigram conjunctions. This
 * is the standard segmentation-free approach and needs no ICU build.
 */
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;
/** True when the text contains at least one CJK character. */
export function hasCjk(text) {
    return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(text);
}
/** Every CJK run in `text`, in order. */
export function cjkRuns(text) {
    return text.match(CJK_RUN) ?? [];
}
/**
 * Bigram decomposition of the CJK runs in `text`, space-joined and deduplicated.
 * Single-character runs are kept whole so one-character titles stay searchable.
 */
export function cjkBigrams(text) {
    const tokens = [];
    const seen = new Set();
    for (const run of cjkRuns(text)) {
        const chars = [...run];
        if (chars.length === 1) {
            const single = chars[0];
            if (single !== undefined && !seen.has(single)) {
                seen.add(single);
                tokens.push(single);
            }
            continue;
        }
        for (let i = 0; i + 1 < chars.length; i += 1) {
            const token = `${chars[i] ?? ''}${chars[i + 1] ?? ''}`;
            if (token.length !== 2 || seen.has(token))
                continue;
            seen.add(token);
            tokens.push(token);
        }
    }
    return tokens.join(' ');
}
/** Bigrams of one query term (order preserved, duplicates kept). */
export function queryBigrams(term) {
    const chars = [...term];
    if (chars.length < 2)
        return [];
    const out = [];
    for (let i = 0; i + 1 < chars.length; i += 1) {
        out.push(`${chars[i] ?? ''}${chars[i + 1] ?? ''}`);
    }
    return out;
}
const TERM_PARTS = new RegExp(`(${CJK_RUN.source})|([0-9A-Za-z_+#@.\-]+)`, 'g');
/**
 * Split a query term into ASCII runs and CJK runs.
 *
 * Chinese technical writing glues the two together (`npm包`, `git仓库`, `v2版本`,
 * `api调用`), and the old clause took bigrams of the *whole* term — `np`, `pm`,
 * `m包` — none of which the index can ever contain, so every such query matched
 * nothing while a pure-CJK substring of the same document matched fine.
 */
export function splitTerm(term) {
    const ascii = [];
    const runs = [];
    TERM_PARTS.lastIndex = 0;
    let match;
    while ((match = TERM_PARTS.exec(term)) !== null) {
        const cjk = match[1];
        const word = match[2];
        if (cjk !== undefined && cjk !== '')
            runs.push(cjk);
        else if (word !== undefined && word !== '')
            ascii.push(word);
    }
    return { ascii, cjkRuns: runs };
}
/**
 * FTS5 clause for one query term, built from the parts that are actually
 * indexed: ASCII runs become prefix queries, CJK runs become bigram
 * conjunctions. Parts are AND-ed, so `npm包` asks for a token starting with
 * `npm` — which the index has — instead of an impossible `m包` bigram.
 *
 * A two-character run is exactly one bigram, so it is matched precisely. Longer
 * runs are OR-ed: Chinese has no word separators, so `仓库克隆` may well describe a
 * document that says `仓库 … 克隆`, and demanding the boundary bigram `库克`
 * retrieved nothing at all. Ranking still prefers documents that match more
 * bigrams (bm25 over the `cjk` column), which keeps precision acceptable.
 */
export function cjkClause(term, longRunLimit = 2) {
    const { ascii, cjkRuns: runs } = splitTerm(term);
    if (ascii.length === 0 && runs.length === 0)
        return undefined;
    const clauses = [];
    for (const word of ascii)
        clauses.push(`"${escapeTerm(word)}"*`);
    for (const run of runs) {
        const chars = [...run];
        if (chars.length === 1) {
            // A lone CJK character forms no bigram. Keep it only when it *is* the
            // term (a one-character title stays searchable); inside a glued term
            // like `npm包` it would make the clause unsatisfiable.
            if (ascii.length === 0 && runs.length === 1)
                clauses.push(`"${escapeTerm(run)}"`);
            continue;
        }
        if (chars.length <= longRunLimit) {
            clauses.push(`(${queryBigrams(run).map((bigram) => `"${escapeTerm(bigram)}"`).join(' ')})`);
            continue;
        }
        const parts = queryBigrams(run).map((bigram) => `"${escapeTerm(bigram)}"`);
        if (parts.length > 0)
            clauses.push(`(${parts.join(' OR ')})`);
    }
    if (clauses.length === 0)
        return undefined;
    if (clauses.length === 1)
        return clauses[0];
    return `(${clauses.join(' ')})`;
}
function escapeTerm(term) {
    return term.replace(/["*]/g, '');
}
//# sourceMappingURL=cjk.js.map