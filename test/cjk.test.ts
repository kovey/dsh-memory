/**
 * CJK query clauses (audit fix).
 *
 * Chinese technical writing glues Latin words into Chinese ones — `npm包`,
 * `git仓库`, `v2版本`, `api调用`. The old clause took bigrams of the whole term
 * (`np`, `pm`, `m包`), tokens the index can never contain, so every such query
 * matched nothing even when the document contained the words.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { cjkClause, splitTerm } from '../dist/store/sqlite/cjk.js'
import { loadSqliteModule, openDatabase } from '../dist/store/sqlite/db.js'
import { extractTerms, materialize, rawSearch, upsertRecord } from '../dist/store/sqlite/records.js'
import { tempDir } from './helpers.ts'

test('a term is split into the parts the index actually holds', () => {
    assert.deepEqual(splitTerm('npm包'), { ascii: ['npm'], cjkRuns: ['包'] })
    assert.deepEqual(splitTerm('git仓库'), { ascii: ['git'], cjkRuns: ['仓库'] })
    assert.deepEqual(splitTerm('v2版本'), { ascii: ['v2'], cjkRuns: ['版本'] })
    assert.deepEqual(splitTerm('沙箱写入'), { ascii: [], cjkRuns: ['沙箱写入'] })
    assert.deepEqual(splitTerm('bash'), { ascii: ['bash'], cjkRuns: [] })
})

test('glued terms become satisfiable clauses', () => {
    // A lone CJK character forms no bigram: inside a glued term it must not be
    // demanded, or the clause can never match.
    assert.equal(cjkClause('npm包'), '"npm"*')
    assert.equal(cjkClause('git仓库'), '("git"* ("仓库"))')
    assert.equal(cjkClause('bash'), '"bash"*')
    assert.equal(cjkClause('沙箱'), '("沙箱")')
    // a longer run is OR-ed: the boundary bigram of `仓库克隆` need not exist
    assert.equal(cjkClause('仓库克隆'), '("仓库" OR "库克" OR "克隆")')
    assert.equal(cjkClause('包'), '"包"')
})

test('glued queries find the document, and pure CJK queries keep working', async (t) => {
    const module_ = await loadSqliteModule()
    if (module_ === undefined) {
        t.skip('node:sqlite unavailable')
        return
    }
    const db = openDatabase(module_, {
        file: `${tempDir('cjk-search')}/memory.db`,
        journalMode: 'delete',
        busyTimeoutMs: 500,
        fts5: true,
    })
    upsertRecord(
        db,
        materialize({
            title: 'npm包安装失败与 git仓库 克隆',
            body: '在本机 npm包 安装失败；v2版本 需要先 git仓库 克隆，api调用 会超时。',
            layer: 'global',
            scopeKind: 'global',
        }),
    )
    const hits = (query: string): number => rawSearch(db, extractTerms(query), true).length
    for (const query of ['npm包', 'git仓库', 'v2版本', 'api调用', '包安装', '仓库克隆']) {
        assert.ok(hits(query) > 0, `"${query}" must find the document (clause ${String(cjkClause(query))})`)
    }
    // and an unrelated term still finds nothing
    assert.equal(hits('redis集群'), 0)
    db.close()
    fs.rmSync(tempDir('cjk-search'), { recursive: true, force: true })
})
