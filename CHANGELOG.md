# Changelog

本文件记录 dsh-memory 的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] — 2026-09-24

> **破坏性变更**：本版适配 **dsh 0.1.7-rc.1**，插件与宿主必须**一起**升级。
> 若你暂时不想动宿主，请留在 **v0.1.1**。升级步骤见 [UPGRADE.md](UPGRADE.md)。

### Changed

- **peer 锚点由区间改为精确版本。** 0.1.5 时期是 `^0.1.5-rc.1`（rc 之间可互换），
  0.1.7 的 peer 改为精确值（如 `"@deepseek-ai/dsh-agent": "0.1.7-rc.1"`，无 `^`）。
  本插件随之精确锚定到 `0.1.7-rc.1`（含 `cordis ~4.0.4` 与 0.1.7 新增的 peer 集），
  **不能再跨 rc 混用**。
- **注入消息改用生产者自有 kind。** dsh 0.1.7 移除了共享的 catch-all `plugin` kind，且
  **session 格式 v4 直接拒绝** `kind: 'plugin'`（源码注释：*refuses retired plugin
  wrappers*）。旧实现在 0.1.7 上会导致 `SessionFormatError: format v4 message requires a
  producer-owned source kind`，表现为**记忆召回静默失效**（消息无法落盘）。
  现按官方范例（`dsh-tools` 的 `tool-registry`）在 `src/message-source.ts` 做
  module augmentation 声明自有 kind `'dsh-memory'`，并交叉 `ContextFormed` 以保留
  `form: 'notice'` + `summary`（渲染层靠这对字段把召回包折叠成一行 notice）。
- `agent/created` 处理器显式标注返回 `undefined`：0.1.7 把该处理器的返回类型收窄为
  `Promise<undefined> | undefined`，裸 `void` 不再通过类型检查。

### Fixed

- **`isMemoryMessage` 同时识别两代消息形状**（`{kind:'dsh-memory'}` 与旧
  `{kind:'plugin', plugin:'dsh-memory'}`）。迁移前的会话日志里存的是旧形状，
  只认新形状会把**旧召回包当成查询文本再次摄入**，使记忆库**自我强化**。
  为该语义补了断言：新形状 ✓、旧形状 ✓、仅 `plugin` 无 `kind` ✗、他人 kind ✗。

### Added

- `UPGRADE.md`：跨宿主版本的升级指引与版本轴速查表，并随包发布
  （`package.json` 的 `files` 已加入）。
- `src/message-source.ts`：自有 source kind 的声明模块。
- 测试：`buildQuery` 的跳过逻辑补一条**新形状**用例，确保两代形状都不会被当作查询文本。

## [0.3.0] — 2026-09-30

一轮针对"自评 17 项劣势"的全面优化。三大主题：学习质量、门禁可用性、安全与运维。

### Added

- **pending 按「被使用」晋升**（`promoteByUse`）：蒸馏候选进 pending 是设计（§7 未审核不当事实），
  但此前没有出口——本机实测淤积到 55/94。现在：`times_recalled ≥ learn.promoteAfterRecalls`（默认 3）
  且 `成功/(成功+失败) ≥ learn.promoteMinSuccessRatio`（默认 0.5）→ 升为 active，由惰性巩固执行并报告。
  **真实语料实测：pending 38 → 33、active 56 → 61**（晋升的 5 条均有明确使用证据）。
- **门禁可用性**：`eval.autoFreezeBaseline`（默认 false）+ `eval.proposeFreezeAfterTasks`（默认 5）。
  未冻结基线时，`memory_stats` 明确给出可复制的冻结命令与"还差多少任务指标"（此前只能输出 UNKNOWN）。
- **晋升闭环被消费**：`memory_consolidate({ acceptProposal })` 真正把技能草稿落到
  `~/.dsh/skills/<name>/SKILL.md`（人工审批保留；覆盖需 `overwrite`；技能名限 `[a-z0-9-]`）。
- **批量遗忘**：`memory_forget` 支持 `query` / `layer` / `olderThanDays`，**默认 dry-run**（先列清单再执行）。
- **跨进程协调**：导出+提交加文件锁（`git.lockTimeoutMs`，陈旧锁可抢占），解决 nvim-tui 与 web
  同时写同一记忆根的隐患。
- **版本化诊断**：仓库忽略 `.dsh/` 时明确告警"记忆未纳入 git（无克隆重建、无归档恢复）"——
  该承诺此前是静默失效的。
