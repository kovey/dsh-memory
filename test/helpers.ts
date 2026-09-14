/**
 * Test helpers: every test works inside `.tmp-tests/` under the repository, so
 * no test ever reads or writes the real `~/.dsh/memory` store.
 *
 * Test files are TypeScript executed by Node's native type stripping
 * (`node --test test/*.test.ts`), so local imports carry an explicit `.ts`
 * extension while plugin code is imported from the compiled `lib/`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let counter = 0

/** A fresh scratch directory (sandbox-safe: inside the workspace). */
export function tempDir(label: string): string {
    counter += 1
    const dir = path.join(repoRoot, '.tmp-tests', `${label}-${process.pid}-${counter}`)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    return dir
}

export interface Fixture { root: string; lessonsDir: string }

/** Create a memory root with the given lesson documents. */
export function memoryFixture(label: string, lessons: Record<string, string>): Fixture {
    const root = tempDir(label)
    const lessonsDir = path.join(root, 'lessons')
    fs.mkdirSync(lessonsDir, { recursive: true })
    for (const [name, body] of Object.entries(lessons)) {
        fs.writeFileSync(path.join(lessonsDir, name), body)
    }
    return { root, lessonsDir }
}

/** Create a directory that looks like a repository root (a bare `.git` entry). */
export function fakeRepo(label: string): string {
    const dir = tempDir(label)
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
    return dir
}

export function lessonDoc(options: {
    title: string
    body: string
    confidence?: number
    expires?: string
    timesSeen?: number
    updated?: string
    extra?: Record<string, string>
}): string {
    const lines = [
        '---',
        `title: ${options.title}`,
        `confidence: ${options.confidence ?? 0.9}`,
        `expires: ${options.expires ?? 'permanent'}`,
        `times_seen: ${options.timesSeen ?? 1}`,
        `updated: ${options.updated ?? '2026-09-01'}`,
    ]
    for (const [key, value] of Object.entries(options.extra ?? {})) lines.push(`${key}: ${value}`)
    lines.push('---', '', options.body, '')
    return lines.join('\n')
}

/** Point the global memory root at a scratch directory for the whole process. */
export function useGlobalMemoryHome(dir: string): void {
    process.env['DSH_MEMORY_HOME'] = dir
}

export function tmpdirAvailable(): boolean {
    try {
        fs.accessSync(os.tmpdir(), fs.constants.W_OK)
        return true
    } catch {
        return false
    }
}
