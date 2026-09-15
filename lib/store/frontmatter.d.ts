/**
 * Lesson frontmatter: the bridge between the SQLite store and the human-readable
 * text view that git tracks (DESIGN §5.3).
 *
 * The five original fields written by `~/.dsh/scripts/memory-lesson.sh`
 * (`title`, `confidence`, `expires`, `times_seen`, `updated`) are always
 * emitted first and unchanged, so the shell fallback keeps working. New fields
 * are appended only when they carry information.
 */
export interface LessonFrontmatter {
    title: string;
    confidence: number;
    /** `YYYY-MM-DD` or `permanent`. */
    expires: string;
    timesSeen: number;
    updated: string;
    tags?: string[];
    status?: string;
    origin?: string;
    timesRecalled?: number;
    successAfterRecall?: number;
    failAfterRecall?: number;
    /**
     * Compact evidence summary (`tool-failure×2, user-statement×1`), kept as the
     * raw text so a foreign spelling survives a parse → render round trip.
     *
     * Only kinds and counts live in the text view: evidence `detail` is raw tool
     * output and must never be committed to the memory repository (DESIGN §8
     * judges quality by the kinds/counts, which is all a rebuild can restore).
     */
    evidence?: string;
    supersededBy?: string;
    created?: string;
}
/** One `kind × count` pair of the evidence summary. */
export interface EvidenceCount {
    kind: string;
    count: number;
}
export interface ParsedLesson {
    frontmatter: LessonFrontmatter;
    body: string;
}
/** Parse a lesson markdown document. Returns `undefined` when it has no frontmatter. */
export declare function parseLesson(text: string): ParsedLesson | undefined;
/**
 * Group evidence rows into `kind → count`, most frequent first (ties by kind) so
 * the rendered field is deterministic and a re-export produces an empty diff.
 */
export declare function countEvidence(evidence: readonly {
    kind: string;
}[]): EvidenceCount[];
/** `tool-failure×2, user-statement×1`; empty when there is nothing to record. */
export declare function formatEvidenceSummary(counts: readonly EvidenceCount[]): string;
/**
 * Inverse of `formatEvidenceSummary`. Deliberately tolerant — the field may have
 * been written by hand or by a future version — and it never throws: an
 * unrecognized item is dropped rather than failing the whole lesson import.
 * Accepted shapes: `kind×2`, `kind x 2`, `kind: 2`, `kind*2`, `kind`.
 */
export declare function parseEvidenceSummary(raw: string): EvidenceCount[];
/**
 * Render one lesson document. `extras` carries caller-computed fields (for
 * example the evidence summary built from the store's `evidence` rows) that are
 * appended after the schema fields; a key already emitted above is skipped so a
 * field can never appear twice.
 */
export declare function renderLesson(frontmatter: LessonFrontmatter, body: string, extras?: Record<string, string>): string;
/** `expires` frontmatter value → ISO date, or undefined for permanent. */
export declare function expiresToIso(expires: string): string | undefined;
/** ISO date → `expires` frontmatter value. */
export declare function isoToExpires(iso: string | undefined): string;
//# sourceMappingURL=frontmatter.d.ts.map