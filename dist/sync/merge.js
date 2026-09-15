/**
 * Conflict resolution for the git-tracked text view (DESIGN §5.3, D6).
 *
 * Conflicts are possible only in text, and the text is shaped so they stay
 * small: one lesson per file, and `MEMORY.md` is *generated* — so an index
 * conflict is never merged, it is regenerated from the store.
 *
 * Lesson conflicts merge by rule, not by guessing: repetitions add up, the
 * stronger confidence wins, the later expiry wins, and the longer body is kept
 * (it is the one that carries the extra context).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseLesson, renderLesson } from '../store/frontmatter.js';
const MARKER = /^<{7} .*$/m;
/** True when a file contains unresolved rebase conflict markers. */
export function hasConflictMarkers(text) {
    return MARKER.test(text) && text.includes('=======') && /^>{7} /m.test(text);
}
/**
 * Parse *every* conflict hunk in a file.
 *
 * Git can leave several hunks in one file, and an earlier implementation only
 * understood the first: it reported a successful merge whose output still
 * contained markers and had silently dropped text — which then got `git add`ed
 * into the memory repository. Returns `[]` for malformed markers, which callers
 * must treat as "a human decides".
 */
export function parseConflictHunks(text) {
    const lines = text.split('\n');
    const hunks = [];
    let index = 0;
    while (index < lines.length) {
        if (!(lines[index] ?? '').startsWith('<<<<<<<')) {
            index += 1;
            continue;
        }
        const start = index;
        const ours = [];
        const theirs = [];
        let section = 'ours';
        let closed = false;
        index += 1;
        for (; index < lines.length; index += 1) {
            const line = lines[index] ?? '';
            if (line.startsWith('|||||||'))
                continue;
            if (line.startsWith('=======')) {
                section = 'theirs';
                continue;
            }
            if (line.startsWith('>>>>>>>')) {
                closed = true;
                break;
            }
            if (section === 'ours')
                ours.push(line);
            else
                theirs.push(line);
        }
        if (!closed)
            return [];
        hunks.push({ start, end: index, ours: ours.join('\n'), theirs: theirs.join('\n') });
    }
    return hunks;
}
/** Rebuild a complete file taking one side of every hunk. */
export function reconstructSide(text, side, hunks = parseConflictHunks(text)) {
    if (hunks.length === 0)
        return undefined;
    const lines = text.split('\n');
    const out = [];
    let cursor = 0;
    for (const hunk of hunks) {
        out.push(...lines.slice(cursor, hunk.start));
        out.push(...(side === 'ours' ? hunk.ours : hunk.theirs).split('\n'));
        cursor = hunk.end + 1;
    }
    out.push(...lines.slice(cursor));
    return out.join('\n');
}
/** Split one conflicted file into its two complete sides (first-hunk view kept for tests). */
export function splitConflict(text) {
    const ours = reconstructSide(text, 'ours');
    const theirs = reconstructSide(text, 'theirs');
    if (ours === undefined || theirs === undefined)
        return undefined;
    return { ours, theirs };
}
/** Decide how to resolve one conflicted path. Pure: reads the file, writes nothing. */
export function resolveConflict(absolutePath, deps = {}) {
    const name = path.basename(absolutePath);
    let text;
    try {
        text = fs.readFileSync(absolutePath, 'utf8');
    }
    catch (error) {
        return { path: absolutePath, strategy: 'manual', note: `unreadable: ${message(error)}` };
    }
    if (!hasConflictMarkers(text)) {
        return { path: absolutePath, strategy: 'manual', note: 'no conflict markers found' };
    }
    if (name === 'MEMORY.md') {
        if (deps.regenerateIndex === undefined) {
            return { path: absolutePath, strategy: 'manual', note: 'MEMORY.md is generated but no regenerator was provided' };
        }
        return {
            path: absolutePath,
            strategy: 'regenerate-index',
            content: deps.regenerateIndex(),
            note: 'MEMORY.md is derived from the store — regenerated instead of merged',
        };
    }
    const hunks = parseConflictHunks(text);
    if (hunks.length === 0)
        return { path: absolutePath, strategy: 'manual', note: 'conflict markers are malformed' };
    const sides = splitConflict(text);
    if (sides === undefined)
        return { path: absolutePath, strategy: 'manual', note: 'conflict markers are malformed' };
    const ours = parseLesson(sides.ours);
    const theirs = parseLesson(sides.theirs);
    if (ours === undefined || theirs === undefined) {
        // Not a lesson document (e.g. metrics.jsonl). Taking a side is only safe
        // when the file had a single hunk; with several, a human decides rather
        // than have us silently drop text.
        if (hunks.length > 1) {
            return {
                path: absolutePath,
                strategy: 'manual',
                note: `not a lesson document and ${hunks.length} conflict hunks — needs a human`,
            };
        }
        const oursLonger = sides.ours.length >= sides.theirs.length;
        return {
            path: absolutePath,
            strategy: oursLonger ? 'take-ours' : 'take-theirs',
            content: oursLonger ? sides.ours : sides.theirs,
            note: 'not a lesson document — kept the longer side, review if it matters',
        };
    }
    const merged = mergeFrontmatter(ours.frontmatter, theirs.frontmatter);
    const body = ours.body.length >= theirs.body.length ? ours.body : theirs.body;
    const content = renderLesson(merged, body);
    // Belt and braces: never hand back a "merged" file that still has markers.
    if (hasConflictMarkers(content)) {
        return { path: absolutePath, strategy: 'manual', note: 'merge output still contained conflict markers' };
    }
    return {
        path: absolutePath,
        strategy: 'merge-lesson',
        content,
        note: `merged ${hunks.length} hunk(s): times_seen ${merged.timesSeen}, confidence ${merged.confidence}, expires ${merged.expires}`,
    };
}
/** Rules for combining two sides of a lesson conflict. */
export function mergeFrontmatter(a, b) {
    const expires = laterExpiry(a.expires, b.expires);
    const tags = [...new Set([...(a.tags ?? []), ...(b.tags ?? [])])];
    return {
        title: a.title.length >= b.title.length ? a.title : b.title,
        confidence: Math.max(a.confidence, b.confidence),
        expires,
        timesSeen: a.timesSeen + b.timesSeen,
        updated: a.updated >= b.updated ? a.updated : b.updated,
        ...(tags.length > 0 ? { tags } : {}),
        timesRecalled: (a.timesRecalled ?? 0) + (b.timesRecalled ?? 0),
        successAfterRecall: (a.successAfterRecall ?? 0) + (b.successAfterRecall ?? 0),
        failAfterRecall: (a.failAfterRecall ?? 0) + (b.failAfterRecall ?? 0),
        created: earliest(a.created, b.created),
    };
}
/** `permanent` beats any date; otherwise the later date wins. */
/** Merge two `evidence: kind×count, …` summaries, keeping the higher count per kind. */
export function laterEvidence(ours, theirs) {
    if (ours === undefined || ours.trim() === '')
        return theirs;
    if (theirs === undefined || theirs.trim() === '')
        return ours;
    const parse = (text) => {
        const out = new Map();
        for (const part of text.split(',')) {
            const match = /^\s*([a-z-]+)\s*[×x*:]\s*(\d+)\s*$/i.exec(part);
            if (match === null)
                continue;
            const kind = (match[1] ?? '').toLowerCase();
            const count = Number(match[2]);
            if (kind !== '' && Number.isFinite(count))
                out.set(kind, Math.max(out.get(kind) ?? 0, count));
        }
        return out;
    };
    const merged = parse(ours);
    for (const [kind, count] of parse(theirs))
        merged.set(kind, Math.max(merged.get(kind) ?? 0, count));
    if (merged.size === 0)
        return ours;
    return [...merged.entries()].map(([kind, count]) => `${kind}×${count}`).join(', ');
}
export function laterExpiry(a, b) {
    if (a === 'permanent' || b === 'permanent')
        return 'permanent';
    return a >= b ? a : b;
}
function earliest(a, b) {
    if (a === undefined)
        return b;
    if (b === undefined)
        return a;
    return a <= b ? a : b;
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=merge.js.map