# dsh-memory — 设计文档（v3 定稿）

> 分层记忆插件：**严格分离的项目级/全局记忆** + **宿主驱动的任务前召回** + **任务后持续学习**。
> 本文件是设计与决策的唯一存档（decision of record）。实现按 §11 的 M0–M5 逐步推进。

- 状态：定稿，实施中（M0 起）
- 载体：DeepSeek Harness（dsh）host 插件，TypeScript / ESM / cordis v4
- 仓库：`/Users/zhangyong/workspace/deepseek/dsh-memory`（本地 git，remote 后续再加）

---

## 1. 目标与范围

| # | 要求 | 本设计的回答 |
|---|---|---|
| 1 | TypeScript 实现 | 纯 TS + ESM，`tsc` 构建到 `lib/`，零运行期第三方依赖 |
| 2 | 管理全局 + 项目级记忆 | 双库（SQLite）+ 双目录，**物理隔离**，见 §5 |
| 3 | agent 持续学习、不断变强 | 学习飞轮 + 可测量回归门禁，见 §7、§11 M5 |
| 4 | 实现优雅；分层记忆是否更好 | 是；5+1 层，按"召回时机/生命周期/写入者"分层，层间有晋升与降级通道，见 §3 |
| 5 | 任务前读记忆、任务后触发学习、提高记忆质量 | §6 三级召回 + §7 学习闭环 + §8 质量工序 |
| 6 | 先方案后代码 | 本文件；代码按 M0–M5 逐步落地 |

**不在范围内**：跨机器实时同步（git 化提供最终一致性即可）、向量数据库服务化、会话原文全量归档。

---

## 2. 设计原则（不变量）

1. **单一真相源（SSOT）**：运行期以 SQLite 为 SSOT，Git 跟踪的文本视图（`lessons/*.md`、`MEMORY.md`、`metrics.jsonl`）是**单向导出**；任意时刻可用 `memory_import --rebuild` 从文本视图完整重建 DB。
2. **项目级 / 全局物理隔离**：两套目录、两个数据库文件，**跨库写入硬阻断**；项目级学习只落 `<repo>/.dsh/memory`。
3. **项目记忆绝不回退全局**：任何项目级写入前做路径守卫断言；解析不到项目上下文时写全局并标记 `origin='no-project-context'`（与既有教训"多项目授权零全局回退"同构）。
4. **模型可见 ⟺ 已记录**：一切注入走 logged channel（`systemPrompt.section` / plugin-source `UserMessage`），不使用不可见侧信道。
5. **插件故障不伤宿主**：所有钩子整体 try/catch；任何降级都写日志且在 `memory_stats` 可见；写失败落 `.queue/` 待重放。
6. **默认保守、全程可关**：每个自动行为都有配置开关与预算；默认值取"宁可少做"。
7. **不偷偷花钱**：唯一的 LLM 路径（自动蒸馏）受严格触发条件、日预算、超时与人审晋升约束。
8. **文本视图可 diff**：进 Git 的永远是文本；二进制 DB 永不进版本库。

---

## 3. 分层记忆模型

| 层 | 名称 | 物理位置 | 生命周期 | 写入者 | 读取时机 |
|---|---|---|---|---|---|
| **L0** | 工作记忆 | 插件进程内存 | 单 step | 插件 | 不注入（用于去重与预算） |
| **L1** | 情节记忆 episodic | `<repo>/.dsh/memory/sessions/*.jsonl` + `signals` 表 | 90 天 → 压缩为摘要 | 插件（零 LLM） | 按需（作为教训的证据） |
| **L2** | 项目语义记忆 | `<repo>/.dsh/memory/lessons/*.md` | 长期 | 宿主蒸馏 + 门控 | **每任务必召回**（索引常驻） |
| **L3** | 全局语义记忆 | `~/.dsh/memory/lessons/*.md` | 长期 | 宿主蒸馏 + 门控 | **关键词命中才召回** |
| **L4** | 程序性记忆 | `~/.dsh/skills/*`、`<repo>/.dsh/{scripts,agents}` | 长期 | **人审后**晋升 | 技能系统原生加载 |
| **L5** | 身份/偏好记忆 | `~/.dsh/memory/profile/*.md` | permanent | 人工 / 确认后 | 系统提示常驻（≤200 tok） |
| **M** | 元层（评估） | `baseline.md` + `metrics.jsonl` | 永久 | 插件自动 | 回归门禁与调参 |

**分层理由**：三层语义/情节记忆的**召回成本模型完全不同**（必召回 / 命中召回 / 技能加载），混池必然导致全量注入与上下文膨胀。层数收敛在 5+1：每多一层就多一次"该写哪"的路由判断，而路由歧义是幻觉记忆的主要来源。

**晋升 / 降级通道**（分层的真正价值）：

```
L0 观察到 → L1 信号落盘 → 蒸馏 → L2/L3 教训
                                   │  times_seen ≥ 3 且 conf ≥ 0.9
                                   ▼
                                 L4 技能 / 项目约定（必须人审）
L2/L3 ── 过期 or 低命中 ──► archive/（归档，不物理删除，可回查）
```

**归属判定（写入路由）**：

1. 与当前项目有关 → **项目级**（默认）。
2. 仅当是**跨项目工具链事实**（harness/插件行为、沙箱机制、LLM 通用习性、通用脚本）→ 全局。
3. 拿不准 → 项目级。
4. 无项目上下文（无 git 仓库）→ 全局 + `origin='no-project-context'`。

