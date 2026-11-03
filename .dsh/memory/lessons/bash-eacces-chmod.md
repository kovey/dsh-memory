---
title: bash 报 eacces 时先查权限位并用 chmod 修正，不要原样重跑
confidence: 0.58
expires: permanent
times_seen: 1
updated: 2026-11-03
tags: bash, eacces, permission, chmod
status: pending
origin: distilled
created: 2026-11-03
evidence: tool-failure×1
---

当 bash 工具返回带 (eacces) 的错误输出时，说明被操作的脚本或文件缺少执行或读取权限，而不是命令语法问题。正确做法：先用 `ls -l <目标路径>` 查看权限位与属主，确认缺失位后对脚本加执行位（`chmod +x <脚本>`）或按需调整读权限（`chmod u+r <文件>`），再重新执行原命令；不要不改权限就重复执行同一条命令。
