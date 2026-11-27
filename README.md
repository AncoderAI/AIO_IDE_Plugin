# AIO for VS Code

[English](#features) · [简体中文](#功能说明) · [GitHub repository / 项目仓库](https://github.com/AncoderAI/AIO_IDE_Plugin.git)

## Features

Like T3 Code, Orca, Paseo, Herdr, and Cindy, AIO helps you orchestrate and manage terminal-based coding agents, with the advantage of working directly in VS Code, Cursor, or TRAE: while Claude Code, Codex, or Oh My Pi (OMP) runs, you can read the code, inspect its Git history, and select a snippet to copy and paste or drag into the IDE’s integrated terminal input.

- Use OMP, Claude Code, and Codex in one workbench. Each CLI can run in its own terminal, and an optional Bot can start worker terminals, delegate tasks, and receive progress reports.
- Open the workbench from the VS Code Activity Bar. It opens automatically in trusted windows, stays on the right, and expands to fill the editor area when the file preview is hidden.
- Manage multiple projects and switch the current VS Code folder from the project list. Browse CLI history on demand by project, with each loaded session labeled by its first prompt.
- Choose English, Simplified Chinese, or the system language. The workbench uses a dark theme by default.

## How to use

1. Install [the VSIX](dist/aio-ide.vsix) using **Extensions → Install from VSIX…**, or run `code --install-extension dist/aio-ide.vsix`. Install and sign in to the CLIs you want to use. The bundled terminal is built for Windows x64 and requires Node.js 22.13+ with `node:sqlite`. Set `aio.ompPath`, `aio.claudePath`, or `aio.codexPath` if detection fails.
2. Click the **AIO** Activity Bar icon to open the full workbench. Use the CLI picker to open a terminal, or the **Bot** picker to send prompts to an OMP, Claude Code, or Codex Bot. Standalone CLI terminals are also available from the Command Palette.
3. Hover over **File preview** to show the file area on the left. Move into it to view or edit a file, then move out to give the space back to AIO. Drag Explorer files or folders into the composer or terminal to insert their paths. You can also use **Explorer → AIO** or the Explorer context menu.
4. Drop a folder onto the project list to add it. Click its name to switch the current VS Code folder, or click a CLI name under the project to load its history. Click a session to resume it.
5. In a workbench terminal, use `Ctrl+C` to copy selected text and `Ctrl+V` or right-click to paste. Change the language under **Settings → Appearance → Interface language**. VS Code menus follow the VS Code display language.

## 功能说明

AIO 与 T3 Code、Orca、Paseo、Herdr、Cindy 都能编排和管理终端中的 AI 编程助手，AIO 插件的优势是可以直接在 VS Code、Cursor、TRAE 等 IDE 中管理 Claude Code、Codex 和 Oh My Pi（OMP），随时阅读代码、查看 Git 历史，还能在编辑器中选中一段代码，复制粘贴或拖到 IDE 集成终端的输入框。

- 在同一个工作台使用 OMP、Claude Code 和 Codex。各 CLI 可在独立终端运行，也可选用 Bot 创建工作终端、分派任务并接收进度反馈。
- 通过 VS Code 活动栏进入工作台。受信任窗口启动时会自动打开 AIO。工作台位于最右侧，文件预览收起后占满编辑区。
- 管理多个项目，并从项目列表切换 VS Code 当前文件夹。按项目和 CLI 加载历史会话，已加载会话以首条输入作为标签。
- 界面支持英语、简体中文和跟随系统。工作台默认使用深色主题。

## 操作说明

1. 在 **扩展 → 从 VSIX 安装…** 中选择[安装包](dist/aio-ide.vsix)，或运行 `code --install-extension dist/aio-ide.vsix`。安装并登录要使用的 CLI。随包内嵌终端面向 Windows x64，需要支持 `node:sqlite` 的 Node.js 22.13 或更高版本。检测失败时，可设置 `aio.ompPath`、`aio.claudePath` 或 `aio.codexPath`。
2. 点击活动栏的 **AIO** 图标进入完整工作台。通过 CLI 选择器打开终端，或通过 **Bot** 选择器将底部输入发给 OMP、Claude Code 或 Codex Bot。也可从命令面板打开独立的 CLI 终端。
3. 悬停 **文件预览** 按钮展开左侧文件区。移入后可查看或编辑，移出后 AIO 收回空间。将资源管理器中的文件或文件夹拖入对话框或终端即可插入路径。也可使用 **资源管理器 → AIO** 或资源管理器右键菜单。
4. 将文件夹拖到项目列表即可添加。点击项目名切换当前 VS Code 文件夹，点击项目下的 CLI 名称加载历史，点击会话继续。
5. 在工作台终端中，按 `Ctrl+C` 复制选区，按 `Ctrl+V` 或单击右键粘贴。在 **设置 → 外观 → 界面语言** 中切换语言。VS Code 菜单跟随 VS Code 的显示语言。
