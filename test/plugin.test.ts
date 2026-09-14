/**
 * Plugin assembly smoke test: `apply()` must register the tool surface, extend
 * the `tools` service, and unwind every registration through `ctx.effect`
 * (DESIGN §9.2/§9.3). The host context is faked — no live session is needed.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { apply, inject, name } from '../lib/index.js'
import { tempDir } from './helpers.ts'

interface FakeContext {
    tools: { register: (definition: { name: string }) => () => void }
    effect: (execute: () => () => void) => void
}

function fakeContext(): { ctx: unknown; tools: Map<string, unknown>; effects: (() => void)[] } {
    const tools = new Map<string, unknown>()
    const effects: (() => void)[] = []
    const ctx: FakeContext = {
        tools: {
            register(definition) {
                tools.set(definition.name, definition)
                return () => tools.delete(definition.name)
            },
        },
        effect(execute) {
            effects.push(execute())
        },
    }
    return { ctx, tools, effects }
}

test('the plugin declares its name and required services', () => {
    assert.equal(name, 'dsh-memory')
    assert.deepEqual(inject, ['tools'])
})

test('apply() registers the read-only memory tools and unwinds on dispose', async () => {
    const { ctx, tools, effects } = fakeContext()
    const logFile = path.join(tempDir('plugin-log'), 'memory-plugin.log')

    apply(ctx as never, { logFile })
    await new Promise((resolve) => setTimeout(resolve, 100))

    assert.deepEqual(
        [...tools.keys()].sort(),
        ['memory_get', 'memory_reindex', 'memory_search', 'memory_stats'],
    )

    for (const dispose of effects) dispose()
    assert.equal(tools.size, 0)
    assert.equal(effects.length, 1)
    assert.ok(fs.existsSync(logFile), 'plugin must log to the configured file')
    const logText = fs.readFileSync(logFile, 'utf8')
    assert.match(logText, /dsh-memory applying/)
    assert.match(logText, /memory: ready|SQLite unavailable/)
})

test('apply() stays silent when disabled', async () => {
    const { ctx, tools, effects } = fakeContext()
    apply(ctx as never, { enabled: false, logFile: path.join(tempDir('plugin-disabled'), 'memory-plugin.log') })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(tools.size, 0)
    assert.equal(effects.length, 0)
})

test('a broken config cannot break session startup', () => {
    const { ctx, tools } = fakeContext()
    assert.doesNotThrow(() => apply(ctx as never, { recall: 'not-an-object', learn: 42 }))
    assert.equal(tools.size, 4)
})
