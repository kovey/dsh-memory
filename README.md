# dsh-memory

DeepSeek Harness（dsh）的分层记忆插件：**严格分离的项目级 / 全局记忆** + **任务前自动召回** + **任务后持续学习**。

设计文档（唯一决策存档）：[`docs/DESIGN.md`](docs/DESIGN.md) ｜
发布与安装：[`docs/RELEASE.md`](docs/RELEASE.md) ｜
代码审查记录：[`docs/REVIEW-2026-09-14.md`](docs/REVIEW-2026-09-14.md)

- 类型：host 插件（cordis v4），TypeScript / ESM，运行期零第三方依赖
- 数据：每个记忆根一个 SQLite 库（`node:sqlite` + FTS5，WAL）；Markdown/JSONL 作为进 Git 的文本视图
- 隔离：项目记忆只写 `<repo>/.dsh/memory`，全局记忆只写 `~/.dsh/memory`，**跨库写入被硬阻断**
- 当前进度：**M0–M5 全部完成 + 语义检索 + 蒸馏后台运行器**（见设计文档 §11、§14）

## 快速开始

```bash
# 安装（发布版：GitHub tag —— 打成 tag 后固定版本，推荐）
dsh plugin --profile nvim-tui add github:kovey/dsh-memory#v0.1.0
# 尚未打 tag 时先用分支体验（不固定版本）：
#   dsh plugin --profile nvim-tui add github:kovey/dsh-memory#main
# 然后把 "dsh-memory" 追加到 ~/.dsh/profiles/nvim-tui/package.json 的 dsh.profile.bundles
# —— 插件自带的 cordis.patch.yml 会插入 id: memory，profile patch 里不要重复 insert

# 本地开发（link 到工作区；`tui` 是生产面，脚本会拒绝操作它）
ln -sfn "$PWD" ~/.dsh/profiles/node_modules/dsh-memory
./scripts/install-into-dsh.sh --dry-run && ./scripts/install-into-dsh.sh
```

重启 profile 后，插件在 `~/.dsh/memory-plugin.log` 打印一行 `memory: ready (…)` 即为就绪；
模型侧会多出 `memory_save` / `memory_search` / `memory_recall` / `memory_get` / `memory_stats` /
`memory_forget` / `memory_consolidate` / `memory_sync` / `memory_reindex` / `memory_config` /
`memory_import` 共 11 个工具（注册失败的工具不会被协议段宣传）。

## 状态（M5：全部里程碑完成）

