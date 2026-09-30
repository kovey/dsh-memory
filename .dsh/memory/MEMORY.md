# MEMORY — 项目记忆 (/Users/zhangyong/workspace/deepseek/dsh-memory)

> 本文件由 dsh-memory 插件自动生成（文本视图），勿手工编辑结构；内容真源为同目录 `memory.db`。
> 生成时间: 2026-09-30T06:47:39.464Z · 条目: 9 (active 0 / pending 9 / archived 0)

| 标题 | 置信度 | 复现 | 到期 | 文件 |
|---|---|---|---|---|
| edit 前必须重新 Read：文件被同轮其它命令改写会报 file changed since it was read | 0.60 | 1 | permanent | [edit-read-file-changed-since-it-was-read](lessons/edit-read-file-changed-since-it-was-read.md) |
| edit 报 old_string and new_string must differ：说明改动已生效或写错了，先 Read 再决定是否重试 | 0.60 | 1 | permanent | [edit-oldstring-and-newstring-must-differ-read](lessons/edit-oldstring-and-newstring-must-differ-read.md) |
| 定位 @deepseek-ai/dsh-tools 包文件时不要假设 dist/ 或 lib/*.d.ts 路径 | 0.60 | 1 | permanent | [deepseek-aidsh-tools-dist-libdts](lessons/deepseek-aidsh-tools-dist-libdts.md) |
| bash 因权限或路径不存在报错时不要在同一轮内连续重试 | 0.60 | 1 | permanent | [bash](lessons/bash.md) |
| bash 输出含括号的标记字符串必须加引号，否则触发 syntaxerror | 0.60 | 1 | permanent | [bash-syntaxerror](lessons/bash-syntaxerror.md) |
| 并行编辑仓库中只改用户白名单内的文件，动手前先读设计文档确认边界 | 0.60 | 1 | permanent | [zh-66e0a6d98d](lessons/zh-66e0a6d98d.md) |
| 同一轮内 bash 连续失败 2 次后应停止重试，先定位根因再改命令 | 0.60 | 1 | permanent | [bash-2](lessons/bash-2.md) |
| bash 报 no such file or directory 时先用 test -f / ls 确认路径，再重发命令 | 0.60 | 1 | permanent | [bash-no-such-file-or-directory-test-f-ls](lessons/bash-no-such-file-or-directory-test-f-ls.md) |
| 测试导入的命名导出不存在会在模块加载期抛 SyntaxError，先核对 helpers.ts 的导出再跑测试 | 0.60 | 1 | permanent | [syntaxerror-helpersts](lessons/syntaxerror-helpersts.md) |

