# MEMORY — 项目记忆 (/Users/zhangyong/workspace/deepseek/dsh-memory)

> 本文件由 dsh-memory 插件自动生成（文本视图），勿手工编辑结构；内容真源为同目录 `memory.db`。
> 生成时间: 2026-11-03T08:22:28.893Z · 条目: 26 (active 1 / pending 25 / archived 0)

| 标题 | 置信度 | 复现 | 到期 | 文件 |
|---|---|---|---|---|
| bash 报 eacces 时先查权限位并用 chmod 修正，不要原样重跑 | 0.58 | 1 | permanent | [bash-eacces-chmod](lessons/bash-eacces-chmod.md) |
| npm 报 EPERM 且提示缓存目录含 root 属主文件时，应先修复 ~/.npm 归属而非反复重试 | 0.60 | 1 | permanent | [npm-eperm-root-npm](lessons/npm-eperm-root-npm.md) |
| 裸 assert 失败只抛 AssertionError，缺少实际值导致无法定位 | 0.60 | 1 | permanent | [assert-assertionerror](lessons/assert-assertionerror.md) |
| 用 heredoc/stdin 跑 Python 断言脚本时，报错只显示 <stdin> 行号，难以定位 | 0.60 | 1 | permanent | [heredocstdin-python-stdin](lessons/heredocstdin-python-stdin.md) |
| pin 语义测试失败而迁移测试通过时，先查 pin 的新鲜度/过期分支，而不是 schema 迁移 | 0.53 | 1 | permanent | [pin-pin-schema](lessons/pin-pin-schema.md) |
| 调整记忆注入预算时不要只按 recency 竞争，应按类别设保底/封顶 | 0.60 | 1 | permanent | [recency](lessons/recency.md) |
| 同一轮 bash 超时后不要原样重试，缩小范围或换工具，连续 2 次失败即停止 | 0.60 | 1 | permanent | [bash-2-2](lessons/bash-2-2.md) |
| 查看大源码文件时避免整文件打印导致 bash 超时，改用 grep/sed 限定输出范围 | 0.60 | 1 | permanent | [bash-grepsed](lessons/bash-grepsed.md) |
| 编辑文件前必须先读取，否则 edit 会报 file has not been read | 0.56 | 1 | permanent | [edit-file-has-not-been-read](lessons/edit-file-has-not-been-read.md) |
| 在仓库内跑临时 demo 会写进真实项目记忆根，必须用带 .git 的临时目录隔离 | 0.79 | 1 | permanent | [demo-git](lessons/demo-git.md) |
| SSOT + 文本视图设计必须写明并发与崩溃下的一致性语义 | 0.60 | 1 | permanent | [ssot](lessons/ssot.md) |
| bash 复合命令报 syntaxerror 时，应拆成单条 git 命令重跑验证 | 0.50 | 1 | permanent | [bash-syntaxerror-git](lessons/bash-syntaxerror-git.md) |
| 查看项目提交历史时，需过滤 dsh-memory 的 turn end 提交，以免干扰判断 | 0.50 | 1 | permanent | [dsh-memory-turn-end](lessons/dsh-memory-turn-end.md) |
| 测试导入的命名导出不存在会在模块加载期抛 SyntaxError，先核对 helpers.ts 的导出再跑测试 | 0.52 | 1 | permanent | [syntaxerror-helpersts](lessons/syntaxerror-helpersts.md) |
| bash 报 no such file or directory 时先用 test -f / ls 确认路径，再重发命令 | 0.52 | 1 | permanent | [bash-no-such-file-or-directory-test-f-ls](lessons/bash-no-such-file-or-directory-test-f-ls.md) |
| 同一轮内 bash 连续失败 2 次后应停止重试，先定位根因再改命令 | 0.42 | 1 | permanent | [bash-2](lessons/bash-2.md) |
| 并行编辑仓库中只改用户白名单内的文件，动手前先读设计文档确认边界 | 0.41 | 1 | permanent | [zh-66e0a6d98d](lessons/zh-66e0a6d98d.md) |
| bash 输出含括号的标记字符串必须加引号，否则触发 syntaxerror | 0.52 | 1 | permanent | [bash-syntaxerror](lessons/bash-syntaxerror.md) |
| bash 因权限或路径不存在报错时不要在同一轮内连续重试 | 0.52 | 1 | permanent | [bash](lessons/bash.md) |
| 定位 @deepseek-ai/dsh-tools 包文件时不要假设 dist/ 或 lib/*.d.ts 路径 | 0.42 | 1 | permanent | [deepseek-aidsh-tools-dist-libdts](lessons/deepseek-aidsh-tools-dist-libdts.md) |
| edit 报 old_string and new_string must differ：说明改动已生效或写错了，先 Read 再决定是否重试 | 0.48 | 1 | permanent | [edit-oldstring-and-newstring-must-differ-read](lessons/edit-oldstring-and-newstring-must-differ-read.md) |
| edit 前必须重新 Read：文件被同轮其它命令改写会报 file changed since it was read | 0.52 | 1 | permanent | [edit-read-file-changed-since-it-was-read](lessons/edit-read-file-changed-since-it-was-read.md) |
| 脚本与引号内使用 ~ 不会展开，需显式取 $HOME 或 expanduser | 0.52 | 1 | permanent | [home-expanduser](lessons/home-expanduser.md) |
| 访问 ~/.dsh/memory/proposals/ 前先确认路径真实存在 | 0.52 | 1 | permanent | [dshmemoryproposals](lessons/dshmemoryproposals.md) |
| 同一轮 bash 连续失败两次应先诊断而非重复原命令 | 0.52 | 1 | permanent | [bash-3](lessons/bash-3.md) |
| 后台 subagent 完成通知到达且用户已示意停止时，不要基于其结果继续追加动作 | 0.41 | 1 | permanent | [subagent](lessons/subagent.md) |

