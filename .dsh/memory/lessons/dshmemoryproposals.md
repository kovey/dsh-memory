---
title: 访问 ~/.dsh/memory/proposals/ 前先确认路径真实存在
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-09-30
tags: bash, ls, 目录不存在, dsh-memory
status: pending
origin: distilled
created: 2026-09-30
evidence: rework×1, tool-failure×2
---

触发场景：执行 ls ~/.dsh/memory/proposals/ 返回 'No such file or directory'，说明该目录在环境中并不存在（或路径未展开），随后仍按该目录继续查找记录会导致整条链路失败。正确做法：先运行 ls -la "$HOME/.dsh/" 和 ls -la "$HOME/.dsh/memory/" 确认真实存在的子目录与文件，再决定读取哪个文件（例如直接读取列出的记录文件而不是 proposals/ 目录）；若目录确实缺失，用 mkdir -p "$HOME/.dsh/memory/proposals" 创建后再写入。
