---
title: 调整记忆注入预算时不要只按 recency 竞争，应按类别设保底/封顶
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-11-03
tags: 记忆注入, token预算, recency, 分类配额, 用户纠正
status: pending
origin: distilled
created: 2026-11-03
evidence: rework×1, tool-failure×2, user-correction×1
---

触发场景：设计记忆注入逻辑时使用了较小的 token 预算，并让同层内记忆按 recency 竞争，用户指出这会让低价值近期记忆系统性挤掉高价值长期教训，并追问是否可放宽预算并叠加分类配额。正确做法：提高记忆注入 token 预算上限（与当前大模型上下文规模匹配，不要沿用偏小的固定值），在同层内不再单纯按 recency 排序，而是先按类别分配配额——全局教训类设保底、项目上下文类设封顶，剩余空间再按 recency × pinned 排序填充，并在改动前向用户确认该方案而非直接沿用原 recency 逻辑。
