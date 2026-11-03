---
title: 查看大源码文件时避免整文件打印导致 bash 超时，改用 grep/sed 限定输出范围
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-11-03
tags: bash, timeout, grep, sed, 大文件
status: pending
origin: distilled
created: 2026-11-03
evidence: rework×1, tool-failure×2, user-correction×1
---

触发场景：需要阅读较大的 TypeScript/SQL 源文件（含 export function、db.prepare 长语句）来确认实现细节时，直接 cat/整段打印或 node 输出整模块会触发 bash timedout，本轮连续两次超时。正确做法：先用 `grep -n "关键词" 文件路径` 定位行号，再用 `sed -n '100,180p' 文件路径` 或 `head -n 80 文件路径` 只取目标片段；需要统计时用带 LIMIT 的单条 SQL/脚本并限制返回行数，避免把整个文件内容回显到工具输出。