---

## 4. 总体架构：B 方案（宿主驱动钩子为主，技能降级为兜底）

```
                        模型面（全部可审计）
       systemPrompt.section ── 协议段(≈120tok, 可关) + L2 索引摘要(≈150tok)
       tools ── memory_recall / search / get / save / forget /
                stats / consolidate / sync / import / reindex
                                   ▲
        ┌──────────────────────────┴───────────────────────────┐
        │             dsh-memory 插件（宿主，三端同构）           │
        │  钩子主链（自动，零 LLM 除蒸馏）:                        │
        │   session/created    → 解析 repo、开库、惰性巩固检查     │
        │   agent/pre-step     → 阈值召回 + 预算裁剪 + 幂等注入    │
        │   agent/request-error / 工具结果 → 疼痛信号采集          │
        │   agent/turn-stopping → 有界蒸馏(仅疼痛 turn) + 门控落库 │
        │   turn/end, session/flush → 指标入账 + 导出 + commit     │
        │  scope/resolver · store/sqlite(FTS5,WAL) · store/guard   │
        └───────┬──────────────────────────────────┬────────────┘
                ▼                                  ▼
        ~/.dsh/memory/  (git repo)         <repo>/.dsh/memory/  (随项目 git)
        L3 + L5 + archive + db             L2 + L1 + archive + db
                                                    ▲
   兜底路径（仅这三类）：插件不可用 / pending 积压 / 用户显式要求
        → 技能 auto-retrospective · memory-merge
```

### 4.1 职责重排（B 方案相对技能驱动方案的差异）

| 能力 | 技能驱动（A） | **钩子驱动（B，本设计）** |
|---|---|---|
| 任务前召回 | 模型记得去查 | 宿主自动（section + pre-step） |
| 教训蒸馏 | 模型跑技能 | 宿主自动（turn-stopping → 有界 LLM 蒸馏） |
| 写入门控/合并 | 技能调用时判 | 宿主自动（蒸馏产物直接过闸） |
| 指标入账 | 技能手动调脚本 | 宿主自动（turn/end + session/flush） |
| 导出 + git commit | 手动 | 宿主自动（写后导出，task-end 本地提交） |
| 周期巩固 | 用户手动 | 宿主惰性触发（每 5 次任务或 7 天） |
| 技能角色 | 主路径 | 兜底（插件不可用 / pending 积压 / 用户显式要求） |

### 4.2 B 方案的代价与控制

| 风险 | 控制 |
|---|---|
| 隐式行为不可见 | 每个自动动作有日志 + 开关 + 预算；`memory_stats` 暴露 pending 积压、蒸馏失败率、超时率、注入条数与 token |
| LLM 成本失控 | 仅疼痛 turn 触发 + `maxDistillPerSession=3` + `maxDistillTokensPerDay=200k` + 超时放弃 + 固定 `deepseek-v4-flash` |
| 阻塞关轮 | `turn-stopping` 内有界 await（默认 15s）；超时即落 pending 交兜底 |
| 上下文膨胀 | 阈值门 + 预算（默认 600 tok）+ 会话内幂等（同条只注入一次） |
| 审计不变量被破坏 | 注入只走 logged channel |
| 静默降级 | 降级必写日志 + stats 可见 + `.queue/` 可重放 |
| 过度自动化惹人烦 | `memory_config` 会话内降噪 + 全局 `enabled:false` |

---

## 5. 存储设计

### 5.1 双库布局（落实"项目级 / 全局物理隔离"）

```
~/.dsh/memory/                        # 全局记忆根（独立 git repo）
├── memory.db                         # 全局库：L3 + L5 + archive + usage + tasks + project_registry
├── MEMORY.md                         # 索引（文本视图，导出）
├── baseline.md                       # 评估基线（只读，不自动改）
├── metrics.jsonl                     # 任务指标（文本视图，导出）
├── lessons/<slug>.md                 # L3 教训（文本视图，导出）
├── profile/{preferences,conventions}.md   # L5
├── archive/lessons/<slug>.md         # 归档（不物理删除）
├── sessions/                         # 全局情节（无项目上下文时）
└── .queue/                           # 沙箱拒写时的降级队列

<repo>/.dsh/memory/                   # 项目记忆根（随项目 repo）
├── memory.db                         # 项目库：L2 + L1 + archive + usage + tasks
├── MEMORY.md · lessons/ · archive/   # 文本视图
├── sessions/                         # L1 情节（jsonl）
├── metrics.jsonl                     # 项目指标
└── .queue/
```

进 Git 的：`lessons/`、`MEMORY.md`、`profile/`、`metrics.jsonl`、`archive/`、`baseline.md`。
不进 Git 的（`.gitignore` 由插件写入）：`memory.db*`、`sessions/`、`.queue/`。

### 5.2 SQLite

- 驱动：**`node:sqlite`（实测 Node v24.18.0 可用、无 ExperimentalWarning）**；启动做能力探测（驱动可用 + FTS5 可用），不可用时打印清晰指引并降级 JSON 后端（保留 `IndexBackend` 接口）。
- 引擎参数：`journal_mode=WAL`、`busy_timeout=5000`、`synchronous=NORMAL`、`foreign_keys=ON`。
- 并发模型：**每 repo 单连接 + 写队列串行化**；`session/disposed` 时按 LRU 释放。

