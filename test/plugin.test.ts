/**
 * Plugin assembly smoke test: `apply()` must register the tool surface, extend
 * the `tools` service, and unwind every registration through `ctx.effect`
 * (DESIGN §9.2/§9.3). The host context is faked — no live session is needed.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { apply, inject, name } from '../dist/index.js'
import { fakeRepo, lessonDoc, tempDir } from './helpers.ts'

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

test('a session cannot pull unbounded memory into its context', async () => {
    // Every read tool is capped on its own; this is the bound on the *total* a
    // model can accumulate by calling them in a loop.
    const logFile = path.join(tempDir('plugin-budget-log'), 'memory-plugin.log')
    const { ctx, tools } = fakeContext()
    apply(ctx as never, {
        logFile,
        memoryHome: tempDir('plugin-budget-home'),
        recall: { sessionToolBudgetTokens: 400, budgetTokens: 120, maxItems: 2 },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const repo = fakeRepo('plugin-budget-repo')
    fs.mkdirSync(path.join(repo, '.dsh', 'memory', 'lessons'), { recursive: true })
    for (let i = 0; i < 8; i += 1) {
        fs.writeFileSync(
            path.join(repo, '.dsh', 'memory', 'lessons', `budget-lesson-${i}.md`),
            lessonDoc({ title: `budget lesson ${i}`, body: `触发场景：第 ${i} 条。正确做法：按预算取用。`, confidence: 0.9 }),
        )
    }
    const agent = { session: { id: 'budget-session', header: { cwd: repo } } }
    const call = async (name: string, args: unknown): Promise<string> => {
        const definition = tools.get(name)
        assert.ok(definition, `${name} must be registered`)
        return String(await definition.execute(args, { agent }))
    }
    let refused = 0
    let answers = 0
    for (let i = 0; i < 12; i += 1) {
        const output = await call('memory_search', { query: `budget lesson ${i}`, limit: 5 })
        if (output.startsWith('refused:')) refused += 1
        else answers += 1
    }
    assert.ok(answers > 0, 'the first calls are served normally')
    assert.ok(refused > 0, 'the session eventually stops being served')
    // keep reading until the remaining budget cannot cover one more record
    let refusal: string | undefined
    for (let i = 0; i < 24 && refusal === undefined; i += 1) {
        const output = await call('memory_get', { id: `budget-lesson-${i % 8}` })
        if (output.startsWith('refused:')) refusal = output
    }
    assert.ok(refusal !== undefined, 'a read is eventually refused')
    assert.match(refusal as string, /refused: this session has already pulled/)
    assert.match(refusal as string, /sessionToolBudgetTokens/, 'the refusal says how to change it')

    // a different session starts with a fresh budget
    const other = await tools
        .get('memory_search')
        ?.execute({ query: 'budget lesson 1', limit: 3 }, { agent: { session: { id: 'other-session', header: { cwd: repo } } } })
    assert.doesNotMatch(String(other), /^refused:/, 'a new session is not charged for the previous one')
})
