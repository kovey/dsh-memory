---
title: bash 因权限或路径不存在报错时不要在同一轮内连续重试
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-09-30
tags: bash, 重试, EPERM, 路径不存在, rework
status: pending
origin: distilled
created: 2026-09-30
evidence: rework×1, tool-failure×3, user-correction×1
---

触发场景：同一条 bash 命令在一轮内重复失败（本会话中出现 2 次、3 次、4 次连续 rework），典型错误是 EPERM 权限拒绝和 ls/遍历多个目录时 no such file or directory（如列出 cordis、cosmokit、dsh-* 等未创建目录）。正确做法：第一次失败后先诊断再重发——用 test -d / ls -d 逐个确认路径是否存在，用 ls -l 或只读方式确认写入目标是否在允许范围内；确认前不要再原样重跑同一条命令。
