# AIO 工作台 Bot 开发方案

以 AIO 提交 `561bc25d4aeeec8310ab279e52e997b0f3ad1988` 为参考。VS Code 工作台继续负责终端显示和键盘焦点，终端后台负责启动、投递、退出及 Bot 控制协议。交付分支为 `codex/workbench-bot`。

底部选择器提供无 Bot、OMP、Claude Code、Codex。托管终端用 `_Bot` 区别角色。底部提交路由到所选 Bot 的终端 ID。切换查看工作终端时，仍按选中的 Bot 投递。工作终端可以被用户查看，也可由所属 Bot 通过随包脚本控制。

控制 API 绑定本机回环地址，控制令牌按会话签发。Bot 可创建、发送任务及关闭归属自己的工作终端。工作终端可以通过脚本或 CLI hook 报告状态。进度、任务完成和进程退出分别记录。技能提供模型选用原则和事件约定，Bot 根据反馈选择下一步。

验收覆盖角色创建、跨标签投递、项目隔离、关闭清理、反馈关联、任务串行，以及 Codex 冷启动多行首任务和就绪后的单行发送。另用真实 Codex 与回环模拟 Responses 服务验证键盘和中文输入后的 Enter。测试环境使用隔离配置和模拟凭据。

Windows 本机 Codex 0.172.0 的 PTY 在后续多行投递时出现换行丢失或逐行提交。因此通过 `create codex --stdin` 向新终端提交完整的 UTF-8 多行首任务。对已运行 Codex 自动投递时，单行任务在编辑区就绪后提交；多行任务在向 PTY 写入前返回错误。

## 复验入口

将 `VSCODE_EXECUTABLE_PATH` 设为桌面版 Code.exe 的绝对路径。使用 `AIO_TEST_BOT_UI=1` 运行 `node test-host-ui/verify-workbench.cjs dist/aio-ide.vsix`，验收选择、跨标签路由和关闭。将 `AIO_TEST_CODEX_SUBMISSION_EXE` 设为本机 Codex 的绝对路径，可用同一入口做真实终端提交测试，模型请求发往测试进程启动的本地模拟接口。

重新构建工作台 UI 时，将 `AIO_SOURCE` 指向指定提交的 AIO checkout，并准备其 Node 开发依赖。后台构建通过 Git 归档获取相同提交的源码。