- **健康度行**：每个记忆根每进程一次，输出记录分布与 pending 占比（≥50% 给出处置提示）。
- **CI**：GitHub Actions（Node 22.19 / 24 矩阵跑 `typecheck` + 全量测试）。
- **L5 写入通道**：`memory_save({ layer: 'profile', profileFile })` 可写 `conventions.md` 等命名文件。

### Changed

- **归因按时序定位**（`applyOutcome(..., { maxStep })`）：过去"本轮失败"会把该轮所有注入记为失败，
  包括失败之后才注入、模型根本没看到的记忆；现在以最早失败信号的 step 为高水位。
- **召回查询改为最新优先**：此前按到达顺序取前 2000 字符，长回合会被最早说的话主导。
- 脱敏补 **JWT** 与**高熵长串**启发式（保留 git SHA 与普通标识符）。
- 每个配置旋钮都写进随包发布的 `cordis.patch.yml` 注释；`.gitignore` 排除其它插件的运行数据。

### Verified

- `npm test` **211 例全绿**（本轮新增 27 例）；`tsc` 零错误。
- **真机验证**（宿主 dsh 0.2.0-rc.2，nvim-tui e2e，人为构造一个忽略 `.dsh/` 的仓库）：
  ```
  memory: /private/tmp/…/.dsh/memory is git-ignored in this repository — project memory is machine-local …
  memory: global store — 94 records (39 active / 55 pending), 59% pending — mostly unvetted candidates: …
  memory: injected 4 record(s) (~598 tok) …  → 模型据 memory_stats 回答"积累 5 个任务指标后可冻结基线"
  ```
- 真实语料上的晋升演练（复制真实库）：dry-run 零改动，正式巩固只晋升 5 条"被用过"的记录。

### Notes

- 仍未做的事：ANN 索引（数万条规模才需要）、文本视图只存证据的"类型×次数"而非细节（刻意取舍，
  避免把原始输出推进 git）、以及多宿主并发下的会话级覆盖不持久（`memory_config` 仅当次进程有效）。
- 已准备好但**未发布 tag**：v0.3.0 待明确指示后打标签。

## [0.2.3] — 2026-09-30

### Changed

- **适配 dsh `0.2.0-rc.2`**：peerDependencies / devDependencies 精确锚定 `0.2.0-rc.1` → `0.2.0-rc.2`。
- **新增来源类型的刻意处理**：rc.2 给 `MessageSourceMap` 增加了 `user-question-reply`
  （问题工具的作答，载荷是 `callId` + `outcome` 的结构化结果）。其文本是"选项 token"而非用户的
  任务陈述，因此**不再参与召回查询**（`NON_TASK_SOURCES` / `isTaskBearing`）：否则一个光秃秃的
  `B` 会稀释由真实任务文本构造的查询。消息内容本身不受影响，仍完整落在会话里。

### Verified

- `0.2.0-rc.1` → `0.2.0-rc.2` API 面逐包比对：五个直接依赖**只差 package.json 版本号**；
  `dsh-llm/lib/typert.host.js` 的 2 行差异即上面那个新增来源类型（生成的类型注册表）。
  → 除该来源类型外**无 API 变化**。
- **真机验证**（宿主 0.2.0-rc.2，nvim-tui e2e）：插件未被 peer 门禁跳过、
  `memory: ready`、94 条真实语料引导导入、**自动召回注入 4 条 / 572 tok**（即 rc.2 的会话格式
  仍接受本插件自定义的 `source.kind = 'dsh-memory'`）、模型调用 `memory_search` 命中 7 条、
  会话指标落账。
- `npm test` 179 例全绿（召回查询用例新增"结构化来源不参与查询"的断言）。

### Notes

- 同 profile 的 `dsh-chat-interaction@0.1.8` 仍被门禁跳过：它声明的是
  `^0.1.5-rc.1 || ^0.1.7-rc.1 || ^0.1.7-rc.2`，未覆盖 `0.2.x`。
- 未打 tag（按约定：版本发布等待明确指示）。

## [0.2.2] — 2026-09-29

### Changed

- **适配 dsh `0.2.0-rc.1`**：peerDependencies / devDependencies 由 `0.1.7-rc.2` 精确锚定升级为
  `0.2.0-rc.1`（rc.2 起的 peer 门禁会**跳过**锚定不符的 bundle，不升级即等于插件不加载）。
  **无需改代码**：本版本只改锚定与文档。

