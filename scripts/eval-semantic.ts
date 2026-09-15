/**
 * Semantic-recall evaluation on a real lesson corpus.
 *
 * Answers the only question that matters before keeping semantic recall on:
 * does blending embeddings actually retrieve lessons that keyword search misses,
 * and what does it cost?
 *
 *   node scripts/eval-semantic.ts --root <memory root> [--model bge-m3] [--base http://127.0.0.1:11434/v1]
 *
 * The corpus is copied into a scratch root, so the evaluation never mutates a
 * production memory store. Both arms call the shipped `recall()` — the only
 * difference is whether a semantic provider is attached.
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveConfig } from '../dist/config.js'
import { loadSqliteModule } from '../dist/store/sqlite/db.js'
import { StoreRegistry } from '../dist/store/store.js'
import { ScopeResolver } from '../dist/scope/resolver.js'
import { recall } from '../dist/recall/engine.js'
import { createRemoteProvider, ensureEmbeddings, QueryVectorCache } from '../dist/recall/semantic.js'
import { extractTerms } from '../dist/store/sqlite/records.js'
import type { MemoryScope } from '../dist/store/types.js'

interface Query {
    /** What the user would ask. */
    ask: string
    /** Lesson id that *should* be recalled. */
    want: string
    /** `paraphrase` = deliberately no keyword overlap; `literal` = shares terms. */
    kind: 'paraphrase' | 'literal'
}

const QUERIES: Query[] = [
    { ask: '怎么在没有终端的环境里装依赖？', want: 'pnpm-install--tty--json', kind: 'paraphrase' },
    { ask: '提交代码之前要不要先跟远端核对一下？', want: '-fetch--origin', kind: 'paraphrase' },
    { ask: '家目录写不进去的时候怎么办？', want: 'dsh-', kind: 'paraphrase' },
    { ask: '命令行跑完没有任何输出就卡住了', want: 'stdioinherit--bash-timeout', kind: 'paraphrase' },
    { ask: '同一个应用起了两个长连接会怎样？', want: 'app', kind: 'paraphrase' },
    { ask: '什么时候可以给项目打个版本号？', want: 'no-auto-release', kind: 'paraphrase' },
    { ask: 'pnpm install 无 TTY', want: 'pnpm-install--tty--json', kind: 'literal' },
    { ask: 'git fetch origin 核对', want: '-fetch--origin', kind: 'literal' },
    { ask: '沙箱 写入 拒绝', want: 'dsh-', kind: 'literal' },
]

interface ArmResult {
    label: string
    top1: number
    top3: number
    paraphraseTop3: number
    paraphraseTotal: number
    literalTop3: number
    literalTotal: number
    avgMs: number
    tokens: number
}