表结构（schema v1）：

```sql
meta(key TEXT PRIMARY KEY, value TEXT)                    -- schema_version 等

records(
  id TEXT PRIMARY KEY,                 -- 稳定 slug（沿用 memory-lesson.sh 规则）
  layer TEXT NOT NULL,                 -- project | global | profile | episodic
  scope_kind TEXT NOT NULL,            -- project | global
  repo TEXT,                           -- scope_kind=project 时的仓库根
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',     -- JSON 数组
  confidence REAL NOT NULL,            -- 0..1
  expires_at TEXT,                     -- NULL = permanent
  times_seen INTEGER NOT NULL DEFAULT 1,
  times_recalled INTEGER NOT NULL DEFAULT 0,
  success_after_recall INTEGER NOT NULL DEFAULT 0,
  fail_after_recall INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active | pending | archived
  origin TEXT,                         -- distilled | user | skill | imported | no-project-context
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  source TEXT                          -- JSON {sessionId, turn, taskId}
);
CREATE VIRTUAL TABLE records_fts USING fts5(
  title, body, tags, content='records', content_rowid=rowid, tokenize='unicode61'
);  -- + INSERT/UPDATE/DELETE 触发器同步

evidence(id INTEGER PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
         kind TEXT NOT NULL, detail TEXT, turn INTEGER, at TEXT NOT NULL);

usage(id INTEGER PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      session_id TEXT, turn INTEGER, step INTEGER, score REAL,
      injected_at TEXT NOT NULL, outcome TEXT);           -- 召回记账 + 成败回填

signals(id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, turn INTEGER, step INTEGER,
        kind TEXT NOT NULL, tool TEXT, detail TEXT, at TEXT NOT NULL);   -- L1 结构化情节

tasks(task_id TEXT PRIMARY KEY, date TEXT, project TEXT, summary TEXT, outcome TEXT,
      duration_min REAL, disturb_count INTEGER, rework_rounds INTEGER,
      lessons INTEGER, tokens INTEGER);

distill(id INTEGER PRIMARY KEY, session_id TEXT, turn INTEGER, model TEXT,
        prompt_hash TEXT, tokens_in INTEGER, tokens_out INTEGER,
        created_count INTEGER, timed_out INTEGER, at TEXT NOT NULL);     -- 蒸馏审计

conflicts(id INTEGER PRIMARY KEY, winner_id TEXT, loser_id TEXT, reason TEXT, at TEXT NOT NULL);
```

全局库额外一张 `project_registry(repo_path TEXT PRIMARY KEY, last_seen TEXT, lesson_count INTEGER)`——**只存统计与路径，不含任何项目记忆内容**。

### 5.3 文本视图（Git 载体）

- 写操作后**单向导出**：`lessons/<slug>.md`（frontmatter 保持 `title/confidence/expires/times_seen/updated` 五字段原样，新增字段追加，旧脚本仍可读）、`MEMORY.md`、`metrics.jsonl`。
- **重建**：`memory_import --rebuild` 清空并重建 DB（保留 usage/signals 等本地不可再生数据到一个 sidecar 表后恢复）；用于换机器、clone 后恢复、索引损坏自愈。
- **引导导入**：DB 为空时自动从文本视图导入（`bootstrap import`），因此 M0 无需任何手工迁移脚本。
- 旧脚本（`memory-lesson.sh`）写出的 MD：下次 import 时增量并入（降级路径永远可用）。

---

## 6. 召回设计：三级渐进披露

| 级别 | 扩展点 | 内容 | 预算 | 频率 |
|---|---|---|---|---|
| ① 常驻 | `ctx.systemPrompt.section()` | 记忆协议（何时查/何时存）+ L2 索引摘要（条数 + 最近 N 条标题）+ L5 偏好 | ≤240 + 150 tok（逐行裁剪） | 每次装配 |
| ② 自动召回 | `agent/pre-step`（首个 step） | 按本轮用户消息构造 query，取 top-K 教训正文，作为 plugin-source UserMessage 注入 | 600 tok | 每轮 1 次 |
| ③ 按需 | `memory_search` / `memory_get` / `memory_recall` | 模型主动深挖 | 模型自付 | 模型决定 |

**排序打分**：

```
score = bm25_norm(title, body, tags)            # FTS5 bm25，归一化
      × (0.5 + 0.5·confidence)                  # 置信度
      × freshness(updated_at)                   # 新鲜度衰减
      × layerWeight(project 1.0 / global 0.85 / profile 0.95)
      × (1 + 0.05·min(times_recalled, 10))      # 历史命中
      × usageBoost(success_after_recall, fail_after_recall)
```

四条硬约束：**阈值门**（`minScore`，低分不注入）、**预算截断**（超出部分提示"还有 N 条可用 memory_search"）、**会话内幂等**（`sessionId+recordId` 去重集合）、**可审计**（`usage` 表记账）。

召回顺序：项目 lessons（全量索引常驻）→ 全局（关键词命中）→ L5 偏好（常驻）→ 需要证据时才读项目 signals。

---

## 7. 学习闭环（持续学习飞轮）

