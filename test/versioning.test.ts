/**
 * The "is this memory actually versioned?" diagnostic.
 *
 * DESIGN §5.3 promises a clone can rebuild the store from the tracked text view.
 * Repositories that ignore `.dsh/` break that promise silently — memory becomes
 * machine-local, archives unrecoverable, and nothing ever says so.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { isGitIgnored, probeVersioning, resetVersioningProbe } from '../dist/store/versioning.js'
import { tempDir } from './helpers.ts'

function initRepo(label: string, ignore: string | undefined): string {
    const dir = tempDir(label)
    const git = (...args: string[]): void => {
        execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
    }
    git('init', '--quiet', '-b', 'main')
    if (ignore !== undefined) fs.writeFileSync(path.join(dir, '.gitignore'), ignore)
    fs.mkdirSync(path.join(dir, '.dsh', 'memory', 'lessons'), { recursive: true })
    return dir
}

test('a repo that ignores .dsh is reported as unversioned', (t) => {
    let repo: string
    try {
        repo = initRepo('versioning-ignored', '.dsh/\n')
    } catch {
        t.skip('git unavailable')
        return
    }
    resetVersioningProbe()
    const root = path.join(repo, '.dsh', 'memory')
    assert.equal(isGitIgnored(repo, root), true)
    assert.equal(probeVersioning({ kind: 'project', repo, root, reason: 'session-cwd' }), 'ignored')

    const plain = initRepo('versioning-tracked', 'node_modules/\n')
    assert.equal(isGitIgnored(plain, path.join(plain, '.dsh', 'memory')), false)
    assert.equal(
        probeVersioning({ kind: 'project', repo: plain, root: path.join(plain, '.dsh', 'memory'), reason: 'session-cwd' }),
        'versioned',
    )
    // a global root has no repository to be ignored by
    assert.equal(probeVersioning({ kind: 'global', root: '/tmp/whatever', reason: 'no-project-context' }), 'versioned')
})
