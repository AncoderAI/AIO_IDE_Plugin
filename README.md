# AIO for VS Code

在受信任的工作区中，点击 VS Code 左侧活动栏的 **AIO** 终端图标，然后选择 **OMP**、**Claude Code** 或 **Codex**，即可在项目目录中启动对应的本机 CLI。资源管理器中的 **AIO** 分组也提供相同入口。每次点击都会创建一个独立的集成终端。收起终端面板可继续运行任务，点击对应终端的垃圾桶图标可结束它。

也可以右键项目里的目录，选择 **AIO: 选择 AI CLI 并打开终端**。使用命令面板启动时，扩展优先使用当前编辑文件所属的工作区。在多根工作区中可选择项目，空窗口会提示选择目录。

### CLI 路径

安装并登录需要使用的 CLI 后，运行 **AIO: 检测本机 CLI** 查看发现的路径。如果 VS Code 没有继承最新的 PATH，可以在用户设置中填写 `aio.ompPath`、`aio.claudePath` 或 `aio.codexPath`，值为可执行文件的绝对路径。在 Remote 窗口中，CLI 和项目需要位于运行扩展的远程主机。

### 安装与开发

在扩展视图的更多操作菜单中选择 **从 VSIX 安装…**，或者运行 `code --install-extension dist/aio-ide.vsix`。开发时可用 `code --extensionDevelopmentPath=. .` 打开独立的扩展开发窗口。使用 Node.js 运行 `npm test`，安装 VS Code 打包工具 `@vscode/vsce` 后运行 `npm run package` 生成 VSIX。

### 完整工作台

点击 AIO 下的 **完整工作台**，或在资源管理器右键本地项目目录，选择 **AIO: 打开完整工作台**。第一次使用时，在工作台的「插件」页启用需要的编程智能体，再添加项目。这里的插件状态独立于资源管理器中的三个终端快捷入口。

工作台随扩展提供 AIO 2.0.1 的 React 界面和后台服务，可使用项目库、项目会话、模型目录、Claude/Codex 流式对话、三种智能体的后台任务、终端抽屉及基础 Git 操作。工作台数据保存在 VS Code 的扩展存储目录中。关闭整个工作台标签会关闭其服务；收起工作台里的终端抽屉可让终端继续运行。

本版按 **Windows x64** 打包工作台内嵌终端。工作台需要支持 `node:sqlite` 的 Node.js 22.13 或更高版本；若 VS Code 自带的版本不满足条件，会从 PATH 查找。资源管理器的三个 CLI 入口直接使用 VS Code 集成终端。浏览器操作、定时长任务、技能执行和桌面更新器仍属于上游 Tauri 的迁移范围。

重新构建工作台时，将 `AIO_SOURCE` 指向已安装开发依赖的 AIO 仓库，运行 `npm run build:workbench`。Windows 构建还需要 Rust/Cargo 和 MSVC。普通安装使用 VSIX 中的预构建资源。