```
        ┌───────────── 召回 Recall ─────────────┐
        │  L2/L3/L5 → 注入 → usage 记账          │
        ▼                                       │
   执行 Act ──► 观察 Observe（客观信号）          │
        │        tool-failure / request-error   │
        │        user-correction / rework /     │
        │        permission-prompt / test-fail  │
        ▼                                       │
   蒸馏 Distill（宿主，仅疼痛 turn，有界）          │
        ▼                                       │
   门控 Gate（去重/合并/矛盾/拒收/降 pending）      │
        ▼                                       │
   巩固 Consolidate（置信度更新 + TTL 衰减）────────┘
        ▼
   晋升 Promote（times_seen≥3 且 conf≥0.9 → 技能，需人审）
```

**触发时机 → 扩展点映射**：

| 时机 | 扩展点 | 动作 | LLM 成本 |
|---|---|---|---|
| 会话建立 | `session/created` | 解析项目根、开库、引导导入、惰性巩固检查 | 0 |
| 每轮首步 | `agent/pre-step` | 自动召回注入 | 0 |
| 工具/请求失败 | `agent/request-error`、工具结果观察 | 记疼痛信号 | 0 |
| 轮次收尾 | `agent/turn-stopping` | 汇总信号 → 有信号则有界蒸馏 → 门控落库 | **有界**（仅疼痛 turn） |
| 轮次/会话收尾 | `turn/end`、`session/flush` | 指标入账、usage 成败回填、导出、git commit | 0 |
| 周期 | 会话建立时惰性触发 | 过期归档 / 衰减 / 导出 / 提交；冲突与晋升出提案 | 0（提案需人审） |

**置信度更新（保守参数）**：

```
conf_next = clamp( conf_base
                 × (1 + 0.04·ln(1 + times_seen))
                 × (1 + 0.10·(succ − fail)/max(1, times_recalled))
                 × decay(age, ttl)                    # 半衰期后 ×0.9^k
                 , 0, 0.99 )
```

- `≥0.9` 已被证实 ≥1 次；`0.7–0.9` 观察到未复现；`<0.7` 假说，**只提示不执行**。
- **召回后任务失败 → 下调**：这是"变强"的负反馈；缺了它记忆只会越来越自信、越来越错。

**自动蒸馏护栏**：仅疼痛 turn 触发；`minSignals=1`；`maxDistillPerSession=3`；`maxDistillTokensPerDay=200000`；`distillTimeoutMs=15000`；固定便宜模型；输入为结构化信号摘要（≤1.5k tok，先 `redact()`）；输出严格 JSON（0–6 条教训 + evidence 引用 + 建议 confidence）；产物一律进 **pending 区**（`conf ≤ 0.6`）由门控裁决；全程写 `distill` 审计表。

---

## 8. 记忆质量工序

| 工序 | 判据 | 动作 |
|---|---|---|
| 写入门控 | 相似度 > 0.85 | 合并：`times_seen+1`、conf 取 max、正文取更新、evidence 合并 |
| | 结论相反 | 记 `conflicts`，标 `superseded_by`，索引记一笔 |
| | 无触发场景/无证据/泛泛而谈 | 拒收，或降为 pending（`conf ≤ 0.6`） |
| 证据加权 | 每条必须有 `evidence` | `self-report` 权重最低；`tool-failure`/`user-correction` 最高 |
| 使用反馈 | 召回后 outcome | 调整 conf 与排序权重（轻量 bandit） |
| 遗忘 | `expires < today`，或 `conf<0.6` 且 60 天未复现 | 移入 `archive/`（可回查） |
| 晋升 | `times_seen≥3` 且形成稳定流程 | **提案给人** → 落 `~/.dsh/skills/<name>/SKILL.md`，教训降为链接 |
| 防退化门禁 | baseline 7 任务 | 成功率不降、成本不升、打扰不升、返工不升 |

---

## 9. 插件工程

### 9.1 模块结构

```
src/
├── index.ts              # apply(ctx, config)：装配钩子/工具/服务 + ctx.effect 清理
├── config.ts             # schemastery 配置 schema + 默认值 + 归一化
├── log.ts                # 只写日志文件，绝不写 stdout
├── paths.ts              # 记忆根解析（全局/项目）、home 展开
├── scope/resolver.ts     # 会话 → repo 根（session.header.cwd → git-common-dir）
├── store/
│   ├── types.ts          # MemoryRecord / Layer / Scope / Evidence
│   ├── frontmatter.ts    # YAML frontmatter 读写（兼容 memory-lesson.sh）
│   ├── sqlite/{db,schema,migrate,records,search}.ts
│   ├── guard.ts          # 路径守卫 + 跨库写入阻断
│   ├── export.ts         # DB → MD/JSONL 文本视图
│   ├── import.ts         # 文本视图 → DB（引导导入 / --rebuild）
│   └── metrics.ts        # metrics.jsonl 读写
├── recall/{query,rank,budget,inject,usage}.ts
├── learn/{signals,gate,confidence,decay,distill,promote,consolidate}.ts
├── tools/{index,search,get,save,forget,recall,stats,consolidate,sync,import,config}.ts
└── sync/git.ts           # autoCommit / memory_sync / 冲突合并
```

### 9.2 装配与依赖

