import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../dist/config.js'
import { appendProfileLine, appendPreference, isProfileName, readProfile, renderProfile, writeProfile } from '../dist/learn/profile.js'
import { clearRepoCache } from '../dist/paths.js'
import { ScopeResolver } from '../dist/scope/resolver.js'
import { loadSqliteModule } from '../dist/store/sqlite/db.js'
import { StoreRegistry } from '../dist/store/store.js'
import { saveTool } from '../dist/tools/save.js'
import { fakeRepo, memoryFixture, tempDir, useGlobalMemoryHome } from './helpers.ts'

interface SaveToolLike {
    execute: (args: Record<string, unknown>, exec: unknown) => Promise<string>
}

/** A project memory root plus the real `memory_save` tool over it. */
async function saveHarness(t: { skip: (reason: string) => void }) {
    clearRepoCache()
    const repo = fakeRepo('l5-save-repo')
    const globalHome = memoryFixture('l5-save-global', {})
    useGlobalMemoryHome(globalHome.root)
    const config = resolveConfig({})
    const registry = new StoreRegistry(config)
    const report = await registry.initialize(loadSqliteModule)
    if (!registry.available) {
        t.skip(`node:sqlite unavailable: ${report.probe.reason ?? 'unknown'}`)
        throw new Error('unreachable')
    }
    const resolver = new ScopeResolver(config)
    const agent = { session: { id: 'sess-l5', header: { cwd: repo } } }
    const scope = resolver.resolve({ agent })
    return {
        repo,
        registry,
        resolver,
        agent,
        scope,
        tool: saveTool({ config, registry, resolver }) as unknown as SaveToolLike,
    }
}

test('L5 preferences are read from the memory root and rendered within budget', () => {
    const scope = { kind: 'global' as const, root: tempDir('l5-read'), reason: 'no-project-context' as const }
    fs.mkdirSync(path.join(scope.root, 'profile'), { recursive: true })
    assert.deepEqual(readProfile(scope), [], 'a missing layer is a normal state')

    writeProfile(scope, 'preferences.md', '# 偏好\n- 回复用中文，不要用「您」。\n- 提交前先跑测试。\n')
    writeProfile(scope, 'conventions.md', '- 时间统一用 UTC。\n')
    const entries = readProfile(scope)
    assert.deepEqual(entries.map((entry) => entry.name), ['preferences.md', 'conventions.md'], 'fixed order first')

    const rendered = renderProfile(entries, 200)
    assert.match(rendered, /偏好（L5，长期有效）：/)
    assert.match(rendered, /- 回复用中文/)
    assert.match(rendered, /- 时间统一用 UTC/)

    // the budget is a real bound
    const tiny = renderProfile(entries, 10)
    assert.ok(tiny.length < rendered.length)
    assert.equal(renderProfile([], 200), '')

    // appending is idempotent and keeps a list
    appendPreference(scope, '不要自动发布版本')
    const twice = appendPreference(scope, '不要自动发布版本')
    const text = fs.readFileSync(twice as string, 'utf8')
    assert.equal(text.match(/不要自动发布版本/g)?.length, 1, 'the same preference is stored once')
})

