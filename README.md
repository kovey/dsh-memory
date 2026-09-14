# dsh-memory

DeepSeek Harness（dsh）的分层记忆插件：**严格分离的项目级 / 全局记忆** + **任务前自动召回** + **任务后持续学习**。

设计文档（唯一决策存档）：[`docs/DESIGN.md`](docs/DESIGN.md)。

- 类型：host 插件（cordis v4），TypeScript / ESM，运行期零第三方依赖
- 数据：每个记忆根一个 SQLite 库（`node:sqlite` + FTS5，WAL）；Markdown/JSONL 作为进 Git 的文本视图
- 隔离：项目记忆只写 `<repo>/.dsh/memory`，全局记忆只写 `~/.dsh/memory`，**跨库写入被硬阻断**
- 当前进度：**M0**（存储层 + 引导导入 + 只读工具）；M1–M5 见设计文档 §11

## 状态（M0）

| 能力 | 状态 |
|---|---|
| SQLite schema v2（CJK bigram 索引、WAL、迁移） | ✅ |
| 文本视图 → DB 引导导入（`lessons/*.md`、`metrics.jsonl`） | ✅ |
| DB → 文本视图导出（`lessons/*.md`、`MEMORY.md`）与往返一致性 | ✅ |
| 作用域解析（会话 cwd → 仓库根）与项目/全局守卫 | ✅ |
| 只读工具 `memory_search` / `memory_get` / `memory_stats` / `memory_reindex` | ✅ |
| 自动召回、常驻协议段（M1） | ⏳ |
| 信号采集、自动蒸馏、门控落库（M2） | ⏳ |
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
        recall:
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
| `memory_reindex` | 从文本视图重建派生索引（手工改过 lessons、或 `git pull` 之后） |

## 开发

```bash
npm run build         # tsc → lib/
npm test              # 构建后 node --test（Node 原生 TS 执行测试）
```

测试全部在仓库内 `.tmp-tests/` 运行，并把全局记忆根重定向到临时目录，**不会触碰
真实的 `~/.dsh/memory`**。

## 日志

`~/.dsh/memory-plugin.log`（插件绝不写 stdout：TUI 拥有 stdout，web 端有自己的
server 日志）。日志超过 5 MB 自动轮转为 `.log.1`。
