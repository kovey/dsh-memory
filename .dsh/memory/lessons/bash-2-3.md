---
title: 同一轮 bash 失败 2 次以上应停止重试并先修复前置条件
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-11-06
tags: rework, bash, 重试策略, spec-gate
status: pending
origin: distilled
created: 2026-11-06
evidence: rework×3, tool-failure×2
---

当一轮对话中 bash 连续失败 2～4 次（rework 信号）且错误均为 spec-gate 拒绝时，说明重试相同命令不会成功。正确做法：读取错误信息中的「下一步」指示，先完成缺失的前置动作（调用 spec_create 登记规格、spec_approve 审批，或调整写入路径到已声明边界），确认前置条件满足后再执行一次，而不是在同一轮内重复相同调用。
