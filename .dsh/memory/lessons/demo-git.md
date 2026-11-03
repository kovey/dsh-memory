---
title: 在仓库内跑临时 demo 会写进真实项目记忆根，必须用带 .git 的临时目录隔离
confidence: 0.79
expires: permanent
times_seen: 1
updated: 2026-11-03
tags: dsh-memory, test-isolation, project-memory-root
origin: user
times_recalled: 2
fail_after_recall: 1
created: 2026-11-03
evidence: self-report×1
---

触发场景：在 dsh-memory 仓库里写一段临时 node 脚本演示 store 行为，cwd 落在 `<repo>/.tmp-tests/xxx` 并调用 `ScopeResolver.resolve({cwd})`。

正确做法：临时目录里先 `mkdir .git`（伪造仓库根，参照 `test/helpers.ts` 的 `fakeRepo`），否则 cwd 会一路向上命中真实仓库 → 项目记忆根被解析成 `<repo>/.dsh/memory`，demo 的 upsert/exportAll 直接污染真实记忆库（实测多出 2 条记录 + 改写 MEMORY.md）。

关键点：`DSH_MEMORY_HOME` 只重定向**全局**根，对项目根无效（项目根由会话 cwd 经 git 解析）。清理顺序：先 `PRAGMA foreign_keys=ON` 后删 records 行 → 删多余 lessons 文件 → `git checkout -- .dsh/memory/MEMORY.md` 还原生成文件。
