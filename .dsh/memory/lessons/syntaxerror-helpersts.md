---
title: 测试导入的命名导出不存在会在模块加载期抛 SyntaxError，先核对 helpers.ts 的导出再跑测试
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-09-30
tags: test-failure, esm, named-export, SyntaxError, vitest
status: pending
origin: distilled
created: 2026-09-30
evidence: rework×1, test-failure×1, tool-failure×1
---

触发场景：运行测试（如 test/promotion.test.ts）时报 `SyntaxError: The requested module './helpers.ts' does not provide an export named 'helpersHarness'`，tests 1 / pass 0 / fail 1。原因是测试文件从 './helpers.ts' 导入了模块实际未导出的名字，错误发生在模块加载阶段而非断言阶段。正确做法：失败后先执行 `grep -n "export" test/helpers.ts`（或 `node --input-type=module -e "import('./test/helpers.ts').then(m=>console.log(Object.keys(m)))"`）确认模块真实导出的符号名，再把测试文件的 import 名改为实际导出名，最后重跑该测试文件，而不是改断言或加 mock。
