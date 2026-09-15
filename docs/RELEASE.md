# 发布与安装（dev 链路 vs 发布链路）

> 一句话规则：**`nvim-tui` / `web` / `headless` 吃本地工作区（`link:` 开发链路）；
> `tui` 只吃发布版本，绝不指向开发树。**

## 为什么分开

| surface | 用途 | 安装形态 |
|---|---|---|
| `nvim-tui` | 本地测试（可随意改配置，e2e 真机验证也在这里跑） | `~/.dsh/profiles/node_modules/dsh-memory` → 本仓库工作区的符号链接 |
| `web` / `headless` | 其余测试面 | 同上（共享安装闭包） |
| **`tui`** | **你的生产面** | **发布产物**（npm 版本 / GitHub tag），并在其 `package.json` 里作为依赖声明 |

共享闭包的符号链接意味着：**任何 profile 只写 bundle 名而不声明依赖，都会解析到开发树**。
所以 `scripts/install-into-dsh.sh` 默认**拒绝**操作 `tui`（要越权必须显式 `--allow-tui`）：

```
$ scripts/install-into-dsh.sh --profiles tui
refusing: 'tui' is the production profile and takes a released build, not this working tree.
```

## 发布前检查（人工执行，不自动）

按既有约定：**打 tag / publish / 改 profile 永远等明确指示**，本文件只是清单。

```bash
cd ~/workspace/deepseek/dsh-memory
npm test                      # 113 例；prepublishOnly 也会跑 build + test
npm run build                 # tsc → lib/
git status --porcelain        # 必须干净（发布产物来自提交，不是工作区）
```

发布物内容（`package.json` 的 `files`）：`dist/`、`cordis.patch.yml`、`README.md`。
peerDependencies 只声明 `@deepseek-ai/*`，运行期零第三方依赖。

## 发布

仓库目前**没有 remote**（先 init、后加 remote 的决定）。二选一：

```bash
# A) GitHub tag（与 dsh-nvim-tui / dsh-chat-interaction 同形态）
git remote add origin git@github.com:<owner>/dsh-memory.git
git tag v0.1.0 && git push origin main --tags

# B) npm（公开或私有 registry）
npm publish
```

## 装进 tui（发布之后）

```bash
# 1) 作为依赖安装（pnpm，profile 目录内）
dsh plugin --profile tui add github:<owner>/dsh-memory#v0.1.0
#    或： dsh plugin --profile tui add dsh-memory@0.1.0

# 2) 挂载：把 "dsh-memory" 追加到 ~/.dsh/profiles/tui/package.json 的 dsh.profile.bundles
#    （插件自带的 cordis.patch.yml 会插入 id: memory —— 不要在 profile patch 里重复 insert）
```

配置覆盖（可选）写进 `~/.dsh/profiles/tui/cordis.patch.yml`，**形状必须是顶层 `- id:` + `config:`**
（嵌套的 `- config: [ {id, config} ]` 在本 profile 不生效；`dsh --patch` overlay 同样不生效）：

```yaml
- id: memory
  config:
    semantic:
      enabled: true
      baseUrl: 'http://127.0.0.1:11434/v1'
      model: 'bge-m3'
      timeoutMs: 8000
      weight: 0.3
      minLexicalHits: 3
      minSimilarity: 0.5
      maxAdditions: 2
```

## 装完怎么确认（tui 是你的面，验证也由你决定）

1. 启动 tui 后看 `~/.dsh/memory-plugin.log` 出现：
   `memory: ready (node:sqlite …, fts5=yes, recall=on/600tok, protocol=on, learn=on/<route>, semantic=on/bge-m3)`
2. 确认解析到的是发布产物而不是开发树：
   `node -e "console.log(require.resolve('dsh-memory'))"`（在 `~/.dsh/profiles/tui` 下执行）
   → 应指向 `~/.dsh/profiles/tui/node_modules/dsh-memory/dist/index.js`，
   **不是** `~/workspace/deepseek/dsh-memory/dist/index.js`。
3. 回退：从 bundles 移除该行、`dsh plugin --profile tui remove dsh-memory` 即可（记忆数据不受影响，
   文本视图仍在 `~/.dsh/memory` 与各项目 `.dsh/memory`）。