### Verified

- `0.1.7-rc.2` → `0.2.0-rc.1` API 面逐包比对（解包 tarball 做差异）：
  `dsh-llm` / `dsh-tools` / `dsh-system-prompt` / `dsh-agent` **只差 package.json 版本号**；
  `dsh-session` 唯一实质变化是**新增导出** `ToolCallRecovery`（中断工具调用修复）与
  `lib/index.js` 的相应接线。全部为新增，无破坏性变更。
- `tsc` 对 0.2.0-rc.1 类型零错误；`npm test` 179 例全绿（含 peer 锚定守卫）。
- **真机验证**（宿主 0.2.0-rc.1，nvim-tui e2e）：插件未被 peer 门禁跳过、93 条真实语料引导导入、
  自动召回注入 4 条 / 583 tok、模型连续调用 `memory_search`（命中 8 条）与 `memory_stats`
  （93 条 / active 38 / pending 55 / 门禁 verdict UNKNOWN）、会话指标落账。

### Notes

- 同 profile 的 `dsh-chat-interaction@0.1.6` 在该宿主下被门禁跳过（其 peer 声明为
  `^0.1.5-rc.1 || ^0.1.7-rc.1`，未覆盖 0.2.x）。需要它的话要么升到声明 0.2.x 的版本，
  要么 `dsh plugin allow-version` 显式豁免。
- 观察（非本版本问题）：本机记忆库 93 条里 **pending 55 条**——蒸馏产物按设计进 pending（§7 仅提示），
  但除"复现提升"外没有自动晋升通道，长期会让 pending 占比偏高。召回不受影响（active+pending 都可搜），
  但值得后续做一次"复现 N 次后自动晋升"或把 pending 纳入巩固的晋升候选。

## [0.2.1] — 2026-09-28

### Changed

- **适配 dsh `0.1.7-rc.2`**：peerDependencies / devDependencies 由 `0.1.7-rc.1` 精确锚定升级为
  `0.1.7-rc.2`。

### Verified

- rc.1 → rc.2 的 API 面**逐包比对**（解包两个版本的 tarball 做差异）：`dsh-llm` 新增
  `projectToolUpdates()` / `ProjectedToolUpdates`；`dsh-tools` 的工具定义新增可选 `displayReason`
  （`PreToolDecision.ask` 的本地化审批文案，本插件不产出该决策，故不适用）；`dsh-session` 新增
  `toolHistory()` 与 `ToolHistory` 投影；`dsh-system-prompt` / `dsh-agent` 无 API 变化。
  **全部为新增，无破坏性变更**，本插件无需改代码。
- `tsc` 对 rc.2 类型零错误；`npm test` 178 例全绿。
- **真机验证**（宿主 dsh 0.1.7-rc.2，nvim-tui 官方 e2e 模式）：插件加载且**未被执行器跳过**，
  91 条真实语料引导导入、自动召回注入（3–4 条 / 482–590 tok）、模型真实调用 `memory_search`
  命中教训、轮次与会话收尾自动提交。

### Notes

- rc.2 新增 **peer 版本强制校验**：peer 与运行时版本不符的 bundle 会被加载器**跳过**并在启动时告警
  （可用 `dsh plugin allow-version` 显式豁免）。本插件因本次锚定升级而正常加载；同 profile 中仍锚定
  rc.1 的三个插件（`dsh-role-guard` / `dsh-spec-gate` / `dsh-test-design-gate`）在该版本下被跳过。
  新增测试 `peer anchors track the installed dsh runtime` 用于在本地捕获"升级 dsh 后忘记改锚"。
- rc.2 起默认模型改为条目配置（`agent-default-model`），不再读取全局 `settings.yaml`；
  若网关不提供内置默认模型 `deepseek-flash`，需在 profile patch 里覆盖（本机配置见
  `docs/RELEASE.md`「默认模型」一节）。

## [0.1.1] — 2026-09-17

### Fixed

