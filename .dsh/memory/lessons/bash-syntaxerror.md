---
title: bash 输出含括号的标记字符串必须加引号，否则触发 syntaxerror
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-09-30
tags: bash, syntaxerror, 引号, git
status: pending
origin: distilled
created: 2026-09-30
evidence: rework×1, tool-failure×3, user-correction×1
---

触发场景：在 bash 里输出带括号的标记行，例如 `echo === HEAD (memory auto-commit) ===`，未加引号的 `(` 会直接导致 bash 报 syntaxerror 并中断整条命令（如查看 git log 的复合命令）。正确做法：把整段字符串用引号包住 `echo "=== HEAD (memory auto-commit) ==="`，或改用 printf '%s\n' "..."，再拼接到复合命令里。
