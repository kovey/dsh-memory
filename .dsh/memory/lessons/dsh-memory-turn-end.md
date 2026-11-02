---
title: 查看项目提交历史时，需过滤 dsh-memory 的 turn end 提交，以免干扰判断
confidence: 0.5
expires: permanent
times_seen: 1
updated: 2026-10-22
tags: git-log, dsh-memory, pathspec
status: pending
origin: distilled
created: 2026-10-22
evidence: tool-failure×1
---

本项目每轮结束都会向 .dsh/memory/MEMORY.md 写入一条 `dsh-memory: project memory: turn end (project)` 提交；直接执行 `git log` 时，历史记录会被这些提交占满，因而难以定位真实代码变更。若要查看代码变更，应使用 pathspec 排除记忆目录，例如 `git log --oneline -- . ':!.dsh/memory'`；若专门核对记忆写入，则显式带上路径 `git log --oneline -- .dsh/memory/MEMORY.md`。
