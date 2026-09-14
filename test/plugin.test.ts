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
    systemPrompt: { section: (section: { name: string }) => () => void }
    effect: (execute: () => () => void) => void
    on: (event: string, listener: unknown) => () => void
}

function fakeContext(): {
    ctx: unknown
    tools: Map<string, unknown>
    effects: (() => void)[]
    sections: string[]
    listeners: string[]
} {
    const tools = new Map<string, unknown>()
    const effects: (() => void)[] = []
    const sections: string[] = []
    const listeners: string[] = []
    const ctx: FakeContext = {
        tools: {
            register(definition) {
                tools.set(definition.name, definition)
                return () => tools.delete(definition.name)
            },
        },
        systemPrompt: {
            section(section) {
                sections.push(section.name)
                return () => undefined
            },
        },
        effect(execute) {
            effects.push(execute())
        },
        on(event) {
            listeners.push(event)
            return () => undefined
        },
    }
    return { ctx, tools, effects, sections, listeners }
}

test('the plugin declares its name and required services', () => {
    assert.equal(name, 'dsh-memory')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
})

test('apply() registers the memory tools, hooks and prompt section, and unwinds on dispose', async () => {
    const { ctx, tools, effects, sections, listeners } = fakeContext()
    const logFile = path.join(tempDir('plugin-log'), 'memory-plugin.log')

    apply(ctx as never, { logFile })
    await new Promise((resolve) => setTimeout(resolve, 100))

    assert.deepEqual(
        [...tools.keys()].sort(),
        ['memory_get', 'memory_recall', 'memory_reindex', 'memory_save', 'memory_search', 'memory_stats'],
    )

    assert.deepEqual(sections, ['memory:protocol'])
    assert.deepEqual(
        [...listeners].sort(),
        ['agent/created', 'agent/pre-step', 'agent/request-error', 'agent/turn-stopping', 'session/disposed', 'tools/result'],
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
    assert.equal(tools.size, 6)
})
