---
title: shell 写路径必须落在规格声明的文件边界内
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-11-06
tags: spec-gate, 文件边界, shell, 临时文件
status: pending
origin: distilled
created: 2026-11-06
evidence: rework×3, tool-failure×2
---

当 bash 命令要写入 `.tmp-tests/apdiff`、`../../../../../tmp/ab-old.js` 等路径时，会被 spec-gate 以「不在规格声明的文件边界内」拒绝（示例 mission 允许边界为 package.json、package-lock.json、README.md、UPGRADE.md、CHANGELOG.md 等）。遇到时不要换路径硬试：应只写入规格允许的文件，或先用 spec_create 更新文件边界把目标路径纳入规格并通过 spec_approve，再重新执行命令；临时验证文件应改为在允许边界内生成，或避免落盘写入。
