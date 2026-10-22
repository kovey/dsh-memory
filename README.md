# dsh-memory

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的分层记忆插件：
**项目级 / 全局记忆严格分离**，任务前自动召回，任务后自动学习，不依赖模型"记得去复盘"。

- 当前版本 **v0.3.2**｜变更 [`CHANGELOG.md`](CHANGELOG.md)｜跨宿主升级 [`UPGRADE.md`](UPGRADE.md)
- 宿主兼容见[支持矩阵](#支持哪些宿主和端)；Node `^22.19 || >=24`（依赖内置 `node:sqlite`）
- 类型：host 插件（cordis v4），TypeScript / ESM，运行期零第三方依赖
- 设计存档（唯一决策来源）：[`docs/DESIGN.md`](docs/DESIGN.md)

## 它做什么

| 阶段 | 行为 |
|---|---|
| 会话开始 | 注入常驻段：协议段（≤240 tok）+ 索引摘要（≤150）+ L5 偏好（≤200），合计 **≤590 tok** |
| 每轮第 1 步 | `agent/pre-step` 召回：项目记忆 + 关键词命中的全局教训（**≤600 tok / ≤5 条**，会话内幂等去重） |
| 干活时 | 11 个工具按需读写（见[工具](#工具)），会话内工具输出有累计预算 |
| 轮次结束 | 只对"疼痛轮次"做**有界**蒸馏：15s 超时、每会话 3 次、每日 200k tok |
| 任务收尾 | 导出文本视图 + 记忆根本地 git 提交（**绝不 push**） |
| 每 5 任务 / 7 天 | 惰性巩固：过期归档、置信度衰减、矛盾检测、晋升提案 |

三条不变量：**项目记忆只写 `<repo>/.dsh/memory`、全局只写 `$DSH_HOME/memory`（默认 `~/.dsh/memory`），跨库写入硬阻断**；
插件故障不伤宿主（钩子整体 try/catch）；**绝不写 stdout/stderr**（日志只落文件）。

## 快速开始

```bash
# 发布版（推荐，固定 tag）
dsh plugin --profile nvim-tui add github:kovey/dsh-memory#v0.3.2
# 再把 "dsh-memory" 追加到 ~/.dsh/profiles/<profile>/package.json 的 dsh.profile.bundles
# ⚠️ dsh plugin add 只是在 profile 里执行 pnpm；只 add 不加 bundles = 装了但不加载

# 本地开发（link 到工作区；tui 是生产面，脚本默认拒绝操作它）
ln -sfn "$PWD" ~/.dsh/profiles/node_modules/dsh-memory
./scripts/install-into-dsh.sh --dry-run   # 先看要改什么
./scripts/install-into-dsh.sh             # nvim-tui / web / headless
```

重启 profile 后，`~/.dsh/memory-plugin.log` 出现 `memory: ready (…)` 即为就绪。
覆盖配置写在 profile 的 `cordis.patch.yml`，**按 id 覆盖、不要重复 `insert`**（loader 对重复 id 直接抛错）：

```yaml
- id: memory
  config:
    recall: { autoInject: false }          # 只关自动召回
    prompt: { protocol: { enabled: false } }  # 关掉常驻协议段
```

> `dsh --patch <file>` 的 overlay 实测**不作用于**本插件 config（六次真机运行 ready 行始终是默认值）——调参请用 profile patch。

## 支持哪些宿主和端

**端无关。** 插件只注入 `ctx.tools` 与 `ctx.systemPrompt`、只订阅核心 agent 事件，没有任何 surface 专用代码，
所以 nvim-tui / web / headless 同构可用。官方桌面端就是 web 应用的 Electron 壳，同样零适配——
但它有**独立的 `$DSH_HOME/profiles/desktop`**，插件要单独装进那个 profile（CLI 的 `web`/`tui` profile 不共享）。

**真正会挡住它的是宿主内核版本**：5 个 `@deepseek-ai/dsh-*` peer 不匹配时，加载器会**静默跳过整条 bundle**
（只写日志，记忆功能无声消失）。

| 宿主 dsh | 该用的 dsh-memory |
|---|---|
| `0.2.0-rc.2` / `0.2.1-rc.x` / `0.2.1` | **v0.3.2**（范围锚定 `>=0.2.0-rc.2 <0.2.2`） |
| `0.1.7-rc.2` | v0.2.1 |
| `0.1.7-rc.1` | v0.2.0 |
| `0.2.0-rc.1` | v0.2.2 |
| `≥0.2.2` | 无（需要下一次适配） |

被跳过时日志/启动 stderr 会出现 `Plugin dsh-memory@… is incompatible with dsh …`。
`dsh plugin allow-version` 能对精确 `插件@版本 × 内核` 显式豁免，但它只跳门禁、**不解决 API 差异**，跨大版本别用。

## 记忆放在哪

| 层 | 位置 | 生命周期 |
|---|---|---|
| L1 情节 | `<root>/sessions/*.jsonl` + `signals` 表 | 90 天、脱敏、**从不注入** |
| L2 项目记忆 | `<repo>/.dsh/memory/lessons/*.md` | 长期，每任务必召回 |
| L3 全局记忆 | `~/.dsh/memory/lessons/*.md` | 长期，关键词命中才召回 |
| L4 技能 | 草稿 `<root>/proposals/<id>.SKILL.md` → 人审后装到 `~/.dsh/skills/<name>/SKILL.md` | 人审闸门 |
| L5 偏好 | `<root>/profile/*.md` | 常驻提示词（≤200 tok） |

`<root>`（项目根或全局根）内固定这些内容：

```
lessons/*.md       记录，唯一真源（进 git）
MEMORY.md          人读索引，自动重生成（勿手改结构）
metrics.jsonl      任务指标（进 git）
profile/*.md       L5 偏好（进 git）
baseline.md        评估基线任务集（人所有，插件只读）
sessions/  archive/  proposals/    情节 / 归档 / 晋升草稿
memory.db(+wal/shm)  派生索引，不入库（.gitignore 已含）
```

全局根默认 `~/.dsh/memory`，可用 `DSH_MEMORY_HOME` 重定向（测试用）；项目根由会话 `header.cwd`
经 git 解析得到（**不看进程 cwd**，同一仓库的 linked worktree 共享一个记忆根）。

## 工具

| 工具 | 用途 |
|---|---|
| `memory_search` / `memory_get` | 检索（标题+摘要）/ 按 id 读全文 |
| `memory_recall` | 一次取回召回包（已排序、按预算裁剪） |
| `memory_save` | 写长期经验（默认项目级；同一门控负责去重/合并/拒收） |
| `memory_stats` | 健康度 + 评估门禁 + 趋势 |
| `memory_consolidate` / `memory_forget` | 巩固（默认 dry-run）/ 退役（归档不删） |
| `memory_sync` | 提交 → fetch/rebase → 冲突按规则合并 → 重建（`push=true` 才推） |
| `memory_reindex` | 从文本视图重建索引；`rebuild=true` 做全量重建 |
| `memory_import` / `memory_config` | 导入外部 lesson / 会话级降噪（不落盘） |

注册失败的工具不会出现在常驻协议段里——能力由**实际注册结果**推导，不是"打算注册什么"。

## 常用配置

默认值全在 [`cordis.patch.yml`](cordis.patch.yml)，profile patch 里只写要改的：

| 键 | 默认 | 说明 |
|---|---|---|
| `recall.autoInject` / `budgetTokens` / `maxItems` / `minScore` | `true` / 600 / 5 / 0.35 | 每轮自动召回 |
| `recall.sessionToolBudgetTokens` | 20000 | 会话内工具输出累计上限 |
| `routing.subagentWrite` | `false` | 子代理默认不能写记忆（写类工具统一拒绝） |
| `learn.collectSignals` | `true` | 信号采集：失败命令 / 请求失败 / 用户纠正 / 返工 |
| `learn.autoDistill` / `distillTimeoutMs` / `maxDistillPerSession` | `true` / 15000 / 3 | 疼痛轮次蒸馏 |
| `learn.distillRunner` | `inline` | `inline` 任何端都成立；`jobs` 让轮次立即结束（长驻会话） |
| `learn.distillModel` | 空 | 留空 = 沿用当前会话自己的 provider/model |
| `learn.exitCodeSignals` | `strong` | `strong`=exit≥2 与错误标记；`all`=任何非零；`off` |
| `episodic.retentionDays` / `captureUserText` | 90 / `redacted` | 情节保留与脱敏 |
| `consolidate.everyNTasks` / `everyDays` | 5 / 7 | 惰性巩固触发频率 |
| `eval.autoFreezeBaseline` | `false` | 基线默认人工冻结（见[评估门禁](#评估门禁)） |
| `git.autoCommit` / `checkpointMinutes` | `task-end` / 30 | `off` / `task-end` / `immediate`；插件**永不 push**（`git.autoPush` 是字面量 `false`，没有开关） |
| `sqlite.journalMode` / `maxOpenRoots` | `wal` / 4 | 派生库 |
| `semantic.enabled` | `false` | 语义召回（下一节） |

完整键表与取值范围以 [`src/config.ts`](src/config.ts) 的 `DEFAULT_CONFIG` 为准。

## 语义召回（可选，默认关）

词法检索（FTS5 + CJK bigram）零成本、离线可用，是默认路径；**只在词法召回不足时**才调用 embedding，
失败静默降级为词法，向量按内容哈希缓存、未变动的记录不重复嵌入。默认关是因为它是除蒸馏外唯一会花钱的路径。

```yaml
- id: memory
  config:
    semantic:
      enabled: true
      baseUrl: 'http://127.0.0.1:11434/v1'   # OpenAI 兼容 /embeddings；也可用 baseUrlEnv
      model: 'bge-m3'
      timeoutMs: 8000        # 冷启动要重载模型（~2.8s），默认 1.5s 会把自己中断
      minLexicalHits: 3      # 词法已召回 ≥3 条时不再调用
      maxAdditions: 2        # 每次最多补几条纯语义命中
```

19 条真实教训上的对照（复跑需先 `npm run build`：`node scripts/eval-semantic.ts --root ~/.dsh/memory --minLex 3 --weight 0.3 --minSim 0.5 --maxAdd 2`）：

| 指标 | 词法 | 混合 |
|---|---|---|
| Top-1 命中 | 6/9 | 6/9 |
| **Top-3 命中** | 8/9 | **9/9** |
| **改写问法 Top-3** | 5/6 | **6/6** |
| 平均耗时 | 0ms | +33ms |
| 注入 token | 2670 | 3606 (+35%) |

结论：它救的是"换个说法就搜不到"那类查询，对原词查询无影响。
前提是端点**真有** embedding 模型——本机网关没有该通道（`text-embedding-3-small` / `bge-m3` 等全部
`model_not_found`），所以默认配置下无法真机跑通；接上本地 Ollama 或独立端点后，用
`memory_reindex({ embeddings: true })` 做一次全量回填，`memory_stats` 会显示索引量与最近错误。

## 上下文会不会被撑爆

不会。三条入口都有硬上限，与库大小无关：

| 入口 | 上限 |
|---|---|
| 常驻段 | 协议 240 + 索引 150 + L5 200 = **≤590 tok** |
| 自动召回 | **600 tok / ≤5 条**，同会话幂等去重 |
| 工具输出 | 单次 `memory_recall` ≤4000 tok；**会话累计 20k** 后明确拒答并说明如何调整 |

实测 55 次注入：中位 234 tok、**最大 592**。增长的只有存储，且都有保留策略
（情节 90 天、召回记账 180 天、换模型后的旧向量 30 天宽限；记录只归档不删除）。

## 评估门禁

```js
memory_stats({ windowDays: 30 })     // 健康度 + 门禁判定：pass / regression / unknown
memory_stats({ setBaseline: true, baselineReason: "用户要求；v0.3.2 发布后 7 天无回归" })
```

对比四项指标：成功率↑、耗时↓、打扰↓、返工↓（容差：成功率 ±0.05、耗时 ±15%、打扰/返工 ±0.5）。
**没有基线时判定只能是 `unknown`**——冻结基线是人工步骤：需要理由，子代理调用会被拒。
`baseline.md` 里的基线任务集属于其他仓库，插件无法自动重放，只会列出清单供人工回归；
它能自动判定的是任务日志实际承载的指标。

## 排障

| 现象 | 先看什么 |
|---|---|
| 完全没生效 | `~/.dsh/memory-plugin.log` 有没有 `memory: ready`；没有多半是 bundle 被跳过（peer 版本，见[支持矩阵](#支持哪些宿主和端)） |
| 工具报 `store unavailable` | Node 是否带 `node:sqlite`（`node -p "process.versions.node"`，需 ≥22.19 或 ≥24 的构建） |
| 召回总是空 | 该作用域有没有 `active` 记录；`minScore` 是否过高；`memory_config({})` 看会话覆盖 |
| 蒸馏没发生 | 该轮是否够"疼痛"（`minSignals`）、每会话/每日预算是否已用尽 |
| 语义检索没贡献 | `memory_stats` 的索引行；多半是没配端点或没回填（`memory_reindex({ embeddings: true })`） |

日志 `~/.dsh/memory-plugin.log` 超过 5 MB 自动轮转为 `.log.1`。插件从不写 stdout：
TUI 拥有 stdout，web server 有自己的 console。

## 开发

```bash
npm install        # peer @deepseek-ai/* 已在 devDependencies（干净 clone 也能构建）
npm run build      # tsc → dist/（dist/ 入库，github: 安装免构建）
npm test           # 构建后 node --test 跑全量（不写死用例数——写死的数字会过期）
npm run typecheck  # 只做类型检查
```

测试全部在仓库内 `.tmp-tests/` 运行，并把全局记忆根重定向到临时目录，**不会触碰真实的 `~/.dsh/memory`**。
发布与安装链路（dev 链 vs 发布链、`tui` 为何拒绝 link）见 [`docs/RELEASE.md`](docs/RELEASE.md)。

真机验证（隔离 profile + 隔离记忆根，不碰真实记忆）：

```bash
mkdir -p ~/.dsh/profiles/memlive && printf '[]\n' > ~/.dsh/profiles/memlive/cordis.patch.yml
cat > ~/.dsh/profiles/memlive/package.json <<'JSON'
{ "name": "dsh-profile-memlive", "private": true, "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-memory"] } } }
JSON
cp -R ~/.dsh/memory/lessons /tmp/dsh-live-mem/lessons      # 用真实语料播种，便于验证召回
DSH_MEMORY_HOME=/tmp/dsh-live-mem dsh --profile memlive "调用 memory_stats 并汇报记录数"
tail -20 ~/.dsh/memory-plugin.log                          # 期望：memory: ready + 注入行
```

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | 设计存档：分层模型、双库隔离、钩子方案、里程碑与实机验证记录 |
| [`docs/RELEASE.md`](docs/RELEASE.md) | dev 链路 vs 发布链路、发布前检查、装进 profile 的步骤与回退 |
| [`docs/REVIEW-2026-09-14.md`](docs/REVIEW-2026-09-14.md) | 一次全面代码审查：59 条发现与修复清单 |
| [`CHANGELOG.md`](CHANGELOG.md) / [`UPGRADE.md`](UPGRADE.md) | 版本变更（Keep a Changelog）/ 跨宿主版本的升级指引 |