- `export const name = 'dsh-memory'`；`export const inject = ['tools','agents','systemPrompt','session']`。
- `apply(ctx, config)` 内所有注册用 `ctx.effect(() => dispose)` 收尾（cordis v4 不发 `dispose` 事件）。
- peerDependencies 只声明 `@deepseek-ai/*`；运行期零第三方依赖。
- 三端挂载走 **bundle 层**：各 profile 的 `package.json` → `dsh.profile.bundles` 加 `dsh-memory`；**profile patch 不得重复 insert `id: memory`**（loader 对重复 id 直接抛错）。

### 9.3 防御式约束

1. 每个钩子整体 try/catch，异常绝不冒泡到宿主会话。
2. 所有写入原子化（tmp + rename）；SQLite 写入串行化。
3. 全局路径写被沙箱拒绝 → 落 `<repo>/.dsh/memory/.queue/`，下次成功写入时重放。
4. 会话作用域按 `session.header.cwd` 解析，**不依赖进程 cwd**（三端可并发多仓库）。
5. 子代理会话（`header.origin==='subagent'` 或 `delegationDepth>0`）默认不写记忆，只回传信号。

---

## 10. 与既有资产的关系（零破坏）

| 现有资产 | 处理 |
|---|---|
| `~/.dsh/memory/{MEMORY.md,baseline.md,metrics.jsonl,lessons/*.md}` + 项目同名目录 | 原样保留并作为文本视图；DB 为空时引导导入 |
| `memory-lesson.sh` / `memory-task-log.sh` | 保留为降级路径；插件可用时技能改走工具 |
| 技能 `auto-retrospective` | 升级：先 `memory_search` 去重 → 蒸馏 → `memory_save(evidence)`；失败回落脚本 |
| 技能 `memory-merge` | 升级：`memory_consolidate(dryRun)` → 人审 → 执行 |
| `baseline.md` 指标定义 | 冻结，插件只读不改 |

---

## 11. 里程碑与验收

| 阶段 | 交付 | 验收标准 | 状态 |
|---|---|---|---|
| **M0 骨架 + 导入** | git init、TS 构建、SQLite schema/迁移、引导导入、只读工具（search/get/stats）、三端挂载 | 三端各起会话都能检索项目/全局条目；DB 可由文本视图重建一致；**零行为改变** | ✅ 已完成 |
| **M1 召回闭环** | 可开关常驻协议段 + 三级召回 + usage 记账 + `memory_recall` | 首步自动召回 <800 tok；同条不重复注入；关开关后无 section | ✅ 已完成 |
| **M2 学习闭环** | 信号采集 + L1 落盘 + 有界自动蒸馏 + 门控 + `memory_save` + 技能改造 | 一次真实任务：signals 落项目目录、lessons 自动 +N、重复被合并、指标入账 | ✅ 已完成（技能改造留待 M3） |
| **M3 质量工序** | 矛盾消解 / 衰减 / 归档 / 晋升提案 + `memory_consolidate` + `memory_forget` | 合并后条目下降、无矛盾残留、索引同步、备份可回滚 | ✅ 已完成 |
| **M4 git 化同步** | autoCommit(task-end) + `memory_sync` + 冲突合并 + `--rebuild` | 克隆目录重建后检索结果一致 | ✅ 已完成 |
| **M5 评估门禁** | baseline 7 任务回归 + `memory_stats` 趋势 + 可选语义检索 | 四项指标不退化 | ✅ 已完成（语义检索见 §15 未实现项） |

---

## 12. 风险与取舍

| 风险 | 对策 |
|---|---|
| 召回噪声膨胀上下文 | 三级披露 + 阈值 + 预算 + 幂等 |
| 自省不可靠 → 幻觉记忆 | evidence 强制、自省权重最低、`<0.7` 只提示、拒收泛泛条目 |
| 记忆越学越自信但越错 | 召回后失败必须下调置信度（负反馈闭环） |
| 多进程并发写（三端） | WAL + busy_timeout + 单库单连接写队列 + 原子导出 |
| `~/.dsh` 写被沙箱拒绝（已踩坑） | `.queue/` 降级 + 重放，不中断会话 |
| Node 22.19 的 `node:sqlite` 可能需 flag | 启动能力探测 + 清晰指引 + JSON 后端降级 |
| 与既有技能双写冲突 | 文本视图单向导出、DB 可重建；技能降级为兜底 |
| 自动 commit 噪音 | `task-end` 一次 + 30 分钟检查点 + `autoPush:false` |
| 分层过度设计 | 固定 5+1 层；新增层须过"召回时机/生命周期/写入者"三问 |

---

## 13. 决策记录（ADR）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 三端全挂（nvim-tui / web / headless） | 记忆是会话级基础设施，不是某端特性 |
| D2 | 常驻协议段**可配置开关**，开启则常驻 | 默认有用，但要允许零 token 模式 |
| D3 | 允许插件自动蒸馏（有界 + 预算 + 审计） | B 方案的核心增量；护栏抵消成本与噪声 |
| D4 | 直上 SQLite（`node:sqlite` + FTS5） | 实测可用；FTS5 免自研 BM25；WAL 支撑多进程 |
| D5 | L1 情节记忆落盘（结构化信号，默认脱敏） | 学习飞轮需要客观证据，但全文有隐私成本 |
| D6 | 记忆库 git 化；自动 commit（task-end），**push 永不自动** | 可 diff/可回滚；沿用"推送需明确指示"的既有教训 |
| D7 | 项目级 / 全局**物理隔离**，项目级学习只落项目目录 | 用户硬要求；杜绝跨项目污染 |
| D8 | 总体架构取 **B 方案**（宿主驱动钩子为主，技能兜底） | 学习不依赖"模型记得复盘"，用宿主保证闭环 |
| D9 | `~/.dsh/memory` 先本地 `git init`，remote 后续再加 | 先跑通闭环，同步后置 |

