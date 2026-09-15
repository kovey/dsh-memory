/**
 * Lesson frontmatter: the bridge between the SQLite store and the human-readable
 * text view that git tracks (DESIGN §5.3).
 *
 * The five original fields written by `~/.dsh/scripts/memory-lesson.sh`
 * (`title`, `confidence`, `expires`, `times_seen`, `updated`) are always
 * emitted first and unchanged, so the shell fallback keeps working. New fields
 * are appended only when they carry information.
 */
/** Ceiling for a count read back from the text view (a hand-edited field). */
const MAX_EVIDENCE_COUNT = 9999;
const LEGACY_ORDER = ['title', 'confidence', 'expires', 'times_seen', 'updated'];
/** Parse a lesson markdown document. Returns `undefined` when it has no frontmatter. */
export function parseLesson(text) {
    const normalized = text.replace(/\r\n/g, '\n');
    if (!normalized.startsWith('---\n'))
        return undefined;
    const end = normalized.indexOf('\n---', 4);
    if (end === -1)
        return undefined;
    const header = normalized.slice(4, end);
    const bodyStart = normalized.indexOf('\n', end + 1);
    const body = bodyStart === -1 ? '' : normalized.slice(bodyStart + 1).replace(/^\n+/, '').replace(/\s+$/, '');
    const fields = new Map();
    for (const rawLine of header.split('\n')) {
        const line = rawLine.trimEnd();
        if (line === '' || line.startsWith('#'))
            continue;
        const colon = line.indexOf(':');
        if (colon <= 0)
            continue;
        fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    const title = fields.get('title') ?? '';
    if (title === '')
        return undefined;
    const frontmatter = {
        title,
        confidence: clampConfidence(Number(fields.get('confidence') ?? '0.7')),
        expires: fields.get('expires') ?? 'permanent',
        timesSeen: Math.max(1, Number(fields.get('times_seen') ?? '1') || 1),
        updated: fields.get('updated') ?? new Date().toISOString().slice(0, 10),
    };
    const tags = fields.get('tags');
    if (tags !== undefined && tags !== '')
        frontmatter.tags = splitTags(tags);
    const status = fields.get('status');
    if (status !== undefined && status !== '')
        frontmatter.status = status;
    const origin = fields.get('origin');
    if (origin !== undefined && origin !== '')
        frontmatter.origin = origin;
    for (const [key, target] of [
        ['times_recalled', 'timesRecalled'],
        ['success_after_recall', 'successAfterRecall'],
        ['fail_after_recall', 'failAfterRecall'],
    ]) {
        const raw = fields.get(key);
        if (raw !== undefined && raw !== '' && Number.isFinite(Number(raw)))
            frontmatter[target] = Number(raw);
    }
    const supersededBy = fields.get('superseded_by');
    if (supersededBy !== undefined && supersededBy !== '')
        frontmatter.supersededBy = supersededBy;
    const created = fields.get('created');
    if (created !== undefined && created !== '')
        frontmatter.created = created;
    const evidence = fields.get('evidence');
    if (evidence !== undefined && evidence !== '')
        frontmatter.evidence = evidence;
    return { frontmatter, body };
}
/**
 * Group evidence rows into `kind → count`, most frequent first (ties by kind) so
 * the rendered field is deterministic and a re-export produces an empty diff.
 */
export function countEvidence(evidence) {
    const counts = new Map();
    for (const item of evidence)
        counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    return sortCounts(counts);
}
/** `tool-failure×2, user-statement×1`; empty when there is nothing to record. */
export function formatEvidenceSummary(counts) {
    return counts.filter((entry) => entry.count > 0).map((entry) => `${entry.kind}×${entry.count}`).join(', ');
}
/**
 * Inverse of `formatEvidenceSummary`. Deliberately tolerant — the field may have
 * been written by hand or by a future version — and it never throws: an
 * unrecognized item is dropped rather than failing the whole lesson import.
 * Accepted shapes: `kind×2`, `kind x 2`, `kind: 2`, `kind*2`, `kind`.
 */
export function parseEvidenceSummary(raw) {
    const counts = new Map();
    for (const item of raw.split(/[,;]/)) {
        const match = /^\s*([A-Za-z][A-Za-z0-9_-]{0,31})\s*(?:[×x*:]\s*)?(\d+)?\s*$/.exec(item);
        const kind = match?.[1];
        if (kind === undefined)
            continue;
        // Clamped, not rejected: a hand-edited `×999999` must not turn into an
        // unbounded insert loop, and the kind is still worth keeping.
        const count = Math.min(MAX_EVIDENCE_COUNT, Math.max(1, Number(match?.[2] ?? '1') || 1));
        counts.set(kind, Math.min(MAX_EVIDENCE_COUNT, (counts.get(kind) ?? 0) + count));
    }
    return sortCounts(counts);
}
function sortCounts(counts) {
    return [...counts.entries()]
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}
/**
 * Render one lesson document. `extras` carries caller-computed fields (for
 * example the evidence summary built from the store's `evidence` rows) that are
 * appended after the schema fields; a key already emitted above is skipped so a
 * field can never appear twice.
 */
export function renderLesson(frontmatter, body, extras = {}) {
    const lines = ['---'];
    const values = {
        title: frontmatter.title,
        confidence: formatConfidence(frontmatter.confidence),
        expires: frontmatter.expires,
        times_seen: String(frontmatter.timesSeen),
        updated: frontmatter.updated,
    };
    const emitted = new Set(LEGACY_ORDER);
    for (const key of LEGACY_ORDER)
        lines.push(`${key}: ${values[key] ?? ''}`);
    const optional = [
        ['tags', frontmatter.tags !== undefined && frontmatter.tags.length > 0 ? frontmatter.tags.join(', ') : undefined],
        ['status', frontmatter.status !== undefined && frontmatter.status !== 'active' ? frontmatter.status : undefined],
        ['origin', frontmatter.origin !== undefined && frontmatter.origin !== 'imported' ? frontmatter.origin : undefined],
        ['times_recalled', frontmatter.timesRecalled !== undefined && frontmatter.timesRecalled > 0 ? String(frontmatter.timesRecalled) : undefined],
        ['success_after_recall', frontmatter.successAfterRecall !== undefined && frontmatter.successAfterRecall > 0 ? String(frontmatter.successAfterRecall) : undefined],
        ['fail_after_recall', frontmatter.failAfterRecall !== undefined && frontmatter.failAfterRecall > 0 ? String(frontmatter.failAfterRecall) : undefined],
        ['evidence', frontmatter.evidence !== undefined && frontmatter.evidence !== '' ? frontmatter.evidence : undefined],
        ['superseded_by', frontmatter.supersededBy !== undefined && frontmatter.supersededBy !== '' ? frontmatter.supersededBy : undefined],
        ['created', frontmatter.created !== undefined && frontmatter.created !== '' ? frontmatter.created : undefined],
    ];
    for (const [key, value] of optional) {
        if (value === undefined)
            continue;
        lines.push(`${key}: ${value}`);
        emitted.add(key);
    }
    for (const [key, value] of Object.entries(extras)) {
        if (emitted.has(key))
            continue;
        lines.push(`${key}: ${value}`);
        emitted.add(key);
    }
    lines.push('---', '', body.trim(), '');
    return lines.join('\n');
}
function splitTags(raw) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed))
                return parsed.filter((v) => typeof v === 'string');
        }
        catch {
            // fall through to comma splitting
        }
    }
    return trimmed
        .split(',')
        .map((tag) => tag.trim().replace(/^["']|["']$/g, ''))
        .filter((tag) => tag !== '');
}
function clampConfidence(value) {
    if (!Number.isFinite(value))
        return 0.7;
    return Math.min(1, Math.max(0, value));
}
/** Keep the script's habit of two significant decimals. */
function formatConfidence(value) {
    return String(Math.round(clampConfidence(value) * 100) / 100);
}
/** `expires` frontmatter value → ISO date, or undefined for permanent. */
export function expiresToIso(expires) {
    if (expires === '' || expires === 'permanent')
        return undefined;
    return expires;
}
/** ISO date → `expires` frontmatter value. */
export function isoToExpires(iso) {
    return iso === undefined || iso === '' ? 'permanent' : iso;
}
//# sourceMappingURL=frontmatter.js.map