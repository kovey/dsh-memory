---
title: pin 语义测试失败而迁移测试通过时，先查 pin 的新鲜度/过期分支，而不是 schema 迁移
confidence: 0.53
expires: permanent
times_seen: 1
updated: 2026-11-03
tags: test-failure, pinning, freshness-floor, migration, assertionerror
status: pending
origin: distilled
created: 2026-11-03
evidence: test-failure×1
---

触发场景：运行测试套件时，schema v5 迁移用例（『schema v5 databases gain the pinned column without losing rows』）通过，但 pin 相关用例（如『pinning a record gives it a freshness floor, not a free pass』）抛 AssertionError。此时说明迁移给表加 pinned 列这一步已经正常，失败点在 pin 之后对记录新鲜度下限的判定逻辑。正确做法：先看这些失败用例名对应的断言期望（pin 只提供「新鲜度下限」而非绕过过期检查），再定位实现中处理 pinned 记录的读取/过期判断分支，修正 pinned 分支的返回值或用例期望；不要回改 schema 迁移 SQL 或迁移测试。