| 能力 | 状态 |
|---|---|
| SQLite schema v2（CJK bigram 索引、WAL、迁移） | ✅ |
| 文本视图 → DB 引导导入（`lessons/*.md`、`metrics.jsonl`） | ✅ |
| DB → 文本视图导出（`lessons/*.md`、`MEMORY.md`）与往返一致性 | ✅ |
| 作用域解析（会话 cwd → 仓库根）与项目/全局守卫 | ✅ |
| 常驻协议段（可开关）+ 项目索引摘要（per-agent scoped section）+ **L5 偏好层常驻** | ✅ |
| 11 个工具（含 `memory_config` 会话级降噪、`memory_import` 外部导入） | ✅ |
| 子代理写保护（写类工具统一拒绝，可由 `routing.subagentWrite` 打开） | ✅ |
| 门禁三态 `pass / regression / **unknown**`（无数据不再算通过） | ✅ |
| L4 晋升草稿 `proposals/<id>.SKILL.md`（人审后移动即可，插件不写 `~/.dsh/skills`） | ✅ |
| `agent/pre-step` 自动召回（阈值 0.35 / 预算 600 tok / 会话内幂等） | ✅ |
| 召回记账 `usage`（注入次数、召回后成败归因） | ✅ |
| 工具 `memory_search` / `memory_get` / `memory_recall` / `memory_stats` / `memory_reindex` | ✅ |
| 信号采集：工具失败 / 请求失败 / 用户纠正 / 返工（`tools/result`、`agent/request-error`、pre-step） | ✅ |
| L1 情节落盘：`<repo>/.dsh/memory/sessions/*.jsonl` + `signals` 表（脱敏、90 天保留） | ✅ |
| 有界自动蒸馏：仅疼痛 turn、固定 flash、3s 超时、每会话/每日预算、`distill` 审计 | ✅ |
| 写入门控：去重合并（相似度 ≥0.7）、泛泛条目拒收、无证据置信度封顶 0.55 | ✅ |
| 召回成败归因：安静且有实际工具调用的 turn 记 success，疼痛 turn 记 failure | ✅ |
| 工具 `memory_save`（默认项目级；全局仅跨项目工具链事实） | ✅ |
| 衰减与归档：TTL 过期、长期 pending 低价值、置信度半衰期（180 天，单次最多 ×0.5，≥7 天一次） | ✅ |
| 归档不删除：条目文件移入 `archive/lessons/`，可回查；导出同时维护两份视图 | ✅ |
| 矛盾检测：同主题 + 相反指令 + 共享对象 → `conflicts` 表；**消解需显式 `resolveConflicts`** | ✅ |
| 晋升提案：`times_seen ≥3` 且 conf ≥0.9 → `proposals` 表，**人审后**才写技能 | ✅ |
| 工具 `memory_consolidate` / `memory_forget`；会话创建时惰性触发巩固（每 7 天或每 5 个任务） | ✅ |
| 技能改造：`auto-retrospective` / `memory-merge` 改走插件工具，保留文件降级路径 | ✅ |
| git 化：`git init`（全局记忆库已初始化）+ 忽略规则（db/sessions/queue 不入库） | ✅ |
| 自动提交：`task-end`（默认，30 分钟检查点节流）/ `immediate` / `off`；**提交只含记忆目录**，绝不 push | ✅ |
| `memory_sync`：commit → fetch → rebase → 冲突按规则合并（lessons 合并 / MEMORY.md 重生成）→ 重建 | ✅ |
| DB 重建 `memory_reindex(rebuild=true)`：文本视图 → 库（含 episodes + metrics），克隆后指纹一致 | ✅ |
| 评估门禁：baseline.md 解析（基线任务集）、指标快照冻结、四项指标回归判定 | ✅ |
| 记忆健康度：召回命中率、召回后成败、pending 积压、蒸馏成本/超时、矛盾与提案 | ✅ |
| 门禁三态（pass / regression / **unknown**——无数据不再算通过） | ✅ |
| 趋势窗口对比（近 N 天 vs 前 N 天）+ `memory_stats({ setBaseline: true, baselineReason: "<谁要求、验证了什么>" })` | ✅ |
| 可选语义召回：OpenAI 兼容 /embeddings + 按内容哈希增量缓存 + 与词法打分混合（**默认关**） | ✅ |
| 蒸馏运行器可选 `jobs`：交给 `ctx.jobs`，轮次立即结束，作业可见/可取消 | ✅ |
| 实机验证：真实 dsh 宿主中加载、引导导入 18 条、turn 1 自动召回 4 条（533 tok） | ✅ |
| 质量工序：矛盾/衰减/归档/晋升（M3） | ⏳ |
| git 化同步与 `--rebuild`（M4） | ⏳ |
| baseline 回归门禁（M5） | ⏳ |

## 安装（三端挂载）

插件通过 **bundle 层**挂载：profile 的 `dsh.profile.bundles` 列表 + 插件自带的
`cordis.patch.yml`（`id: memory`）。`insert` 是纯追加语义，**profile 自己的
`cordis.patch.yml` 不得再 insert 同 id**（loader 对重复 id 直接抛错）。

```bash
# 1) 让三个 profile 都能解析到本包（共享的 profiles/node_modules）
ln -sfn "$PWD" ~/.dsh/profiles/node_modules/dsh-memory

# 2) 把 dsh-memory 加进各 profile 的 bundle 列表（幂等，自动备份）
./scripts/install-into-dsh.sh --dry-run   # 先看要改什么
./scripts/install-into-dsh.sh             # nvim-tui / web / headless
```

覆盖配置：在 profile 的 `cordis.patch.yml` 里按 id 覆盖（不要重复 insert）：

```yaml
- config:
    - id: memory
      config:
        prompt:
          protocol: { enabled: false }   # 关掉常驻协议段：零 token
        recall:
          autoInject: false              # 关掉自动召回：完全被动
          budgetTokens: 800
        learn:
          autoDistill: false
```

## 工具

| 工具 | 说明 |
|---|---|
| `memory_search` | 检索项目 → 全局记忆，返回标题/元数据/摘要（不返回全文） |
| `memory_get` | 按 id 读取一条记忆的完整正文 |
| `memory_stats` | 记忆库健康度：条目数、pending、过期、召回次数、任务指标 |
| `memory_save` | 写入一条长期经验：默认写项目级；同一门控负责去重/合并/拒收 |
| `memory_recall` | 一次取回任务召回包（项目 + 命中关键词的全局教训，已排序并按预算裁剪） |
| `memory_sync` | 与远端同步：本地提交 → fetch/rebase → 冲突按规则合并 → 从文本视图重建库（push 仅在显式 `push=true` 时发生） |
| `memory_consolidate` | 记忆质量巩固：过期归档 / 衰减 / 矛盾检测与消解 / 晋升提案（默认 dry-run） |
| `memory_forget` | 退役一条记忆（归档保留文件，不物理删除） |
| `memory_config` | 会话级降噪（`autoRecall: false`），不落盘 |
| `memory_import` | 把外部 lesson 文件导入项目/全局库 |
| `memory_reindex` | 从文本视图重建派生索引；`rebuild=true` 时做完整重建（删除磁盘上已不存在的记录、重导 episodes 与指标） |

