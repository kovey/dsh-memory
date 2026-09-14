/**
 * L5 — identity and preference memory (DESIGN §3, §6).
 *
 * The layer is plain markdown under `<memory root>/profile/`: permanent, written
 * by a human (or by an explicit, user-confirmed save) and rendered into the
 * resident prompt section, so a preference stays in effect without being
 * recalled. It was declared in the config, the layer enum and the store types
 * from the start, but nothing ever read or wrote it.
 *
 * The reading side is deliberately tiny and total: a missing directory is a
 * normal state, every file is size-capped, and one unreadable file never breaks
 * prompt assembly.
 */
import fs from 'node:fs'
import path from 'node:path'
import { log } from '../log.js'
import { assertInsideScope } from '../store/guard.js'
import { writeAtomic } from '../store/export.js'
import type { MemoryScope } from '../store/types.js'

/** Files that make up the layer, in render order. */
export const PROFILE_FILES = ['preferences.md', 'conventions.md'] as const
export type ProfileFile = (typeof PROFILE_FILES)[number]

/** Per-file cap: a preference is a line or two, not an essay. */
const MAX_FILE_BYTES = 4_000

export function profileDir(scope: MemoryScope): string {
    return path.join(scope.root, 'profile')
}

export function profileFilePath(scope: MemoryScope, name: ProfileFile | string): string | undefined {
    try {
        const file = path.join(profileDir(scope), name.endsWith('.md') ? name : `${name}.md`)
        assertInsideScope(scope, file)
        return file
    } catch (error) {
        log('warn', `memory: refusing to use a profile path outside the scope (${(error as Error).message})`)
        return undefined
    }
}

export interface ProfileEntry {
    name: string
    text: string
}

/** Read the layer's files, newest content first is not a thing here — order is fixed. */
export function readProfile(scope: MemoryScope): ProfileEntry[] {
    const entries: ProfileEntry[] = []
    const dir = profileDir(scope)
    let names: string[]
    try {
        names = fs.readdirSync(dir).filter((name) => name.endsWith('.md'))
    } catch {
        return entries
    }
    const ordered = [
        ...PROFILE_FILES.filter((name) => names.includes(name)),
        ...names.filter((name) => !(PROFILE_FILES as readonly string[]).includes(name)).sort(),
    ]
    for (const name of ordered) {
        const file = profileFilePath(scope, name)
        if (file === undefined) continue
        try {
            const stat = fs.statSync(file)
            if (!stat.isFile() || stat.size === 0) continue
            if (stat.size > MAX_FILE_BYTES) {
                log('debug', `memory: profile file ${name} is larger than ${MAX_FILE_BYTES} bytes — truncated`)
            }
            const text = fs.readFileSync(file, 'utf8').slice(0, MAX_FILE_BYTES).trim()
            if (text !== '') entries.push({ name, text })
        } catch (error) {
            log('debug', `memory: skipping unreadable profile file ${name}:`, error)
        }
    }
    return entries
}

/**
 * Render the layer for the resident section: a short heading, then each file's
 * lines until the budget is spent. Bounded like every other prompt surface.
 */
export function renderProfile(entries: readonly ProfileEntry[], budgetTokens = 200): string {
    if (entries.length === 0) return ''
    const header = '偏好（L5，长期有效）：'
    const lines: string[] = [header]
    let used = 0
    for (const entry of entries) {
        for (const raw of entry.text.split('\n')) {
            const line = raw.trim()
            if (line === '' || line.startsWith('---') || line.startsWith('#')) continue
            // rough token estimate: CJK ≈ 1 token/char, ASCII ≈ 1/4
            const cost = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(line)
                ? line.length
                : Math.ceil(line.length / 4)
            if (used + cost > budgetTokens) return lines.join('\n')
            used += cost
            lines.push(line.startsWith('-') ? line : `- ${line}`)
        }
    }
    return lines.length > 1 ? lines.join('\n') : ''
}

/** Replace one profile file's content (used by a confirmed `memory_save`). */
export function writeProfile(scope: MemoryScope, name: string, text: string): string | undefined {
    const file = profileFilePath(scope, name)
    if (file === undefined) return undefined
    try {
        fs.mkdirSync(profileDir(scope), { recursive: true })
        writeAtomic(file, text.endsWith('\n') ? text : `${text}\n`)
        return file
    } catch (error) {
        log('warn', `memory: writing profile ${name} failed:`, error)
        return undefined
    }
}

/** Append one preference line to `preferences.md`, keeping it a list. */
export function appendPreference(scope: MemoryScope, line: string, now = new Date()): string | undefined {
    const file = profileFilePath(scope, 'preferences.md')
    if (file === undefined) return undefined
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# 偏好\n'
    const trimmed = line.trim().replace(/^-\s*/, '')
    if (existing.includes(trimmed)) return file
    const body = `${existing.trimEnd()}\n- ${trimmed}  <!-- ${now.toISOString().slice(0, 10)} -->\n`
    return writeProfile(scope, 'preferences.md', body)
}
