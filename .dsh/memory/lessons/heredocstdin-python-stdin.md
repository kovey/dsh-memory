---
title: 用 heredoc/stdin 跑 Python 断言脚本时，报错只显示 <stdin> 行号，难以定位
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-11-03
tags: python, bash, heredoc, traceback, 调试
status: pending
origin: distilled
created: 2026-11-03
evidence: test-failure×1
---

当用 `python - <<'PY' ... PY` 这类标准输入方式执行校验脚本并失败时，traceback 会显示 `File "<stdin>", line 25`，没有文件路径也没有可回看的源码上下文，无法判断是哪段逻辑出错。正确做法：把校验脚本先写到临时文件（如 /tmp/check_x.py）再用 `python /tmp/check_x.py` 执行，这样 traceback 会给出真实文件路径与行号，且可重复运行、可加 `python -m pdb` 或 `traceback.print_exc()` 复查。