## 蒸馏用哪个模型？——默认跟随会话

不需要额外配置：`learn.distillModel` 留空（默认）时，蒸馏调用**直接沿用当前会话自己的
provider/model**（`agent.options`）。想固定用便宜模型时再显式写死：

```yaml
- config:
    - id: memory
      config:
        learn:
          distillModel: { provider: deepseek-official, model: deepseek-v4-flash }
```

真机日志会标明实际用的 route，审计表也记录它：

```
memory: distilled 1 new + 0 merged record(s) from turn 7 via deepseek-official/deepseek-v4-flash
```

## 本地语义召回（已实测，推荐做法）

本机已装好 Ollama + bge-m3（1024 维，1.2GB），插件的 `remote` provider 直接可用：

```bash
brew install ollama
brew services start ollama      # 或 ollama serve &
ollama pull bge-m3
```

在 profile 的 `cordis.patch.yml` 里（**顶层 `- id: <entry>` + `config:` 形状**）：

```yaml
- id: memory
  config:
    semantic:
      enabled: true
      baseUrl: 'http://127.0.0.1:11434/v1'
      model: 'bge-m3'
      timeoutMs: 8000      # 冷启动要重新加载模型（约 2.8s），默认 1.5s 会中断自己
      weight: 0.3
      minLexicalHits: 3    # 词法召回 ≥3 条时不再调用（不花冤枉时间）
      minSimilarity: 0.5
      maxAdditions: 2      # 每次最多补几条纯语义命中，防止注入 token 膨胀
```

**实测（19 条真实教训，词法 vs 混合）**：

| 指标 | 词法 | 混合 |
|---|---|---|
| Top-1 命中 | 6/9 | 6/9 |
| **Top-3 命中** | 8/9 | **9/9** |
| **改写问法 Top-3** | 5/6 | **6/6** |
| 原词问法 Top-3 | 3/3 | 3/3 |
| 平均耗时 | 0ms | +33ms |
| 注入 token | 2670 | 3606 (+35%) |

结论：**它救的是"换了说法就搜不到"那类查询**（本次是「家目录写不进去」→ 命中「写入可能被沙箱拒绝」），
对原词查询无影响；代价是 +33ms 与约 +35% 注入 token。复跑实验：

```bash
node scripts/eval-semantic.ts --minLex 3 --weight 0.3 --minSim 0.5 --maxAdd 2
```

真机日志会标明语义贡献了几条：

```
memory: injected 2 record(s) (~182 tok) [semantic +2, embedded 19] turn 10 step 1 → zh-960299aec0, shell
```

## 语义召回实现（可选，默认关）

词法检索（FTS5 + CJK bigram）零成本、离线可用，是默认路径。当它召回不足时，可以叠加
embedding 语义召回：

```yaml
- config:
    - id: memory
      config:
        semantic:
          enabled: true
          baseUrl: 'https://api.example.com/v1'   # OpenAI 兼容 /embeddings
          model: 'text-embedding-3-small'
          apiKeyEnv: 'EMBEDDING_API_KEY'
          weight: 0.5            # 0=纯词法，1=纯语义
          minLexicalHits: 3      # 词法已召回 ≥N 条时不再调 embedding（不花冤枉钱）
          minSimilarity: 0.35
```

端点也可以用环境变量间接给出（例如沿用会话同一个网关的地址）：

```yaml
        semantic:
          enabled: true
          baseUrlEnv: 'DEEPSEEK_BASE_URL'   # 或直接写 baseUrl
          model: 'bge-m3'
          apiKeyEnv: 'DEEPSEEK_API_KEY'
```

> ⚠️ 前提是那里**真的有 embedding 模型**。实测当前会话用的网关
> `ai.wudi360.../v1` 没有任何 embedding 通道（`text-embedding-3-small` / `bge-m3` /
> `embedding-2` / `gemini-embedding-001` 全部返回 `model_not_found`），所以语义召回
> 在本机还无法真机跑通——需要另接一个 embedding 端点（或本地模型）。

行为保证：仅当词法召回不足时才调用；单次调用有超时（默认 1.5s），失败**静默降级为词法**；
向量按内容哈希缓存，未变动的教训永不重复嵌入；作用域内无记录时直接跳过。
用 `memory_reindex({ embeddings: true })` 做一次全量回填，`memory_stats` 会显示索引与最近错误。

## 蒸馏放哪跑：inline / jobs

