---
title: 同一轮 bash 超时后不要原样重试，缩小范围或换工具，连续 2 次失败即停止
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-11-03
tags: bash, 重试策略, rework, timeout
status: pending
origin: distilled
created: 2026-11-03
evidence: rework×1, tool-failure×2, user-correction×1
---

触发场景：本轮 bash 第一次超时后又执行了同类命令，再次超时，最终形成 bash failed 2× in one turn 的返工。正确做法：第一次超时后立即改变策略——缩小读取范围（`sed -n`/`head`）、加 `timeout 20s` 前缀、或改用 grep 只取匹配行；若同一轮已出现 2 次失败，停止重试同类命令，改为报告已获取的片段并向用户确认下一步，而不是重复执行几乎相同的命令。
