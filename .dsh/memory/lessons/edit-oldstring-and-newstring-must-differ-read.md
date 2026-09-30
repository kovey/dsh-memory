---
title: edit 报 old_string and new_string must differ：说明改动已生效或写错了，先 Read 再决定是否重试
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-09-30
tags: edit, old_string, 重复编辑, Read
status: pending
origin: distilled
created: 2026-09-30
evidence: rework×1, test-failure×1, tool-failure×3
---

对同一文件执行 edit 时若传入的 old_string 与 new_string 完全相同，工具会直接报 `Error: old_string and new_string must differ`（本轮中 edit 在同一轮内连续失败 2 次）。遇到该错误不要原样重试：先用 Read 读回目标文件当前内容，若文件中已经是期望的新内容，说明上一次编辑已生效、无需再改；若确实需要改动，则重新确认 old_string 的实际文本（含缩进）后再发起 edit。