| 模式 | 行为 | 适用 |
|---|---|---|
| `inline`（出厂默认） | 在 `agent/turn-stopping` 里有界 await（默认 15s），轮次结束会等它 | 任何 surface 都成立 |
| `jobs` | 交给 `ctx.jobs`，**轮次 4ms 就结束**，作业在作业列表可见 | 长驻交互会话（nvim-tui / web） |

一次性 surface（`dsh --profile headless "任务"`、e2e）里 agent 在轮次结束即销毁、**作业会被取消**——
所以插件带**补蒸馏**：`signals` 里没有对应 `distill` 审计行的组，会在下一个会话的首轮结束时
用 inline 补跑（每作用域每作用域每进程一次，年龄 > 一次蒸馏超时 且轮次已结束才捡）。实测：

```
会话1: turn 18 distillation handed to job memory-distill-1 → job cancelled (owner disposed)
会话2: recovered 1 undistilled signal(s) from session … turn 18 → created
       （turn 18 | in 300 / out 216 | created 1）
```

即**作业被取消只损失一轮延迟，不丢教训**；崩溃/重启中途丢失同理。

## 配置调参的可靠方式

写进 profile 的 `cordis.patch.yml`（按 id 覆盖，不重复 insert）：

```yaml
- config:
    - id: memory
      config:
        learn:
          distillTimeoutMs: 15000   # 实测一次 flash 蒸馏约 4.2s，别设太小
          distillRunner: jobs       # 不想让轮次等待就交给 ctx.jobs
        recall:
          budgetTokens: 800
```

> 实测注意：`dsh --patch <file>` 的 overlay **没有**作用到本插件的 config（六次真机运行的 ready 行始终是
> 默认值）。调参请用上面的 profile patch。

## 评估与门禁

```
memory_stats({ windowDays: 30 })                  # 现状 + 健康度 + 门禁判定 + 趋势
memory_stats({ setBaseline: true, baselineReason: "用户要求；v0.4 发布后 7 天无回归" })  # 冻结基线（需理由 + 顶层会话，子代理被拒）
```

门禁对比四项指标（成功率↑、耗时↓、打扰↓、返工↓），带容差（成功率 ±0.05、耗时 ±15%、打扰/返工 ±0.5），
退化时报告 `REGRESSION` 并列出退化项。`baseline.md` 是**人所有、插件只读**的文档，
快照存在数据库的 `baseline_snapshots` 表里。

> 说明：基线任务集是**其他仓库的真实任务**，插件无法自动重放，因此它会列出任务清单供人工回归；
> 它能自动判定的是任务日志实际承载的指标。

## 跑真机测试（推荐方式）

一次性任务 + 隔离记忆根，既验证完整链路，又不碰你的真实记忆：

```bash
# 1) 隔离 profile（base + headless + 本插件）
mkdir -p ~/.dsh/profiles/memlive
cat > ~/.dsh/profiles/memlive/package.json <<'JSON'
{ "name": "dsh-profile-memlive", "private": true, "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-memory"], "patchReload": "startup" } } }
JSON
printf '[]\n' > ~/.dsh/profiles/memlive/cordis.patch.yml

# 2) 隔离记忆根（用真实语料播种，便于验证召回）
mkdir -p /tmp/dsh-live-mem && cp -R ~/.dsh/memory/lessons /tmp/dsh-live-mem/lessons

# 3) 真实模型跑一次性任务
DSH_MEMORY_HOME=/tmp/dsh-live-mem dsh --profile memlive \
  "调用 memory_search 搜索 'pnpm install 无 TTY'，然后调用 memory_stats 并汇报记录数"

# 4) 看证据
tail -20 ~/.dsh/memory-plugin.log
```

`DSH_MEMORY_HOME` 会把全局记忆根重定向到临时目录（项目级作用域由会话 cwd 决定，不受影响）。

## 开发

```bash
npm run build         # tsc → lib/
npm test              # 构建后 node --test（Node 原生 TS 执行测试）
```

测试全部在仓库内 `.tmp-tests/` 运行，并把全局记忆根重定向到临时目录，**不会触碰
真实的 `~/.dsh/memory`**。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | 设计存档：分层模型、双库隔离、钩子方案、里程碑与实机验证记录 |
| [`docs/RELEASE.md`](docs/RELEASE.md) | dev 链路 vs 发布链路、发布前检查、装进 profile 的步骤与回退 |
| [`docs/REVIEW-2026-09-14.md`](docs/REVIEW-2026-09-14.md) | 一次全面代码审查：59 条发现、修复清单与验证方式 |

## 日志

`~/.dsh/memory-plugin.log`（插件绝不写 stdout：TUI 拥有 stdout，web 端有自己的
server 日志）。日志超过 5 MB 自动轮转为 `.log.1`。
