---
title: 同一轮内 bash 连续失败 2 次后应停止重试，先定位根因再改命令
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-09-30
tags: rework, retry, debugging, bash
status: pending
origin: distilled
created: 2026-09-30
evidence: rework×1, test-failure×1, tool-failure×1
---

触发场景：一轮任务中出现 rework 信号 `bash failed 2× in one turn`，往往伴随 SyntaxError（导出名不匹配）与 no such file or directory（路径错误）这类确定性错误——重复执行同样的命令不会改变结果。正确做法：第二次失败即暂停重试，逐字阅读错误文本定位类别（模块导出名 / 文件路径 / 命令语法），先做只读核查（`grep -n "export" <module>`、`ls <path>`、`pwd`）确认事实，再修改 import 名或路径后重新执行一次；仍失败则换用能打印更多上下文的命令，而不是继续原样重跑。