---

## 14. 附录

### 14.1 实测结论（本机 Node v24.18.0）

| 项 | 结果 |
|---|---|
| `node:sqlite` | 可用，无 ExperimentalWarning 输出 |
| FTS5 | 可用，`bm25()` 可排序 |
| WAL | 文件库 `journal_mode=wal` 生效 |
| SQLite 版本 | 3.53.1 |
| `Session.header.cwd` | 存在（创建期校验的绝对路径）→ 会话级作用域解析可行 |
| `ToolRunContext` | 含 `agent?`、`deferContext()`、`concludeTurn()` |

### 14.2 实现状态（M0–M5）

| 里程碑 | 状态 | 关键验证 |
|---|---|---|
| M0 骨架 + 导入 | ✅ | 真实 18 条 lessons 导入零漂移；三端 `--dump-config` 均见 `id: memory` |
| M1 召回闭环 | ✅ | 真实语料三条查询全部命中正确教训；单轮 209–238 tok（预算 800）；重复查询零注入 |
| M2 学习闭环 | ✅ | 模拟疼痛会话：项目库自动新增蒸馏记录 + 证据行 + 审计；全局库零污染 |
| M3 质量工序 | ✅ | 衰减 ×0.5、过期归档（文件移入 archive）、矛盾先记录后消解、晋升提案人审 |
| M4 git 化同步 | ✅ | 真实 git：提交只含记忆目录；双克隆交换；克隆重建后指纹与检索结果完全一致 |
| M5 评估门禁 | ✅ | 真实 metrics/baseline：解析 7 个基线任务、冻结快照、四项指标退化全部识别 |

### 14.3 蒸馏路由：跟随会话（默认）

`learn.distillModel` 默认为空字符串对，含义是"**继承当前会话自己的 provider/model**"
（`resolveDistillRoute()`：显式配置 > `agent.options` > 无路由则跳过并说明原因）。
理由：插件不该要求第二套 LLM 配置与用户既有设置保持同步；固定便宜模型仍是显式配置的选项。

真机验证（nvim-tui 官方 e2e，**零配置、无 --patch**）：

```
memory: distilled 1 new + 0 merged record(s) from turn 7 via deepseek-official/deepseek-v4-flash
audit: turn 7 | model=deepseek-official/deepseek-v4-flash | in 299 / out 232 | created 1 | timed_out 0
```

### 14.4 语义召回（已实现，默认关）

- 接入点就是设计预留的 `RankOptions.relevance`：`recall/semantic.ts` 把 bm25 归一化后的
  `lexical` 与余弦相似度 `semantic` 按 `weight` 混合，其余权重（置信度/新鲜度/层权/复现）不变。
- 成本控制：`enabled` 默认 false；仅当词法命中的**记录数** < `minLexicalHits` 才嵌入查询；
  调用有 `timeoutMs`；失败静默降级词法；向量按内容哈希增量缓存；空作用域直接跳过。
- 验证：假 embedding 服务 + 真实 HTTP 服务端到端；增量缓存（未改动不重复调用）；降级路径；
  "无语义时找不到、有语义时命中"的对照。
- 顺带修正：`normalizeRelevance` 原为 min-max 归一，会把两个真实命中里较弱的一个压成 0 分、
  被分数门槛丢掉；改为按最强命中缩放并设下限（0.15）。

### 14.5 蒸馏运行器（已实现）

`learn.distillRunner: inline | jobs`：

- `inline`（默认）：`agent/turn-stopping` 内有界 await（`distillTimeoutMs`，默认 3s）。
- `jobs`：交给 `ctx.jobs`（dsh-base 装配的 `dsh-jobs-local`），**轮次立即结束**，作业在作业列表中可见、
  随 owner agent 销毁自动取消；未装配 jobs 或提交失败时自动回落到 inline。
- 两者都不跨进程存活——所以信号在蒸馏**之前**已写入 L1，技能仍可事后蒸馏。

### 14.10 第五轮实机验证：`distillRunner: jobs` + 补蒸馏（无损化）

把 nvim-tui 切到 `jobs` 后真机实测，抓到**两个只有真实宿主才暴露的问题**：

1. **一次性会话里作业会被随 agent 取消**：
   ```
   turn 18 distillation handed to job memory-distill-1 (1 signal(s))
   [debug] distillation job cancelled (owner disposed)     ← 轮次结束即销毁 agent
   ```
   轮次确实 4ms 就结束了（jobs 的价值成立），但**一次 LLM 调用都没发生**，教训丢失
   （信号还在 L1）。长驻会话（nvim-tui/web 交互使用）不受影响，一次性 surface（headless、
   `dsh ... "task"`、e2e）必然触发。
2. **恢复定时器撞上宿主 teardown**：第一版把恢复放在 `session/created` + 3s 定时器，
   结果日志报 `pending-distillation recovery failed: database is not open`——
   一次性会话的 3 秒定时器落在 shutdown 之后。

**修复（无损化设计）**：

