---
title: 定位 @deepseek-ai/dsh-tools 包文件时不要假设 dist/ 或 lib/*.d.ts 路径
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-09-30
tags: node_modules, dsh-tools, 路径定位, grep
status: pending
origin: distilled
created: 2026-09-30
evidence: rework×1, test-failure×1, tool-failure×3
---

在本仓库查 node_modules 下 @deepseek-ai/dsh-tools 的实现或类型时会踩坑：`ls node_modules/@deepseek-ai/dsh-tools/dist/` 返回 `No such file or directory`，`grep ... node_modules/@deepseek-ai/dsh-tools/lib/*.d.ts` 同样返回 `No such file or directory`（说明该包没有 dist/ 目录，.d.ts 也不在 lib/ 顶层，观察到的 lib/ 条目是 index.js、invariant.js、types 等）。正确做法是先 `ls node_modules/@deepseek-ai/dsh-tools/` 再 `ls node_modules/@deepseek-ai/dsh-tools/lib/` 确认真实目录结构，然后到 lib/types/ 之类的子目录里找声明文件，或者直接用 grep -r 在包根目录递归搜索，而不是先猜路径再重试。
