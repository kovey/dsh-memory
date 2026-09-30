---
title: 脚本与引号内使用 ~ 不会展开，需显式取 $HOME 或 expanduser
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-09-30
tags: bash, 路径展开, tilde, python, PermissionError
status: pending
origin: distilled
created: 2026-09-30
evidence: rework×1, tool-failure×2
---

触发场景：在 bash 内联脚本/Python 中把路径写成 '~/.dsh/prof...' 这类带引号或字符串字面量的形式时，shell 不做波浪号展开，Python open() 会按字面目录 '~' 解析，出现 PermissionError: [Errno 1] Operation not permitted（或 no such file or directory）。正确做法：在 shell 中用不带引号的 $HOME，如 ls -la "$HOME/.dsh/"；在 Python 中用 os.path.expanduser('~/.dsh/prof...') 或直接 os.environ['HOME'] 拼接后再 open，且写文件前先用 os.makedirs(dirname, exist_ok=True) 确保父目录存在。
