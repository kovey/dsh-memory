---
title: 编辑文件前必须先读取，否则 edit 会报 file has not been read
confidence: 0.56
expires: permanent
times_seen: 1
updated: 2026-11-03
tags: edit, read, file-not-read, tool-failure
status: pending
origin: distilled
times_recalled: 1
fail_after_recall: 1
created: 2026-11-03
evidence: rework×2, tool-failure×3
---

当使用 edit 工具修改 src/store/export.ts、README.md 等文件时，如果本轮尚未读取过目标文件，edit 会返回 `file has not been read — read the file, then retry` 并失败（本次同一轮因此连续失败 2–3 次）。正确做法：调用 edit 前先用 read 工具读取目标文件，多个文件要逐个读取；如果已经报出这个错误，不要重复 edit，先 read 对应路径，再重新执行 edit。
