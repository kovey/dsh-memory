---
title: 写操作前必须先登记并审批规格（spec_create + spec_approve）
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-11-06
tags: spec-gate, spec_create, spec_approve, 写操作
status: pending
origin: distilled
created: 2026-11-06
evidence: rework×3, tool-failure×2
---

在本会话执行任何写操作（bash 写文件、创建/修改文件）时若收到 `spec-gate: 该会话没有已登记的规格（mission），写操作被拒绝`，说明会话缺少已登记的 mission。正确做法：先调用 spec_create 提交结构化规格（验收标准 / 文件边界 / 负面约束 / 测试设计），再调用 spec_approve 取得审批，然后重新执行原写操作；不要在未登记规格的情况下反复重试同一命令。
