---
title: npm 报 EPERM 且提示缓存目录含 root 属主文件时，应先修复 ~/.npm 归属而非反复重试
confidence: 0.6
expires: permanent
times_seen: 1
updated: 2026-11-03
tags: npm, EPERM, 缓存权限, chown
status: pending
origin: distilled
created: 2026-11-03
evidence: tool-failure×1
---

触发场景：执行 npm 命令（安装/构建）时报 `npm error code EPERM`、`npm error syscall open`，路径指向 `~/.npm/_cacache/tmp/...`，并附带提示 cache folder contains root-owned files——通常是之前用 sudo 运行过 npm，导致缓存目录被 root 占用。正确做法：先用 `ls -ln ~/.npm/_cacache` 确认存在 uid 为 0 的文件，再对当前用户执行 `sudo chown -R $(id -u):$(id -g) ~/.npm`，然后重跑原 npm 命令；若无法修改归属，可改用独立缓存目录，如 `npm install --cache ./.npm-cache` 或设置 `npm_config_cache=./.npm-cache`。后续避免用 sudo 执行 npm，以免再次污染缓存。
