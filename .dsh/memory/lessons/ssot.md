---
title: SSOT + 文本视图设计必须写明并发与崩溃下的一致性语义
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-11-03
tags: SSOT, 一致性, 设计文档, SQLite, 导出
status: pending
origin: distilled
created: 2026-11-03
evidence: tool-failure×1, user-correction×1
---

当设计文档声明「SQLite 是 SSOT、文本视图是单向导出」时，仅描述单进程顺序执行是不够的：同一 profile 下多会话并发写入，或进程在导出过程中崩溃，都会让 SQLite 与文本视图出现短暂或持久不一致。应在设计文档中显式规定：导出是否原子（先写临时文件再 rename）、部分导出失败时如何清理或标记、启动时是否重建/对账文本视图、并发写入是否串行化或加锁、以及允许的陈旧窗口。评审此类设计时，只要看到「单向导出」就追问上述五点，缺一项即视为设计不完整。