test('any [a-z0-9-] L5 file can be appended to; path-like names never resolve', () => {
    const scope = { kind: 'global' as const, root: tempDir('l5-names'), reason: 'no-project-context' as const }

    assert.equal(isProfileName('conventions'), true)
    assert.equal(isProfileName('team-rules-2'), true)
    for (const bad of ['../evil', 'a/b', 'Conventions', 'conventions.md', '', 'a b', '.hidden', 'x'.repeat(65)]) {
        assert.equal(isProfileName(bad), false, `${JSON.stringify(bad)} must not be a profile name`)
    }

    const file = appendProfileLine(scope, 'conventions', '时间统一用 UTC。')
    assert.equal(file, path.join(scope.root, 'profile', 'conventions.md'))
    assert.match(fs.readFileSync(file as string, 'utf8'), /^# conventions\n- 时间统一用 UTC。/)
    assert.equal(appendProfileLine(scope, '../evil', 'x'), undefined, 'a traversal name is refused before touching a path')
    assert.equal(fs.existsSync(path.join(scope.root, 'evil.md')), false)

    // the historical heading is kept when preferences.md is created
    const prefs = appendProfileLine(scope, 'preferences', '不要自动发布版本')
    assert.match(fs.readFileSync(prefs as string, 'utf8'), /^# 偏好\n- 不要自动发布版本/)

    // appending twice stores the line once
    appendProfileLine(scope, 'conventions', '时间统一用 UTC。')
    assert.equal(fs.readFileSync(file as string, 'utf8').match(/时间统一用 UTC。/g)?.length, 1)

    // reading is name-agnostic: a hand-written file is part of the layer too
    writeProfile(scope, 'team-rules', '- 评审必须两人。\n')
    assert.deepEqual(
        readProfile(scope).map((entry) => entry.name),
        ['preferences.md', 'conventions.md', 'team-rules.md'],
        'known files first, then the rest sorted',
    )
})

test('memory_save writes the file named by profileFile and readProfile reads it back', async (t) => {
    const h = await saveHarness(t)

    const out = await h.tool.execute(
        {
            title: '时间统一用 UTC',
            body: '触发场景：跨时区协作。正确做法：所有时间戳统一用 UTC 记录，展示时再转本地时区。',
            layer: 'profile',
            evidence: 'user-statement',
            profileFile: 'conventions',
        },
        { agent: h.agent },
    )
    const conventions = path.join(h.scope.root, 'profile', 'conventions.md')
    assert.ok(fs.existsSync(conventions), `conventions.md must exist (tool said: ${out})`)
    assert.match(out, /profile: .*conventions\.md/, 'the result names the L5 file it wrote')

    const entries = readProfile(h.scope)
    assert.deepEqual(entries.map((entry) => entry.name), ['conventions.md'])
    assert.match(entries[0]?.text ?? '', /UTC/)
    assert.match(renderProfile(entries, 200), /- 时间统一用 UTC/)

    // the default stays preferences.md
    const second = await h.tool.execute(
        {
            title: '回复用中文',
            body: '触发场景：与用户对话。正确做法：默认用中文回复，不要用「您」。',
            layer: 'profile',
            evidence: 'user-statement',
        },
        { agent: h.agent },
    )
    assert.match(second, /profile: .*preferences\.md/)
    assert.deepEqual(
        readProfile(h.scope).map((entry) => entry.name),
        ['preferences.md', 'conventions.md'],
        'the resident section renders preferences first',
    )
})

test('a profileFile that could escape the layer is refused, and nothing is written', async (t) => {
    const h = await saveHarness(t)
    for (const bad of ['../lessons/evil', '../../evil', 'conventions.md', 'Conventions', 'a/b', 'a b', '', '.hidden']) {
        const out = await h.tool.execute(
            {
                title: '非法 L5 文件名',
                body: '触发场景：模型传入路径形态的文件名。正确做法：拒绝写入并保持层目录干净。',
                layer: 'profile',
                evidence: 'user-statement',
                profileFile: bad,
            },
            { agent: h.agent },
        )
        assert.match(out, /^rejected: profileFile/, `${JSON.stringify(bad)} must be refused (got ${out})`)
    }
    const profileDir = path.join(h.scope.root, 'profile')
    assert.equal(fs.existsSync(profileDir) ? fs.readdirSync(profileDir).length : 0, 0, 'no L5 file was created')
    assert.equal(fs.existsSync(path.join(h.scope.root, 'lessons', 'evil.md')), false, 'no write escaped profile/')
})

test('the L5 door still requires a preference the user actually stated', async (t) => {
    const h = await saveHarness(t)
    const out = await h.tool.execute(
        {
            title: '模型自己的偏好',
            body: '触发场景：模型自行总结。正确做法：不写入常驻偏好层。',
            layer: 'profile',
            evidence: 'self-report',
            profileFile: 'conventions',
        },
        { agent: h.agent },
    )
    assert.match(out, /rejected: the profile layer holds standing user preferences/)
    assert.equal(fs.existsSync(path.join(h.scope.root, 'profile', 'conventions.md')), false)
})
