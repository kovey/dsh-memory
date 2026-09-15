/**
 * CJK support for FTS5 (DESIGN §5.2).
 *
 * `unicode61` does not segment Chinese/Japanese/Korean text: a run such as
 * 写入可能被沙箱拒绝 becomes a single token, so a query for 沙箱 can never match
 * it. The store therefore keeps a `cjk` column holding the space-joined bigrams
 * of every CJK run, and queries are translated into bigram conjunctions. This
 * is the standard segmentation-free approach and needs no ICU build.
 */
/** True when the text contains at least one CJK character. */
export declare function hasCjk(text: string): boolean;
/** Every CJK run in `text`, in order. */
export declare function cjkRuns(text: string): string[];
/**
 * Bigram decomposition of the CJK runs in `text`, space-joined and deduplicated.
 * Single-character runs are kept whole so one-character titles stay searchable.
 */
export declare function cjkBigrams(text: string): string;
/** Bigrams of one query term (order preserved, duplicates kept). */
export declare function queryBigrams(term: string): string[];
/** A query term split into the parts the index actually holds. */
export interface TermParts {
    /** ASCII/word runs — indexed as ordinary tokens by `unicode61`. */
    ascii: string[];
    /** CJK runs — indexed as bigrams in the `cjk` column. */
    cjkRuns: string[];
}
/**
 * Split a query term into ASCII runs and CJK runs.
 *
 * Chinese technical writing glues the two together (`npm包`, `git仓库`, `v2版本`,
 * `api调用`), and the old clause took bigrams of the *whole* term — `np`, `pm`,
 * `m包` — none of which the index can ever contain, so every such query matched
 * nothing while a pure-CJK substring of the same document matched fine.
 */
export declare function splitTerm(term: string): TermParts;
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
export declare function cjkClause(term: string, longRunLimit?: number): string | undefined;
//# sourceMappingURL=cjk.d.ts.map