- 新增 `learn/pending.ts`：**"采到但没蒸馏"是一个查询**——`signals` 左连接 `distill` 审计表，
  没有审计行的就是待办。重试天然幂等：任何一次尝试（哪怕超时）都会写审计行，所以一组信号
  最多被捡起一次。
- 恢复挂在 **`turn-stopping`**（每个作用域每进程一次），而不是会话启动定时器：库是开的、
  agent 活着、await 与 inline 蒸馏同样有界——这正是 inline 蒸馏能work的同一个确定性时机。
- 恢复**强制 inline**（`RunnerRequest.mode`）：一组信号正是被"取消的作业"弄丢的，
  再交给作业只会再丢一次（第一版就是这么静默失效的）。
- 保护条件：轮次必须已结束（`turn < state.lastTurn`）+ 信号年龄 >5s（避免抢在途轮次）。

**实测（两次会话）**：

```
会话1: turn 18 distillation handed to job memory-distill-1 → job cancelled (owner disposed)
会话2: memory: distilled 1 new + 0 merged record(s) from turn 18 via deepseek-official/deepseek-v4-flash
       memory: recovered 1 undistilled signal(s) from session session-ee1f… turn 18 → created
产出:  distill 审计 turn 18 | in 300 / out 216 | created 1
      教训 cat-exit-code-1「cat 读到不存在的路径会以 exit code 1 失败，需先确认文件存在再读取」conf 0.63
```

即：**作业被取消只花掉"一轮延迟"，不再丢教训**；同时覆盖崩溃/重启中途丢失的场景。
插件出厂默认仍是 `inline`（任何 surface 都成立）；长驻交互面用 `jobs` 换取轮次立即结束。

### 14.9 第四轮实机验证：本地 bge-m3 语义召回（含对照实验）

本机装上 Ollama + bge-m3（1.2GB，1024 维，热调用 0.08s、冷启动 2.78s），在 nvim-tui 上启用后
真机跑通：`semantic=on/bge-m3`、19 条向量回填、注入包 `[semantic +2, embedded 19]`（182 tok）。

**对照实验**（19 条真实教训，9 个查询：6 个刻意无字面重叠 + 3 个原词）：

| 指标 | 词法 | 混合 |
|---|---|---|
| Top-1 / Top-3 | 6/9 · 8/9 | 6/9 · **9/9** |
| 改写问法 Top-3 | 5/6 | **6/6** |
| 平均耗时 / 注入 token | 0ms · 2670 | +33ms · 3606 (+35%) |

这一轮又暴露两个问题（都已修）：

1. **语义命中被"双重打折"**：先乘 `weight`，再撞上为词法标定的 `minScore=0.35`，结果
   "considered 2、injected 0"——语义明明找到了却永远进不了包。修复：`minScore` 只约束词法候选，
   纯语义候选由 `minSimilarity` 自己把关（附回归测试）。
2. **无上限的语义补充会让注入 token 翻倍**（+61% 而无准确率提升）。新增 `semantic.maxAdditions`
   （默认 2，只保留相似度最高的几条），token 增幅收敛到 +35% 且准确率反而上升。

**profile patch 的形状坑**（第二次踩配置形状）：本 profile 里生效的是顶层 `- id: <entry>` + `config:`
（同 `compaction-basic` 行）；文档里常见的嵌套 `- config: [ {id, config} ]` 在这里**不生效**
（表现为 `semantic=off`，排查花了三轮）。加上此前发现的 `dsh --patch <file>` overlay 对本插件
config 无效，结论：**改插件配置就写 profile patch 的顶层 `- id: memory` 形式**。

### 14.6 未实现 / 后续可做

- **语义召回的真机链路未验证**：不是管道问题，而是**端点不存在**——实测当前网关
  `/embeddings` 对 `text-embedding-3-small`、`bge-m3`、`embedding-2`、`gemini-embedding-001`
  一律返回 `model_not_found`（41 个模型里没有 embedding 通道）。换一个有 embedding 的端点即可；
  配置已支持 `baseUrlEnv` 间接指向（例如复用 `DEEPSEEK_BASE_URL`）。
- **向量检索未做 ANN 索引**：当前是内存内全量余弦（数百到数千条量级足够）；若记忆库达到
  数万条，应换成 sqlite-vec / HNSW。

### 14.7 实机验证记录（2026-09-14，真实 dsh 宿主）

在临时 profile（`dsh-base` + `dsh-headless` + `dsh-memory`）中启动一次真实会话，
`~/.dsh/memory-plugin.log`：

```
dsh-memory applying (default scope: project)
memory: ready (node:sqlite 3.53.1, fts5=yes, recall=on/600tok, protocol=on, learn=on/deepseek-v4-flash, semantic=off)
imported 18/18 lessons from ~/.dsh/memory/lessons
memory: bootstrapped 18 records for ~/.dsh/memory
memory: imported 5 task metrics for ~/.dsh/memory
memory: injected 4 record(s) (~533 tok) turn 1 step 1 → dsh-session--append, npmdsh--scoped-tarball-url-epermmacos-timeoutrc, pnpm-install--tty--json, stdioinherit--bash-timeout
```

即：真实宿主中插件装配成功、能力探测通过、真实语料引导导入成功、**首轮自动召回在真实会话里生效**
（4 条 / 533 tok，预算 800）。会话随后因环境缺少 LLM 凭据而未进入模型调用。

