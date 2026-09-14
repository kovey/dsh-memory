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
import { fakeRepo, tempDir } from './helpers.ts'

interface FakeToolDefinition {
    name: string
    execute: (args: unknown, exec: unknown) => Promise<unknown>
}

interface FakeSection {
    name: string
    text?: () => string
}

interface FakeContext {
    tools: { register: (definition: FakeToolDefinition) => () => void }
    systemPrompt: { section: (section: FakeSection) => () => void }
    effect: (execute: () => () => void) => void
    on: (event: string, listener: unknown) => () => void
}

function fakeContext(options: { failFor?: readonly string[] } = {}): {
    ctx: unknown
    tools: Map<string, FakeToolDefinition>
    effects: (() => void)[]
    sections: string[]
    protocolText: () => string
    listeners: string[]
} {
    const tools = new Map<string, FakeToolDefinition>()
    const effects: (() => void)[] = []
    const sections: string[] = []
    const sectionDefs: FakeSection[] = []
    const listeners: string[] = []
    const ctx: FakeContext = {
        tools: {
            register(definition) {
                // A host may refuse a registration (name clash, broken schema…):
                // the plugin must survive it and stop advertising the tool.
                if (options.failFor?.includes(definition.name) === true) {
                    throw new Error(`host refused to register ${definition.name}`)
                }
                tools.set(definition.name, definition)
                return () => tools.delete(definition.name)
            },
        },
        systemPrompt: {
            section(section) {
                sectionDefs.push(section)
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
    return {
        ctx,
        tools,
        effects,
        sections,
        protocolText: () => sectionDefs.find((section) => section.name === 'memory:protocol')?.text?.() ?? '',
        listeners,
    }
}

test('the plugin declares its name and required services', () => {
    assert.equal(name, 'dsh-memory')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
})

test('apply() registers the memory tools, hooks and prompt section, and unwinds on dispose', async () => {
    const { ctx, tools, effects, sections, listeners, protocolText } = fakeContext()
    const logFile = path.join(tempDir('plugin-log'), 'memory-plugin.log')

    apply(ctx as never, { logFile })
    await new Promise((resolve) => setTimeout(resolve, 100))

    assert.deepEqual(
        [...tools.keys()].sort(),
        [
            'memory_config',
            'memory_consolidate',
            'memory_forget',
            'memory_get',
            'memory_import',
            'memory_recall',
            'memory_reindex',
            'memory_save',
            'memory_search',
            'memory_stats',
            'memory_sync',
        ],
    )

    assert.deepEqual(sections, ['memory:protocol'])
    assert.deepEqual([...new Set(listeners)].sort(), [
        'agent/created',
        'agent/pre-step',
        'agent/request-error',
        'agent/turn-stopping',
        'session/created',
        'session/disposed',
        'tools/result',
    ])

    // Every tool registered, so the protocol may advertise all of them.
    const protocol = protocolText()
    assert.match(protocol, /memory_search/)
    assert.match(protocol, /memory_get/)
    assert.match(protocol, /memory_save/)

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
    assert.equal(tools.size, 11)
})

test('capabilities come from the registration result, never from a constant', async () => {
    const logFile = path.join(tempDir('plugin-capability-log'), 'memory-plugin.log')
    const { ctx, tools, protocolText } = fakeContext({ failFor: ['memory_save', 'memory_get'] })

    apply(ctx as never, { logFile, memoryHome: tempDir('plugin-capability-home') })
    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.ok(!tools.has('memory_save'), 'the refused tool must not be registered')
    assert.ok(!tools.has('memory_get'))
    assert.equal(tools.size, 9, '11 tools minus the two the host refused')

    const protocol = protocolText()
    assert.match(protocol, /memory_search/, 'the tools that did register stay advertised')
    assert.doesNotMatch(protocol, /memory_save/, 'the protocol must not advertise a tool the host never got')
    assert.doesNotMatch(protocol, /memory_get/)

    const logText = fs.readFileSync(logFile, 'utf8')
    assert.match(logText, /\[warn\][^\n]*registering tool memory_save failed/)
    assert.match(logText, /\[warn\][^\n]*registering tool memory_get failed/)
    assert.match(logText, /9\/11 memory tools registered/)})

test('subagent sessions are refused by every write-class tool, including memory_reindex', async () => {
    const { ctx, tools } = fakeContext()
    apply(ctx as never, {
        logFile: path.join(tempDir('plugin-write-log'), 'memory-plugin.log'),
        memoryHome: tempDir('plugin-write-home'),
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const repo = fakeRepo('plugin-write-repo')
    const subagent = { session: { id: 'sub-1', header: { cwd: repo, origin: 'subagent', delegationDepth: 1 } } }
    const topLevel = { session: { id: 'top-1', header: { cwd: repo } } }
    const run = async (name: string, args: unknown, agent: unknown): Promise<string> => {
        const definition = tools.get(name)
        assert.ok(definition, `${name} must be registered`)
        return String(await definition.execute(args, { agent }))
    }

    const writes: [string, unknown][] = [
        ['memory_reindex', { rebuild: true }],
        ['memory_reindex', { embeddings: true }],
        ['memory_forget', { id: 'whatever', reason: 'subagent tries' }],
        ['memory_consolidate', { dryRun: false }],
        ['memory_consolidate', { acceptProposal: 'whatever' }],
        ['memory_sync', { push: true }],
        ['memory_save', { title: 'subagent lesson', body: 'should never be written' }],
        ['memory_stats', { setBaseline: true, baselineReason: 'subagent tries' }],
    ]
    for (const [name, args] of writes) {
        const output = await run(name, args, subagent)
        assert.match(output, /refused/, `${name} must refuse a subagent`)
        assert.match(output, /routing\.subagentWrite/, `${name} must say how to enable subagent writes`)
    }

    // read-only calls are untouched by the guard
    for (const [name, args] of [
        ['memory_search', { query: 'anything' }],
        ['memory_stats', {}],
        ['memory_consolidate', { listProposals: true }],
        ['memory_consolidate', {}],
    ] as [string, unknown][]) {
        const output = await run(name, args, subagent)
        assert.doesNotMatch(output, /refused/, `${name} must stay available to a subagent`)
    }

    // the guard keys off the caller, not the tool: the same call passes for a
    // top-level session (it reaches the store instead of the refusal)
    const allowed = await run('memory_reindex', { rebuild: true }, topLevel)
    assert.doesNotMatch(allowed, /refused/)
})
