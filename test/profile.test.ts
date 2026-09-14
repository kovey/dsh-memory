import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { appendPreference, readProfile, renderProfile, writeProfile } from '../lib/learn/profile.js'
import { tempDir } from './helpers.ts'

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
