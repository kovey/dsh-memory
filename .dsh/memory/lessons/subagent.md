---
title: 后台 subagent 完成通知到达且用户已示意停止时，不要基于其结果继续追加动作
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-09-30
tags: background-subagent, user-correction, stop, 任务收尾
status: pending
origin: distilled
created: 2026-09-30
evidence: user-correction×1
---

使用后台方式启动 subagent 执行审查/探针任务时，它跑完会主动推送一条完成消息（含 closing message，如「审查完成。以下是完整结果」），并明确处于终止态——除非再向它发送新任务，否则不会有后续动作。若这条完成通知到达时用户已表达停止意向，应当直接收尾本轮、不再基于其审阅结果启动新的验证/修复/追问动作；本次正是因为在该通知后继续推进，被用户以「stop」纠正。若确实需要它继续，必须显式再发一条任务消息，不能假设它会自行往下做。
