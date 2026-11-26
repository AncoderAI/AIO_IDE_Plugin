# AIO for VS Code

在 VS Code 的资源管理器展开 **AIO**，点击 **OMP**、**Claude Code** 或 **Codex**，即可在项目目录中启动对应的本机 CLI。每次点击都会创建一个独立的集成终端。收起终端面板可继续运行任务，点击对应终端的垃圾桶图标可结束它。

也可以右键项目里的目录，选择 **AIO: 选择 AI CLI 并打开终端**。使用命令面板启动时，扩展优先使用当前编辑文件所属的工作区。在多根工作区中可选择项目，空窗口会提示选择目录。

### CLI 路径

安装并登录需要使用的 CLI 后，运行 **AIO: 检测本机 CLI** 查看发现的路径。如果 VS Code 没有继承最新的 PATH，可以在用户设置中填写 `aio.ompPath`、`aio.claudePath` 或 `aio.codexPath`，值为可执行文件的绝对路径。在 Remote 窗口中，CLI 和项目需要位于运行扩展的远程主机。

### 安装与开发

在扩展视图的更多操作菜单中选择 **从 VSIX 安装…**，或者运行 `code --install-extension dist/aio-ide.vsix`。开发时可用 `code --extensionDevelopmentPath=. .` 打开独立的扩展开发窗口。使用 Node.js 运行 `npm test`，安装 VS Code 打包工具 `@vscode/vsce` 后运行 `npm run package` 生成 VSIX。
