---
title: edit 前必须重新 Read：文件被同轮其它命令改写会报 file changed since it was read
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-09-30
tags: edit, re-read, 返工, 工作流顺序
status: pending
origin: distilled
created: 2026-09-30
evidence: rework×1, test-failure×1, tool-failure×3
---

当同一轮里先用 bash 跑过会写文件的命令（如测试、格式化），再去 edit 该文件（例如 ~/workspace/deepseek/dsh-memory/test/consolidate.test.ts），edit 会报 `file changed since it was read — re-read the file, then retry`。按提示处理：先重新 Read 该文件刷新快照，再重试 edit；更稳妥的顺序是「读 → 改 → 再跑验证命令」，避免在同一轮内先执行写文件命令再编辑，否则会像本轮一样出现 bash 连续失败 2~3 次、edit 连续失败 2 次的返工。
