# 升级指引（dsh-memory）

本文件说明**宿主 dsh 版本变化时如何升级本插件**。日常小版本变更见
[CHANGELOG.md](CHANGELOG.md)。

> **版本轴速查**
>
> | 你的 dsh 宿主 | 该用的 dsh-memory | 说明 |
> |---|---|---|
> | `0.1.7-rc.1` | **v0.2.0+** | 精确锚定；本版起必须同族 |
> | `0.1.5-rc.1` ~ `0.1.5-rc.3` | v0.1.x | 区间锚定，rc 之间可互换 |
> | `0.1.2-alpha.2` 及更早 | — | 未适配 |

---

## v0.1.x → v0.2.0（宿主 0.1.5-rc.x → 0.1.7-rc.1）

> **结论先行**：这是**跨宿主版本**的升级，**不是零破坏**。插件与宿主必须**一起**
> 升级，且升级后**必须重启**。若你暂时不想动宿主，**请留在 v0.1.1**。

### 升级步骤

```bash
# 1) 先升宿主（0.1.7-rc.1 在 next dist-tag 上）
npm i -g @deepseek-ai/dsh@0.1.7-rc.1

# 2) 再升插件。git/tag 依赖必须用 add 带新 ref ——
#    `update` 与 `update --latest` 都推不动 git ref（只重写 npm semver 范围）
dsh plugin --profile <name> add "kovey/dsh-memory#v0.2.0"

# 3) 重启
dsh --profile <name>
```

### 为什么是破坏性的

**① peer 锚点由区间改为精确版本。** 0.1.5 时期是 `^0.1.5-rc.1`（rc 之间可互换），
0.1.7 的 peer 改成精确值：

```
"@deepseek-ai/dsh-agent": "0.1.7-rc.1"    ← 无 ^
```

本插件随之精确锚定，**不能再跨 rc 混用**。

**② `source.kind` 的 `'plugin'` 被官方移除。** 0.1.7 的 **session 格式 v4 直接拒绝**
`kind: 'plugin'`（源码注释：*refuses retired plugin wrappers*），改为「每个生产者在自己
的模块里声明自己的 kind」。v0.1.x 注入的「记忆召回」消息在 0.1.7 上会导致：

```
SessionFormatError: format v4 message requires a producer-owned source kind
```

表现为**记忆召回静默失效**（消息无法落盘），日志里还会看到插件 dispose 时的 flush 失败。

### 本版改了什么

- 注入消息改用自建 kind `'dsh-memory'`（`src/message-source.ts` 里做 module augmentation，
  并交叉 `ContextFormed` 以保留 `form: 'notice'` + `summary` —— 渲染层靠这对字段把召回包
  折叠成一行 notice，而不是整段铺开）。
- **`isMemoryMessage` 同时识别两代形状**：新 `{kind:'dsh-memory'}` 与旧
  `{kind:'plugin', plugin:'dsh-memory'}`。**这点很重要** —— 迁移前的会话日志里存的是旧形状，
  只认新形状会把旧召回包当成查询文本再次摄入，形成**自我强化**的记忆库。
- `agent/created` 处理器显式标注返回 `undefined`：0.1.7 把该处理器的返回类型收窄为
  `Promise<undefined> | undefined`，裸 `void` 不再通过类型检查。

### 验证

- `npm run typecheck` / `npm run build` / `npm test` 全绿（对着 0.1.7-rc.1 的真实类型面）。
- 真机：在 dsh 0.1.7-rc.1 上跑一次会话，确认
  ① 不再出现 `SessionFormatError`；② 聊天区能看到「记忆召回：N 条」。

### 若升级后仍有报错

**别的插件也可能用旧 kind。** 同一条 `SessionFormatError` 若在其它插件名下出现，那是
**那个插件**需要做同样的迁移，不是 dsh-memory 的问题。定位方法：给宿主的
`dsh-session-format-v3-to-v4` 里的 `assertV4SourceRowAdmission` 临时加一行
`console.error` 打印被拒消息的 `source`，它会直接点名 `plugin` 字段的值。
