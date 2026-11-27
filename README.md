# AIO for VS Code

[English](#features) · [简体中文](#功能说明) · [GitHub repository / 项目仓库](https://github.com/AncoderAI/AIO_IDE_Plugin.git)

## Features

**Why keep the code in view on large projects?**

For a small, well-tested change, a coding agent can often find the relevant code from a short prompt, and the tests can verify the result. In a large or high-reliability system, a change can pass every test and still put a responsibility in the wrong module. OpenClaw creator Peter Steinberger has described skipping routine code while paying closer attention to decisions that shape the system. [Interview transcript](https://lexfridman.com/peter-steinberger-transcript/)

With AIO, you can read a function alongside its callers, check Git history to see why a constraint exists, and give the agent that context. Select the relevant functions or snippets, or reference specific files and folders. Reviewing the resulting diff helps you catch architectural drift before the next change builds on it.

**Why run the interactive CLI in AIO?**

With AIO in your IDE, you can read source files alongside a terminal, use the built-in launchers for Claude Code, Codex, and Oh My Pi (OMP), or run other installed tools such as Pi, OpenCode, and Kimi Code directly in the IDE terminal.

Claude Code and Codex handle keystrokes in their terminal interfaces. A headless SDK or RPC client can submit tasks, but sending a prompt does not reproduce the CLI’s keyboard interactions or automatically expose every slash command. In an AIO terminal, you can use the controls supported by your installed CLI directly, including Claude Code’s `/loop` to repeat a prompt and Codex’s `/goal` to work toward a completion condition. A headless client may offer equivalent capabilities through its own API. [Claude Code scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks) · [Codex goals](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)

Like T3 Code, Orca, Paseo, Herdr, and Cindy, AIO helps you orchestrate and manage terminal-based coding agents, with the advantage of working directly in VS Code, Cursor, or TRAE: while Claude Code, Codex, or Oh My Pi (OMP) runs, you can read the code, inspect its Git history, and select a snippet to copy and paste or drag into the IDE’s integrated terminal input.

- Use OMP, Claude Code, and Codex in one workbench. Each CLI can run in its own terminal, and an optional Bot can start worker terminals, delegate tasks, and receive progress reports.
- Open the workbench from the VS Code Activity Bar. By default it opens automatically in trusted windows (toggle `aio.openWorkbenchOnStartup` in VS Code Settings), stays on the right, and expands to fill the editor area when the file preview is hidden.
- Manage multiple projects and switch the current VS Code folder from the project list. Browse CLI history on demand by project, with each loaded session labeled by its first prompt.
- Choose English, Simplified Chinese, or the system language. The workbench uses a dark theme by default.
- **Planned: disk usage by folder.** AI coding tools running in parallel can write large amounts of data and quickly exhaust free disk space. AIO will record the path and disk usage of every folder the tools access so you can find large folders and decide what to clean up.

## How to use

1. Install [the VSIX](dist/aio-ide.vsix) using **Extensions → Install from VSIX…**, or run `code --install-extension dist/aio-ide.vsix`. Install and sign in to the CLIs you want to use. The bundled terminal is built for Windows x64 and requires Node.js 22.13+ with `node:sqlite`. Set `aio.ompPath`, `aio.claudePath`, or `aio.codexPath` if detection fails.
2. Click the **AIO** Activity Bar icon to open the full workbench. Use the CLI picker to open a terminal, or the **Bot** picker to send prompts to an OMP, Claude Code, or Codex Bot. Standalone CLI terminals are also available from the Command Palette.
3. Hover over **File preview** to show the file area on the left. Move into it to view or edit a file, then move out to give the space back to AIO. Drag Explorer files or folders into the composer or terminal to insert their paths. You can also use **Explorer → AIO** or the Explorer context menu.
4. Drop a folder onto the project list to add it. Click its name to switch the current VS Code folder, or click a CLI name under the project to load its history. Click a session to resume it.
5. In a workbench terminal, use `Ctrl+C` to copy selected text and `Ctrl+V` or right-click to paste. Change the language under **Settings → Appearance → Interface language**. VS Code menus follow the VS Code display language.

## 功能说明

**为什么大型软件项目仍需要随时看代码？**

对于范围明确、测试充分的小改动，编程助手往往能根据简短的任务描述找到相关代码，再用测试验证结果。在大型或高可靠性系统中，即使测试全部通过，一项改动仍可能把职责放进错误的模块。OpenClaw 作者 Peter Steinberger 在访谈中提到，他会略过常规代码，把更多注意力放在影响系统设计的决定上。[访谈原文](https://lexfridman.com/peter-steinberger-transcript/)

在 AIO 中，你可以对照函数和调用方阅读代码，通过 Git 历史弄清某个约束为何存在，再把这些背景交给编程助手。除了描述任务，还可以选中相关函数或代码段，或引用具体文件和文件夹。改完后对照差异检查模块职责和依赖关系，有助于在架构偏离设计之初发现问题。

**为什么在 AIO 中运行交互式 CLI？**

AIO 作为 IDE 插件，让你可以一边阅读代码文件，一边在终端中操作编程工具：通过内置入口启动 Claude Code、Codex 和 Oh My Pi（OMP），也可以在 IDE 终端中直接运行已安装的 Pi、OpenCode、Kimi Code 等工具。

Claude Code 和 Codex 在终端界面中处理按键。通过 SDK 或 RPC 无头调用可以提交任务，但发送提示词无法还原终端的快捷键交互，也不会自动获得每一条斜杠命令。在 AIO 终端中，你可以直接使用已安装 CLI 版本支持的原生操作，例如用 Claude Code 的 `/loop` 定期重复提示词，用 Codex 的 `/goal` 持续推进任务直到满足完成条件。无头客户端能否实现相同效果，取决于它提供的接口。[Claude Code 定时任务](https://code.claude.com/docs/en/scheduled-tasks) · [Codex 目标](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)

AIO 与 T3 Code、Orca、Paseo、Herdr、Cindy 都能编排和管理终端中的 AI 编程助手，AIO 插件的优势是可以直接在 VS Code、Cursor、TRAE 等 IDE 中管理 Claude Code、Codex 和 Oh My Pi（OMP），随时阅读代码、查看 Git 历史，还能在编辑器中选中一段代码，复制粘贴或拖到 IDE 集成终端的输入框。

- 在同一个工作台使用 OMP、Claude Code 和 Codex。各 CLI 可在独立终端运行，也可选用 Bot 创建工作终端、分派任务并接收进度反馈。
- 通过 VS Code 活动栏进入工作台。受信任窗口启动时默认自动打开 AIO，可在 VS Code 设置中搜索 `aio.openWorkbenchOnStartup` 并取消勾选。工作台位于最右侧，文件预览收起后占满编辑区。
- 管理多个项目，并从项目列表切换 VS Code 当前文件夹。按项目和 CLI 加载历史会话，已加载会话以首条输入作为标签。
- 界面支持英语、简体中文和跟随系统。工作台默认使用深色主题。
- **规划中：按文件夹记录磁盘占用。** 多个 AI 编程工具并行运行时可能写入大量数据，迅速耗尽可用磁盘空间。AIO 计划记录这些工具操作过的每个文件夹的路径和磁盘占用大小，方便你找到占用空间较大的目录，检查后决定清理哪些内容。

## 操作说明

1. 在 **扩展 → 从 VSIX 安装…** 中选择[安装包](dist/aio-ide.vsix)，或运行 `code --install-extension dist/aio-ide.vsix`。安装并登录要使用的 CLI。随包内嵌终端面向 Windows x64，需要支持 `node:sqlite` 的 Node.js 22.13 或更高版本。检测失败时，可设置 `aio.ompPath`、`aio.claudePath` 或 `aio.codexPath`。
2. 点击活动栏的 **AIO** 图标进入完整工作台。通过 CLI 选择器打开终端，或通过 **Bot** 选择器将底部输入发给 OMP、Claude Code 或 Codex Bot。也可从命令面板打开独立的 CLI 终端。
3. 悬停 **文件预览** 按钮展开左侧文件区。移入后可查看或编辑，移出后 AIO 收回空间。将资源管理器中的文件或文件夹拖入对话框或终端即可插入路径。也可使用 **资源管理器 → AIO** 或资源管理器右键菜单。
4. 将文件夹拖到项目列表即可添加。点击项目名切换当前 VS Code 文件夹，点击项目下的 CLI 名称加载历史，点击会话继续。
5. 在工作台终端中，按 `Ctrl+C` 复制选区，按 `Ctrl+V` 或单击右键粘贴。在 **设置 → 外观 → 界面语言** 中切换语言。VS Code 菜单跟随 VS Code 的显示语言。
