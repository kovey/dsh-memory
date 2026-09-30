---
title: bash 报 no such file or directory 时先用 test -f / ls 确认路径，再重发命令
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-09-30
tags: tool-failure, ENOENT, path, bash
status: pending
origin: distilled
created: 2026-09-30
evidence: rework×1, test-failure×1, tool-failure×1
---

触发场景：在同一次排查中执行查看/引用源码的命令时返回 tool-failure `no such file or directory`（输出中夹杂 `import type { DatabaseSync } from 'node:sqlite'`、`from '../config.js'` 等文件内容行），说明命令里给出的路径在该工作目录下不存在。正确做法：不要直接原样重跑，先确认工作目录与目标路径，例如 `pwd && ls -l test/helpers.ts src/db.ts` 或 `test -f <path> && echo ok`，用相对路径时以文件所在目录为基准（如从 test/ 目录引用 helpers.ts 应为 './helpers.ts'），路径确认无误后再执行原命令。
