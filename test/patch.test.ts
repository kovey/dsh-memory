/**
 * The plugin's own `cordis.patch.yml` is part of the shipped artifact and is
 * parsed by the host loader, not by any test — which is exactly how a bad
 * indentation survived until a real `dsh plugin add` install refused to boot:
 *
 *   dsh: failed to parse overlay …/cordis.patch.yml: YAMLException:
 *        bad indentation of a mapping entry (38:21)
 *
 * These tests parse the file for real and cross-check it against the resolved
 * defaults, so a syntax error or a typo'd config key fails here instead of at
 * install time.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { load as loadYaml } from 'js-yaml'
import { resolveConfig } from '../dist/config.js'
import pkg from '../package.json' with { type: 'json' }

const PATCH = path.join(import.meta.dirname, '..', 'cordis.patch.yml')

interface PatchEntry {
    insert?: { id?: string; name?: string; config?: Record<string, unknown> }[]
    config?: { id?: string; config?: Record<string, unknown> }[]
}

function loadPatch(): PatchEntry[] {
    const parsed = loadYaml(fs.readFileSync(PATCH, 'utf8'))
    assert.ok(Array.isArray(parsed), 'the patch must be a top-level list')
    return parsed as PatchEntry[]
}

test('the shipped patch file parses as YAML with the expected shape', () => {
    const entries = loadPatch()
    // A key that falls out of the `insert:` item (a stray indentation level) is
    // silently ignored by the loader — exactly how `semantic:` and
    // `consolidate.usageRetentionDays` once stopped being shipped defaults.
    for (const entry of entries) {
        const stray = Object.keys(entry).filter((key) => key !== 'insert' && key !== 'config')
        assert.deepEqual(stray, [], `patch entry has keys outside insert/config: ${stray.join(', ')}`)
    }
    const insert = entries.flatMap((entry) => entry.insert ?? [])
    const memory = insert.find((row) => row.id === 'memory')
    assert.ok(memory, 'the patch must insert the `memory` entry')
    assert.equal(memory.name, pkg.name, 'the entry names this package')
    assert.ok(memory.config !== undefined, 'the entry ships its defaults')

    // no duplicate ids across insert and config blocks (the loader rejects them)
    const ids = [...insert.map((row) => row.id), ...entries.flatMap((entry) => (entry.config ?? []).map((row) => row.id))]
    assert.equal(new Set(ids).size, ids.length, `duplicate loader ids in the patch: ${ids.join(', ')}`)

    // the package must mount itself, or a profile that adds it loads nothing
    assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
})

test('every configured key exists in the resolved config (no typos shipped)', () => {
    const memory = loadPatch().flatMap((entry) => entry.insert ?? []).find((row) => row.id === 'memory')
    const config = (memory?.config ?? {}) as Record<string, unknown>
    const defaults = resolveConfig({}) as unknown as Record<string, unknown>

    const walk = (shipped: unknown, known: unknown, trail: string): void => {
        assert.ok(known !== undefined, `the patch sets \`${trail}\`, which the config does not define`)
        if (shipped === null || typeof shipped !== 'object' || Array.isArray(shipped)) return
        const target = known as Record<string, unknown>
        for (const [key, value] of Object.entries(shipped as Record<string, unknown>)) {
            assert.ok(
                Object.hasOwn(target, key),
                `the patch sets \`${trail}${key}\`, which the config does not define (typo?)`,
            )
            walk(value, target[key], `${trail}${key}.`)
        }
    }
    walk(config, defaults, '')

    // and the shipped defaults must survive resolution unchanged
    const resolved = resolveConfig({})
    assert.equal(config['prompt'] !== undefined ? resolved.prompt.protocol.budgetTokens : undefined, 240)
    assert.equal(resolved.prompt.indexSummary.profileBudgetTokens, 200, 'L5 budget is shipped')
    assert.equal(resolved.recall.sessionToolBudgetTokens, 20_000, 'session tool budget is shipped')
    assert.equal(resolved.consolidate.usageRetentionDays, 180, 'usage retention is shipped')
    assert.equal(resolved.semantic.foreignModelGraceDays, 30, 'foreign-model grace is shipped')
    assert.equal(resolved.sqlite.maxOpenRoots, 4, 'store LRU bound is shipped')
})