async function runArm(
    label: string,
    root: string,
    config: ReturnType<typeof resolveConfig>,
    semantic: { provider?: ReturnType<typeof createRemoteProvider>; cache?: QueryVectorCache } | undefined,
    scope: MemoryScope,
): Promise<ArmResult> {
    const registry = new StoreRegistry(config)
    await registry.initialize(loadSqliteModule)
    const store = registry.open(scope)
    if (store === undefined) throw new Error('store unavailable')
    if (semantic?.provider !== undefined) {
        await ensureEmbeddings(store.db, semantic.provider, config.semantic.model, { limit: -1 })
    }
    const resolver = new ScopeResolver(config)
    const agent = { options: { provider: 'x', model: 'y' }, session: { id: 'eval', header: { cwd: '/tmp' } } }
    const result: ArmResult = {
        label,
        top1: 0,
        top3: 0,
        paraphraseTop3: 0,
        paraphraseTotal: 0,
        literalTop3: 0,
        literalTotal: 0,
        avgMs: 0,
        tokens: 0,
    }
    let ms = 0
    for (const query of QUERIES) {
        const started = Date.now()
        const outcome = await recall(
            { config, registry, resolver, ...(semantic !== undefined ? { semantic } : {}) },
            { agent, terms: extractTerms(query.ask), text: query.ask, includeGlobal: true, maxItems: 5, minScore: 0 },
        )
        ms += Date.now() - started
        result.tokens += outcome.tokensUsed
        const ids = outcome.hits.map((hit) => hit.record.id)
        const rank = ids.indexOf(query.want)
        if (rank === 0) result.top1 += 1
        if (rank >= 0 && rank < 3) result.top3 += 1
        if (query.kind === 'paraphrase') {
            result.paraphraseTotal += 1
            if (rank >= 0 && rank < 3) result.paraphraseTop3 += 1
        } else {
            result.literalTotal += 1
            if (rank >= 0 && rank < 3) result.literalTop3 += 1
        }
        if (process.env['EVAL_VERBOSE'] === '1') {
            console.log(`    ${rank >= 0 ? `#${rank + 1}` : 'miss'}  ${query.ask}  →  ${ids.slice(0, 3).join(', ') || '(none)'}`)
        }
    }
    result.avgMs = ms / QUERIES.length
    registry.closeAll()
    return result
}

function report(base: ArmResult, hybrid: ArmResult): void {
    const row = (label: string, a: number, b: number, total?: number): string =>
        `  ${label.padEnd(22)} ${String(a).padStart(3)}${total !== undefined ? `/${total}` : ''}  →  ${String(b).padStart(3)}${total !== undefined ? `/${total}` : ''}`
    console.log(`\n  ${'指标'.padEnd(20)} 词法   →  混合`)
    console.log(row('Top-1 命中', base.top1, hybrid.top1, QUERIES.length))
    console.log(row('Top-3 命中', base.top3, hybrid.top3, QUERIES.length))
    console.log(row('改写问法 Top-3', base.paraphraseTop3, hybrid.paraphraseTop3, base.paraphraseTotal))
    console.log(row('原词问法 Top-3', base.literalTop3, hybrid.literalTop3, base.literalTotal))
    console.log(`  ${'平均耗时(ms)'.padEnd(20)} ${base.avgMs.toFixed(0).padStart(3)}   →  ${hybrid.avgMs.toFixed(0).padStart(3)}`)
    console.log(`  ${'注入 token 合计'.padEnd(20)} ${String(base.tokens).padStart(3)}   →  ${String(hybrid.tokens).padStart(3)}`)
}

async function main(): Promise<void> {
    const args = process.argv.slice(2)
    const arg = (name: string, fallback: string): string => {
        const index = args.indexOf(`--${name}`)
        return index >= 0 && args[index + 1] !== undefined ? (args[index + 1] as string) : fallback
    }
    const source = arg('root', path.join(process.env['HOME'] ?? '.', '.dsh', 'memory'))
    const model = arg('model', 'bge-m3')
    const baseUrl = arg('base', 'http://127.0.0.1:11434/v1')
    const weight = Number(arg('weight', '0.5'))
    const minSimilarity = Number(arg('minSim', '0.35'))
    const minLexicalHits = Number(arg('minLex', '99'))
    const maxAdditions = Number(arg('maxAdd', '2'))
    // `memoryHome` is the *dsh home*; the memory root is `<home>/memory`.
    const home = arg('scratch', path.join('/tmp', `dsh-semantic-eval-${Date.now()}`))
    const scratch = path.join(home, 'memory')

    fs.rmSync(home, { recursive: true, force: true })
    fs.mkdirSync(scratch, { recursive: true })
    fs.cpSync(path.join(source, 'lessons'), path.join(scratch, 'lessons'), { recursive: true })
    for (const extra of ['metrics.jsonl', 'baseline.md']) {
        if (fs.existsSync(path.join(source, extra))) fs.copyFileSync(path.join(source, extra), path.join(scratch, extra))
    }
    const lessons = fs.readdirSync(path.join(scratch, 'lessons')).length
    console.log(`corpus: ${lessons} lessons from ${source}\nscratch: ${home}`)

    const scope: MemoryScope = { kind: 'global', root: scratch, reason: 'no-project-context' }
    const lexicalConfig = resolveConfig({ memoryHome: home })

    console.log('\n[1/2] 词法基线（semantic off）')
    const base = await runArm('lexical', scratch, lexicalConfig, undefined, scope)

    console.log(`[2/2] 混合召回（lexical + bge-m3，weight=${weight} minSim=${minSimilarity} minLex=${minLexicalHits}）`)
    const hybridConfig = resolveConfig({
        memoryHome: home,
        semantic: {
            enabled: true,
            provider: 'remote',
            baseUrl,
            model,
            timeoutMs: 15_000,
            minLexicalHits, // 99 = always embed (isolate the semantic contribution)
            weight,
            minSimilarity,
            maxRecordsPerRun: 5_000,
            maxAdditions,
        },
    })
    const provider = createRemoteProvider({ baseUrl, model, timeoutMs: 15_000 })
    const hybrid = await runArm('hybrid', scratch, hybridConfig, { provider, cache: new QueryVectorCache() }, scope)
    if (provider.lastError() !== undefined) console.log(`  ⚠ provider last error: ${provider.lastError()}`)

    report(base, hybrid)
    console.log(`\nscratch kept for inspection: ${home}`)
}

await main()
