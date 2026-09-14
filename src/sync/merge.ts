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
import fs from 'node:fs'
import path from 'node:path'
import { parseLesson, renderLesson } from '../store/frontmatter.js'
import type { LessonFrontmatter } from '../store/frontmatter.js'

export type ConflictStrategy = 'merge-lesson' | 'regenerate-index' | 'take-ours' | 'take-theirs' | 'manual'

export interface ConflictResolution {
    path: string
    strategy: ConflictStrategy
    /** Replacement file content; absent when the caller must intervene. */
    content?: string
    note: string
}

const MARKER = /^<{7} .*$/m

/** True when a file contains unresolved rebase conflict markers. */
export function hasConflictMarkers(text: string): boolean {
    return MARKER.test(text) && text.includes('=======') && /^>{7} /m.test(text)
}

export interface ConflictSides {
    ours: string
    theirs: string
}

/** Split one conflicted file into its two sides. */
export function splitConflict(text: string): ConflictSides | undefined {
    const oursStart = text.indexOf('<<<<<<<')
    if (oursStart === -1) return undefined
    const divider = text.indexOf('\n=======', oursStart)
    if (divider === -1) return undefined
    const theirsStart = text.indexOf('\n>>>>>>>', divider)
    if (theirsStart === -1) return undefined
    const before = text.slice(0, oursStart)
    const after = text.indexOf('\n', theirsStart + 1)
    const tail = after === -1 ? '' : text.slice(after + 1)
    return {
        ours: `${before}${text.slice(text.indexOf('\n', oursStart) + 1, divider)}\n${tail}`,
        theirs: `${before}${text.slice(divider + '\n=======\n'.length, theirsStart)}\n${tail}`,
    }
}

export interface MergeDeps {
    /** Regenerate `MEMORY.md` (it is derived, so never merged by hand). */
    regenerateIndex?: () => string
}

/** Decide how to resolve one conflicted path. Pure: reads the file, writes nothing. */
export function resolveConflict(absolutePath: string, deps: MergeDeps = {}): ConflictResolution {
    const name = path.basename(absolutePath)
    let text: string
    try {
        text = fs.readFileSync(absolutePath, 'utf8')
    } catch (error) {
        return { path: absolutePath, strategy: 'manual', note: `unreadable: ${message(error)}` }
    }
    if (!hasConflictMarkers(text)) {
        return { path: absolutePath, strategy: 'manual', note: 'no conflict markers found' }
    }

    if (name === 'MEMORY.md') {
        if (deps.regenerateIndex === undefined) {
            return { path: absolutePath, strategy: 'manual', note: 'MEMORY.md is generated but no regenerator was provided' }
        }
        return {
            path: absolutePath,
            strategy: 'regenerate-index',
            content: deps.regenerateIndex(),
            note: 'MEMORY.md is derived from the store — regenerated instead of merged',
        }
    }

    const sides = splitConflict(text)
    if (sides === undefined) return { path: absolutePath, strategy: 'manual', note: 'conflict markers are malformed' }
    const ours = parseLesson(sides.ours)
    const theirs = parseLesson(sides.theirs)
    if (ours === undefined || theirs === undefined) {
        // Not a lesson document (e.g. metrics.jsonl): prefer the newer side, but
        // say so instead of pretending the merge was intelligent.
        const oursLonger = sides.ours.length >= sides.theirs.length
        return {
            path: absolutePath,
            strategy: oursLonger ? 'take-ours' : 'take-theirs',
            content: oursLonger ? sides.ours : sides.theirs,
            note: 'not a lesson document — kept the longer side, review if it matters',
        }
    }

    const merged = mergeFrontmatter(ours.frontmatter, theirs.frontmatter)
    const body = ours.body.length >= theirs.body.length ? ours.body : theirs.body
    return {
        path: absolutePath,
        strategy: 'merge-lesson',
        content: renderLesson(merged, body),
        note: `merged: times_seen ${merged.timesSeen}, confidence ${merged.confidence}, expires ${merged.expires}`,
    }
}

/** Rules for combining two sides of a lesson conflict. */
export function mergeFrontmatter(a: LessonFrontmatter, b: LessonFrontmatter): LessonFrontmatter {
    const expires = laterExpiry(a.expires, b.expires)
    const tags = [...new Set([...(a.tags ?? []), ...(b.tags ?? [])])]
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
    }
}

/** `permanent` beats any date; otherwise the later date wins. */
export function laterExpiry(a: string, b: string): string {
    if (a === 'permanent' || b === 'permanent') return 'permanent'
    return a >= b ? a : b
}

function earliest(a: string | undefined, b: string | undefined): string | undefined {
    if (a === undefined) return b
    if (b === undefined) return a
    return a <= b ? a : b
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