**第二轮（含真实模型工具调用）**：用隔离 profile（`memlive`，`DSH_MEMORY_HOME=/tmp/dsh-live-mem`
指向从真实语料复制的临时记忆根，避免污染生产记忆），给模型一个三步任务：

```
dsh --profile memlive "（1）memory_search 'pnpm install 无 TTY'（2）memory_save 一条教训（3）memory_stats 汇报"
```

模型确实依次调用了三个工具并汇报：检索命中 2 条（首位 `pnpm-install--tty--json`，score 0.81）、
保存成功（conf 0.90 / status active，因 cwd 不在任何仓库而按设计落**全局**作用域）、
统计显示 19 条记录 / 0 conflicts / **1 条 open proposal** / semantic off。
插件日志同时证明：

```
memory: injected 1 record(s) (~149 tok) turn 1 step 1 → pnpm-install--tty--json
memory: consolidation (first-run) on global — archived 0, decayed 0, conflicts 0, proposals 1
```

即自动召回、惰性巩固（并给出晋升提案）、工具读/写/统计三条链路在真实宿主中全部生效。
**实机跑出的一个真 bug**：macOS 上 `/tmp` 是 `/private/tmp` 的符号链接，`git rev-parse --show-toplevel`
返回物理路径而提交路径用逻辑路径计算，导致自动提交被 git 拒绝（"outside repository"）。
已修复（两侧先 realpath，且解析出仓库外时拒绝而非静默暂存），并补了 symlink 回归测试。

### 14.8 第三轮实机验证：nvim-tui 官方 e2e 模式（学习闭环）

用 nvim-tui runner 自带的 headless e2e 模式（`DSH_NVIM_TUI_HEADLESS=1` + `DSH_NVIM_TUI_PROMPT`
+ `DSH_NVIM_TUI_DUMP`，隔离记忆根 `DSH_MEMORY_HOME`）连跑 6 次，任务固定为
"真实执行一条会失败的命令，然后解释失败原因"。这一轮又抓出 **3 个真 bug**，全部只在真实宿主暴露：

| # | 症状 | 根因 | 修复 |
|---|---|---|---|
| 1 | 失败命令**完全不产生信号** | `dsh-tool-bash` 只把 spawn 失败/中断标为 `isError`；**非零退出码不算 tool error**，而"命令失败"恰恰是最常见的疼痛信号 | 新增内容级失败判定：`[exit code: N]`（strong 模式下 N≥2）+ 错误标记（No such file or directory / command not found / ERR_ / Traceback…），并补齐了类型里声明却从未发出的 `rework` 信号（同轮同一工具失败 ≥2 次） |
| 2 | 蒸馏报 `cannot get property "llm" without inject` | `ctx.llm` 未声明在 `inject` 里，cordis 拒绝属性访问；**单测的假 ctx 直接暴露 `.llm`，所以从未暴露** | 按"缺装配也要工作"的原则改为**可选服务访问**（`ctx.reflect.get('llm')`，失败回退直接读并捕获异常）；无 LLM 的组合里蒸馏降级为 `llm service unavailable`，信号留在 L1 |
| 3 | 蒸馏每次都被**自己中断**（`aborted by caller`，3.0s） | 默认 `distillTimeoutMs: 3000` **短于真实模型延迟**——实测一次 flash 的 JSON 蒸馏需 4.2s，于是生产环境里蒸馏永远失败 | 默认提到 15s（边界仍在，只是符合现实）；同时把"runtime 把取消归一化成终态 `finish`"这条契约读出来：`aborted` + 自己的 controller 已中止 → 归类为 `timeout` 而不是 `error`，并把 finish 原因（含 max-tokens 提示）写进日志 |

第 6 次运行终于完整跑通飞轮：

```
memory: injected 1 record(s) (~169 tok) turn 6 step 1 → stdioinherit--bash-timeout
memory: distilled 1 new + 0 merged record(s) from turn 6
memory: turn 6 learning — 1 signal(s), distill=created (+1/~0/-0, 515 tok)
memory: turn 6 learning finished in 4197ms
memory: committed 21 file(s) in /tmp/dsh-live-nvim (turn end (global))
```

产物逐项核对：情节 JSONL（`tool-failure | bash | error output (no such file or directory): [stderr] cat: …`）、
`distill` 审计行（in 300 / out 215 / created 1 / timed_out 0）、以及一条由真实 flash 模型产出并通过门控的教训
（`cat-no-such-file-or-directory`，conf 0.74，带触发场景 + 具体写法 + tags）。**写入只落隔离根，真实记忆零污染。**

**另一条环境结论**：`dsh --patch <file>` 覆盖对本插件的 config 未生效——六次运行的 ready 行始终是
`recall=on/600tok`（其中一次 overlay 里写了 `budgetTokens: 123`）。也就是说调参应写进 profile 的
`cordis.patch.yml`（`- config: - id: memory`），别依赖 `--patch`。

### 14.4 使用的宿主扩展点（已核对类型）

`ctx.tools.register(defineTool())`、`ctx.systemPrompt.section()/.context()/.variable()`、
`agent/pre-step`(waterfall)、`agent/turn-stopping`(serial)、`agent/request-error`、
`session/created`、`session/disposed`、`session/flush`、`session/event`、`turn/start`、`turn/end`、
`ctx.effect()`、`ctx.agents.roots()/get()`、`createUserMessage({source:{kind:'plugin'}})`。
