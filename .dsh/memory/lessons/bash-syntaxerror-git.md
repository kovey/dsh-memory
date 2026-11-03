---
title: bash 复合命令报 syntaxerror 时，应拆成单条 git 命令重跑验证
confidence: 0.5
expires: permanent
times_seen: 1
updated: 2026-10-22
tags: bash, syntaxerror, git-log, quoting
status: pending
times_recalled: 1
fail_after_recall: 1
created: 2026-10-22
evidence: tool-failure×1
---

当用 bash 工具批量输出 .dsh/memory/MEMORY.md 的提交历史（例如在循环中用 `=== <hash> <subject>` 这类分隔符拼接多行、并混用引号或多行字符串）时，会出现 `error output (syntaxerror)`，导致整次调用没有可用结果。遇到这种情况，不要原样重跑同一条复合命令；应先运行最小命令确认仓库状态和输出格式：`git log --oneline -n 5 -- .dsh/memory/MEMORY.md`，确认引号或 heredoc 配对、分隔符不在 shell 中被误解析后，再逐步加回格式化逻辑。
