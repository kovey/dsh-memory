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

[0.2.1]: https://github.com/kovey/dsh-memory/releases/tag/v0.2.1
[0.1.1]: https://github.com/kovey/dsh-memory/releases/tag/v0.1.1
[0.1.0]: https://github.com/kovey/dsh-memory/releases/tag/v0.1.0
