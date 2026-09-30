---
title: 同一轮 bash 连续失败两次应先诊断而非重复原命令
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-09-30
tags: bash, 重试, 诊断, rework
status: pending
origin: distilled
created: 2026-09-30
evidence: rework×1, tool-failure×2
---

触发场景：同一轮内 bash 工具连续两次报错（PermissionError 与 no such file or directory）后仍继续执行同一类命令。正确做法：第二次失败即停止重试，先做最小诊断——echo "$HOME"、ls -la "$HOME/.dsh"、env | grep -i dsh——确认真实路径与环境，再基于诊断结果改写命令（改用 $HOME 展开、改用已确认存在的文件），避免在错误的路径假设上反复失败。