- **发布阻断：`cordis.patch.yml` 缩进错误导致安装后无法启动**。新增配置项时注释块插错了层级，
  `consolidate.usageRetentionDays` / `semantic` 掉到了 `insert:` 条目级（被 loader 静默忽略），
  紧随其后的键缩进错位使 YAML 解析直接失败：

  ```
  dsh: failed to parse overlay …/cordis.patch.yml: YAMLException:
       bad indentation of a mapping entry (38:21)
  ```

  即 `v0.1.0` **不可安装**（打 tag 后从 GitHub 安装时才发现，本地测试从不解析这个文件）。
  现已修正结构并补齐此前丢失的 `sqlite.fallback` / `sqlite.maxOpenRoots` /
  `prompt.indexSummary.profileBudgetTokens`。

  处理方式：**删除并重建了 `v0.1.0` tag**（在维护分支 `release/v0.1.0` 上，只带该修复、版本号不变），
  main 分支的实现随本版本发布。两个 tag 现均验证可安装。

### Added

- `test/patch.test.ts`：用真实 YAML 解析器校验随包发布的 `cordis.patch.yml`——
  ① 能解析且结构正确（条目级只允许 `insert`/`config`，避免键掉层级被静默忽略）；
  ② 声明的每个配置键都存在于解析后的配置中（拼写错误/放错区块当场失败）；
  ③ 新旋钮确实随包发布。此类回归从此在 `npm test` 就会暴露，而不是等到安装时。

## [0.1.0] — 2026-09-14

