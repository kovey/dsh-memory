/**
 * Frontmatter compatibility tests: documents written by
 * `~/.dsh/scripts/memory-lesson.sh` must parse and re-render without losing the
 * five legacy fields (DESIGN §5.3, §10).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import { expiresToIso, isoToExpires, parseEvidenceSummary, parseLesson, renderLesson } from '../lib/store/frontmatter.js'
import { lessonDoc } from './helpers.ts'

test('parses the legacy five-field document', () => {
    const parsed = parseLesson(
        lessonDoc({ title: 'shell background trap', body: '一句话教训 + 正确做法.', confidence: 0.95, timesSeen: 3 }),
    )
    assert.ok(parsed)
    assert.equal(parsed.frontmatter.title, 'shell background trap')
    assert.equal(parsed.frontmatter.confidence, 0.95)
    assert.equal(parsed.frontmatter.expires, 'permanent')
    assert.equal(parsed.frontmatter.timesSeen, 3)
    assert.equal(parsed.frontmatter.updated, '2026-09-01')
    assert.equal(parsed.body, '一句话教训 + 正确做法.')
})

test('keeps a colon inside the title and CJK bodies intact', () => {
    const parsed = parseLesson(lessonDoc({ title: 'dsh Session 表面契约与 append 重入限制', body: '正文: 含冒号\n\n第二段。' }))
    assert.ok(parsed)
    assert.equal(parsed.frontmatter.title, 'dsh Session 表面契约与 append 重入限制')
    assert.equal(parsed.body, '正文: 含冒号\n\n第二段。')
})

test('reads optional extended fields and ignores unknown ones', () => {
    const parsed = parseLesson(
        lessonDoc({
            title: 'extended',
            body: 'body',
            extra: { tags: 'alpha, beta', status: 'active', origin: 'distilled', times_recalled: '4', who_knows: 'x' },
        }),
    )
    assert.ok(parsed)
    assert.deepEqual(parsed.frontmatter.tags, ['alpha', 'beta'])
    assert.equal(parsed.frontmatter.origin, 'distilled')
    assert.equal(parsed.frontmatter.timesRecalled, 4)
})

test('renders the legacy field order first so the shell fallback keeps working', () => {
    const text = renderLesson(
        { title: 't', confidence: 0.8, expires: '2026-12-01', timesSeen: 2, updated: '2026-09-11' },
        'body text',
    )
    const keys = text
        .split('\n')
        .filter((line) => /^[a-z_]+:/.test(line))
        .map((line) => line.slice(0, line.indexOf(':')))
    assert.deepEqual(keys.slice(0, 5), ['title', 'confidence', 'expires', 'times_seen', 'updated'])
    assert.match(text, /\n---\n\nbody text\n$/)
})

test('round-trips a document unchanged', () => {
    const original = lessonDoc({ title: 'round trip', body: 'first line\nsecond line', confidence: 0.7, timesSeen: 5 })
    const parsed = parseLesson(original)
    assert.ok(parsed)
    const rendered = renderLesson(parsed.frontmatter, parsed.body)
    assert.equal(rendered, original)
})

test('maps permanent and dated expiries both ways', () => {
    assert.equal(expiresToIso('permanent'), undefined)
    assert.equal(expiresToIso('2026-09-14'), '2026-09-14')
    assert.equal(isoToExpires(undefined), 'permanent')
    assert.equal(isoToExpires('2026-09-14'), '2026-09-14')
})

test('writes and reads the evidence summary without leaking detail', () => {
    const text = renderLesson(
        { title: 't', confidence: 0.8, expires: 'permanent', timesSeen: 1, updated: '2026-09-01' },
        'body',
        { evidence: 'tool-failure×2, user-statement×1' },
    )
    assert.match(text, /^evidence: tool-failure×2, user-statement×1$/m)
    const parsed = parseLesson(text)
    assert.ok(parsed)
    assert.equal(parsed.frontmatter.evidence, 'tool-failure×2, user-statement×1')
    assert.deepEqual(parseEvidenceSummary(parsed.frontmatter.evidence ?? ''), [
        { kind: 'tool-failure', count: 2 },
        { kind: 'user-statement', count: 1 },
    ])
    // A parse → render round trip keeps the field: sync merges documents too.
    assert.equal(renderLesson(parsed.frontmatter, parsed.body), text)
})

test('a document without evidence renders without the field', () => {
    const text = lessonDoc({ title: 'legacy shape', body: 'body', confidence: 0.9 })
    const parsed = parseLesson(text)
    assert.ok(parsed)
    assert.equal(parsed.frontmatter.evidence, undefined)
    assert.equal(renderLesson(parsed.frontmatter, parsed.body), text, 'legacy documents are untouched')
})

test('an explicit field is never written twice', () => {
    const text = renderLesson(
        {
            title: 't',
            confidence: 0.8,
            expires: 'permanent',
            timesSeen: 1,
            updated: '2026-09-01',
            evidence: 'tool-failure×2',
        },
        'body',
        { evidence: 'tool-failure×2', note: 'kept' },
    )
    assert.equal(text.split('\n').filter((line) => line.startsWith('evidence:')).length, 1)
    assert.match(text, /^note: kept$/m)
})

test('parses the evidence summary tolerantly and never throws', () => {
    assert.deepEqual(parseEvidenceSummary('tool-failure×2, user-statement×1'), [
        { kind: 'tool-failure', count: 2 },
        { kind: 'user-statement', count: 1 },
    ])
    assert.deepEqual(parseEvidenceSummary('tool-failure x 3; user-correction: 1'), [
        { kind: 'tool-failure', count: 3 },
        { kind: 'user-correction', count: 1 },
    ])
    assert.deepEqual(parseEvidenceSummary('self-report'), [{ kind: 'self-report', count: 1 }])
    assert.deepEqual(parseEvidenceSummary('tool-failure×2, ??? , 42'), [{ kind: 'tool-failure', count: 2 }])
    assert.deepEqual(parseEvidenceSummary(''), [])
    // A hand-edited count is clamped, not turned into an unbounded import loop.
    assert.deepEqual(parseEvidenceSummary('tool-failure×99999'), [{ kind: 'tool-failure', count: 9999 }])
})

test('parses every real lesson in the global store when present', (t) => {
    const home = process.env['DSH_HOME'] ?? path.join(os.homedir(), '.dsh')
    const dir = path.join(home, 'memory', 'lessons')
    if (!fs.existsSync(dir)) {
        t.skip('no real lesson corpus available')
        return
    }
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.md'))
    assert.ok(files.length > 0, 'expected at least one lesson file')
    for (const file of files) {
        const parsed = parseLesson(fs.readFileSync(path.join(dir, file), 'utf8'))
        assert.ok(parsed, `${file} must parse`)
        assert.ok(parsed.frontmatter.title.length > 0, `${file} must have a title`)
        assert.ok(parsed.frontmatter.confidence >= 0 && parsed.frontmatter.confidence <= 1, `${file} confidence range`)
    }
})
