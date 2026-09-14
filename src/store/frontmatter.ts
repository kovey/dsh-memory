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
    title: string
    confidence: number
    /** `YYYY-MM-DD` or `permanent`. */
    expires: string
    timesSeen: number
    updated: string
    tags?: string[]
    status?: string
    origin?: string
    timesRecalled?: number
    successAfterRecall?: number
    failAfterRecall?: number
    supersededBy?: string
    created?: string
    layer?: string
}

export interface ParsedLesson {
    frontmatter: LessonFrontmatter
    body: string
}

const LEGACY_ORDER = ['title', 'confidence', 'expires', 'times_seen', 'updated'] as const

/** Parse a lesson markdown document. Returns `undefined` when it has no frontmatter. */
export function parseLesson(text: string): ParsedLesson | undefined {
    const normalized = text.replace(/\r\n/g, '\n')
    if (!normalized.startsWith('---\n')) return undefined
    const end = normalized.indexOf('\n---', 4)
    if (end === -1) return undefined
    const header = normalized.slice(4, end)
    const bodyStart = normalized.indexOf('\n', end + 1)
    const body = bodyStart === -1 ? '' : normalized.slice(bodyStart + 1).replace(/^\n+/, '').replace(/\s+$/, '')

    const fields = new Map<string, string>()
    for (const rawLine of header.split('\n')) {
        const line = rawLine.trimEnd()
        if (line === '' || line.startsWith('#')) continue
        const colon = line.indexOf(':')
        if (colon <= 0) continue
        fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
    }

    const title = fields.get('title') ?? ''
    if (title === '') return undefined
    const frontmatter: LessonFrontmatter = {
        title,
        confidence: clampConfidence(Number(fields.get('confidence') ?? '0.7')),
        expires: fields.get('expires') ?? 'permanent',
        timesSeen: Math.max(1, Number(fields.get('times_seen') ?? '1') || 1),
        updated: fields.get('updated') ?? new Date().toISOString().slice(0, 10),
    }
    const tags = fields.get('tags')
    if (tags !== undefined && tags !== '') frontmatter.tags = splitTags(tags)
    const status = fields.get('status')
    if (status !== undefined && status !== '') frontmatter.status = status
    const origin = fields.get('origin')
    if (origin !== undefined && origin !== '') frontmatter.origin = origin
    for (const [key, target] of [
        ['times_recalled', 'timesRecalled'],
        ['success_after_recall', 'successAfterRecall'],
        ['fail_after_recall', 'failAfterRecall'],
    ] as const) {
        const raw = fields.get(key)
        if (raw !== undefined && raw !== '' && Number.isFinite(Number(raw))) frontmatter[target] = Number(raw)
    }
    const supersededBy = fields.get('superseded_by')
    if (supersededBy !== undefined && supersededBy !== '') frontmatter.supersededBy = supersededBy
    const created = fields.get('created')
    if (created !== undefined && created !== '') frontmatter.created = created
    const layer = fields.get('layer')
    if (layer !== undefined && layer !== '') frontmatter.layer = layer
    return { frontmatter, body }
}

export function renderLesson(frontmatter: LessonFrontmatter, body: string, extras: Record<string, string> = {}): string {
    const lines: string[] = ['---']
    const values: Record<string, string> = {
        title: frontmatter.title,
        confidence: formatConfidence(frontmatter.confidence),
        expires: frontmatter.expires,
        times_seen: String(frontmatter.timesSeen),
        updated: frontmatter.updated,
    }
    for (const key of LEGACY_ORDER) lines.push(`${key}: ${values[key] ?? ''}`)
    if (frontmatter.tags !== undefined && frontmatter.tags.length > 0) lines.push(`tags: ${frontmatter.tags.join(', ')}`)
    if (frontmatter.status !== undefined && frontmatter.status !== 'active') lines.push(`status: ${frontmatter.status}`)
    if (frontmatter.origin !== undefined && frontmatter.origin !== 'imported') lines.push(`origin: ${frontmatter.origin}`)
    if (frontmatter.timesRecalled !== undefined && frontmatter.timesRecalled > 0) {
        lines.push(`times_recalled: ${frontmatter.timesRecalled}`)
    }
    if (frontmatter.successAfterRecall !== undefined && frontmatter.successAfterRecall > 0) {
        lines.push(`success_after_recall: ${frontmatter.successAfterRecall}`)
    }
    if (frontmatter.failAfterRecall !== undefined && frontmatter.failAfterRecall > 0) {
        lines.push(`fail_after_recall: ${frontmatter.failAfterRecall}`)
    }
    if (frontmatter.supersededBy !== undefined && frontmatter.supersededBy !== '') {
        lines.push(`superseded_by: ${frontmatter.supersededBy}`)
    }
    if (frontmatter.created !== undefined && frontmatter.created !== '') lines.push(`created: ${frontmatter.created}`)
    if (frontmatter.layer !== undefined && frontmatter.layer !== '') lines.push(`layer: ${frontmatter.layer}`)
    for (const [key, value] of Object.entries(extras)) lines.push(`${key}: ${value}`)
    lines.push('---', '', body.trim(), '')
    return lines.join('\n')
}

function splitTags(raw: string): string[] {
    const trimmed = raw.trim()
    if (trimmed.startsWith('[')) {
        try {
            const parsed: unknown = JSON.parse(trimmed)
            if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string')
        } catch {
            // fall through to comma splitting
        }
    }
    return trimmed
        .split(',')
        .map((tag) => tag.trim().replace(/^["']|["']$/g, ''))
        .filter((tag) => tag !== '')
}

function clampConfidence(value: number): number {
    if (!Number.isFinite(value)) return 0.7
    return Math.min(1, Math.max(0, value))
}

/** Keep the script's habit of two significant decimals. */
function formatConfidence(value: number): string {
    return String(Math.round(clampConfidence(value) * 100) / 100)
}

/** `expires` frontmatter value → ISO date, or undefined for permanent. */
export function expiresToIso(expires: string): string | undefined {
    if (expires === '' || expires === 'permanent') return undefined
    return expires
}

/** ISO date → `expires` frontmatter value. */
export function isoToExpires(iso: string | undefined): string {
    return iso === undefined || iso === '' ? 'permanent' : iso
}