> 该版本最初打出的 tag 带有一个发布阻断问题（`cordis.patch.yml` 缩进错误，安装后无法启动）。
> **该 tag 已删除并在维护分支 [`release/v0.1.0`](https://github.com/kovey/dsh-memory/tree/release/v0.1.0)
> 上重建**（提交 `1c9a8c1`：内容与 0.1.0 一致，仅含该修复，版本号仍为 0.1.0），
> 现已验证可安装、可启动。需要 v0.1.1 的新增修复请用 v0.1.1。

首个发布版本。分层记忆（5+1 层）+ 严格的项目/全局双库隔离 + 任务前自动召回 + 任务后持续学习。

### Added

- **分层记忆模型**：L0 工作记忆、L1 情节（JSONL 落盘）、L2 项目语义、L3 全局语义、L4 程序性（技能）、
  L5 身份/偏好；外加评估用的元层（基线快照 + 指标台账），层间有晋升与降级通道。
- **双库物理隔离**：项目记忆只写 `<repo>/.dsh/memory`，全局记忆只写 `~/.dsh/memory`；
  跨作用域写入被守卫硬阻断（`assertDraftScope` / `assertInsideScope`），项目记忆永不回落到全局。
- **三级召回**：① 常驻段（协议 + 索引摘要 + L5 偏好，逐行裁剪）；② `agent/pre-step` 自动召回
  （按本轮用户消息检索，注入为 plugin-source 消息）；③ 模型按需调用工具。中文用 CJK bigram 索引，
  中英粘连词（`npm包`/`git仓库`）按 ASCII 段前缀 + CJK 段 bigram 查询。
- **持续学习闭环**：工具失败/用户纠正/返工信号 → L1 情节 → 有界蒸馏（日预算 200k tok、每会话 3 次、
  超时与取消可中断）→ 门控（去重合并、证据分级、置信度封顶）→ 落库。
- **质量工序**：衰减、过期归档（归档≠删除）、矛盾检测与消解、晋升提案；每日/每 N 任务惰性巩固，
  并在同一趟里执行保留策略清理（episodic 90 天、usage 180 天、旧模型向量 30 天宽限）。
- **召回后的负反馈**：注入记账（usage）→ 轮次结果归因 → 反复失败的记忆下调置信度（跨库归因）。
- **评估门禁**：四项指标（成功率 / 耗时 / 打扰 / 返工）与冻结基线对比，三态 `pass / regression / unknown`；
  冻结基线需理由参数 + 审计日志，子代理不可执行。
- **文本视图即 SSOT**：`lessons/*.md`、`MEMORY.md`、`profile/`、`metrics.jsonl` 进 Git；
  SQLite 是派生索引，可由文本视图完整重建（`memory_reindex({ rebuild: true })` 保留不可再生的 sidecar 数据）。
- **Git 化同步**：路径作用域的 add/commit、冲突按规则合并（多冲突块安全）、rebase 冲突端到端可用；
  **绝不自动 push**。
- **语义召回（可选，默认关）**：OpenAI 兼容 `/embeddings` + 混合排序；增量向量缓存（按内容哈希）、
  维度校验、整轮预算、失败静默降级为词法。本机已实测 bge-m3（见下）。
- **蒸馏运行器**：`inline`（默认，有界 await）与 `jobs`（交给 `ctx.jobs`，轮次立即结束）+
  **补蒸馏**机制：作业被取消或进程中断的信号会在下一会话首轮以 inline 补跑，教训不丢。
- **11 个工具**：`memory_save` / `memory_search` / `memory_recall` / `memory_get` / `memory_stats` /
  `memory_forget` / `memory_consolidate` / `memory_sync` / `memory_reindex` / `memory_config`（会话级降噪）/
  `memory_import`（外部 lesson 导入）。
- **子代理写保护**：写类工具统一拒绝子代理会话（可由 `routing.subagentWrite` 打开）。
- **会话级工具输出预算**：单次工具与**会话累计**双重上限，防止模型循环调用填满自身上下文。

### Fixed

一次全面代码审查（59 条发现，记录于 [`docs/REVIEW-2026-09-14.md`](docs/REVIEW-2026-09-14.md)）后的修复，
其中影响最大的一批：

- **数据丢失 / 静默损坏**：重建不再把归档记录当孤儿删除、导出不再剪除兜底脚本写的教训、
  写失败不再连带删除旧文件、采纳只插缺失 id、slug 撞车不再整条覆盖、sync 冲突路径不再写到作用域外
  或把冲突标记提交进记忆仓、重建不再清空只有库内才有的信号。
- **学习正确性**：失败判定只对命令执行类工具生效（避免把"文档里提到错误串"当成失败）、
  疼痛信号不再记到过期轮次、合并取更高置信度且正文取更新、蒸馏产物以 pending 入库、
  负反馈真正接到归因路径。
- **召回正确性**：中英粘连词查询从 0 命中修好、会话幂等去重不再挤掉新命中、包级 token 预算真正成立、
  跨作用域同名 id 不再错标归属。
- **接线**：`scope: 'global'` 不再等价于 `all`、`distillTimeoutMs` 上限不再小于默认值、
  任务指标自动入账、90 天保留策略真正执行、`job.cancel()` 真正取消 LLM 调用。
- **打包**：构建产物随仓库入库（`dist/`），`github:` 安装免构建可用；`prepack` 保证 pack/publish 产物为最新；
  peerDependencies 带版本范围、devDependencies 含 peer（干净 clone 可自行构建）。

### Verified

三轮真实宿主验证（nvim-tui 官方 e2e 模式 / headless / web，隔离记忆根）：

- 插件加载、能力探测、真实语料引导导入、首轮自动召回注入（实测 55 次注入：中位 234 tok、最大 592 tok，
  上限 600）；
- 真实模型调用工具链（`memory_search` → `memory_save` → `memory_stats`）；
- 完整学习飞轮：失败命令 → 信号 → 蒸馏（真实 flash 模型）→ 门控 → 导出 → 自动提交；
- 本地 bge-m3 语义召回对照实验（19 条真实教训）：Top-3 8/9 → 9/9、改写问法 5/6 → 6/6，
  代价 +33ms 与 +35% 注入 token；CJK 修复后词法基线升到 7/9，语义边际收益归零（默认保持关闭）；
- 从 GitHub 安装并启动（`dsh plugin add github:kovey/dsh-memory`）。

### Known limits

- **语义召回需要真实的 embedding 端点**：本机网关没有 embedding 通道，需另接（如本地 Ollama + bge-m3）。
- **ANN 索引未实现**：当前为内存内全量余弦，数万条规模以内足够。
- **归档不等于删除**：记录只增不减是刻意的取舍（教训不丢），检索质量由合并阈值与巩固提案控制。
- 库中已存在的历史重复 id 不会自动删除（import 只保证不再新增），需要显式 dedupe。
- `tui` 等生产面只消费发布版本（tag/NPM），不走本地 link。

[0.3.0]: https://github.com/kovey/dsh-memory/releases/tag/v0.3.0
[0.2.3]: https://github.com/kovey/dsh-memory/releases/tag/v0.2.3
[0.2.2]: https://github.com/kovey/dsh-memory/releases/tag/v0.2.2
[0.2.1]: https://github.com/kovey/dsh-memory/releases/tag/v0.2.1
[0.1.1]: https://github.com/kovey/dsh-memory/releases/tag/v0.1.1
[0.1.0]: https://github.com/kovey/dsh-memory/releases/tag/v0.1.0
