---
title: 裸 assert 失败只抛 AssertionError，缺少实际值导致无法定位
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-11-03
tags: python, assert, 报错信息, 测试
status: pending
origin: distilled
created: 2026-11-03
evidence: test-failure×1
---

在 Python 校验脚本中写 `assert 条件` 而条件不成立时，输出仅有一行 `AssertionError`，没有期望值与实际值，只能靠回读代码猜测哪条断言失败（本次即因此只看到 `line 25, in <module> AssertionError`）。正确做法：每条断言都带消息并打印实际值，例如 `assert got == want, f"期望 {want!r} 实际 {got!r}"`，或改为显式 `if got != want: raise SystemExit(f"...")`，使失败输出直接包含可对比的数据。
