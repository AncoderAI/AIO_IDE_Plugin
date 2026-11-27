# AIO for VS Code 开发方案

## 源码分析

基线为 AIO 仓库的 `research/tauri-spike`。根 README 的 OMP 单后端说明描述早期桌面版。Tauri 的 `workbench-service.ts` 在 `resolveTerminalAgent` 明确支持 OMP、Claude Code、Codex，先解析已安装的程序，再传入会话参数。不同终端有独立生命周期。

`workbench-renderer.ts` 将 React 工作台接入请求和事件。`src-tauri/src/workbench.rs` 管理 Node 服务、原生目录选择、可执行文件选择及进程退出。`workbench-service.ts` 实现项目、设置、会话、模型、Git、CLI 插件和任务等操作。`README.md` 区分已连接的功能和仅有探针或仍待迁移的功能。仅凭渲染层存在菜单不能判定后端已实现。

## 迁移步骤与验收

1. 建立 VS Code 扩展，在命令面板及目录右键提供统一入口，选择三种本机 CLI 之一。解析可信的用户配置与 PATH，在选中目录中创建独立的集成终端。验收带空格路径、多根工作区、程序缺失、取消与多终端并存。
2. 为完整工作台复用上游渲染器与服务协议，将 Tauri 请求、事件和文件选择适配到 VS Code。扩展宿主负责工作台进程生命周期，VS Code 管理原生终端。区分来源已实现的功能和预览版自身限制。
3. 提供可安装的 VSIX、使用说明、自动测试与本机验证记录。方案、可运行功能和验证结果分别提交并推送到当前 Git 远端。

用户已有的 CLI 安装及账户是运行前提。打开 CLI 不触发安装、登录或发送模型请求。以 Windows 为首要验收平台。

## 交付与验收记录

基线为 AIO 2.0.1，提交 `def7f85df4ccff835aac67e3c2a5eb431c356d29`。生成资源和依赖清单位于 `workbench/manifest.json`，可从同一上游版本重新构建。

| 能力 | 扩展入口 | 本次验收 |
| --- | --- | --- |
| 本机三 CLI 启动 | 资源管理器 AIO、目录右键、命令面板 | 在真实 Extension Host 同时启动本机三个 CLI，观察到三个进程和三个独立终端。另用夹具验证 shim、路径特殊字符、工作目录与信任限制 |
| 工作台界面及桌面桥接 | 完整工作台 | 在隔离的 Windows x64 VS Code 1.147.0 中安装 VSIX，从已渲染的 React 页面经消息桥读取版本和三个插件 ID |
| 项目、任务和会话 | 工作台项目和编程智能体 | 上游 `verify-cli-plugins.mjs` 在生成的服务上通过。覆盖 21 个项目持久化、插件启停、三种后台任务恢复、流式更新及取消。模型响应使用测试夹具 |
| 工作台内嵌 PTY | 项目终端抽屉 | 三个 provider 分别创建终端、改变尺寸、处理输入、返回计算结果并发出退出事件 |
| 模型目录、活动记录、基础 Git 操作 | 工作台对应页面 | 复用上游服务。未逐项进行真实账号和 Git 写操作验收 |
| 工作台宿主管理 | 编辑器标签页 | 自动测试覆盖并发打开和旧请求回调隔离；按工作区存储资料 |

运行 `npm test` 可复查启动器、桥接和内嵌终端。将环境变量 `VSCODE_EXECUTABLE_PATH` 设为桌面版 `Code.exe` 的绝对路径后，可运行 `node test-host-ui/verify-workbench.cjs dist/aio-ide.vsix` 复查安装包和真实界面。该脚本从上游开发环境加载 Playwright。三 CLI 的集成终端验收见 [README 的 Windows 扩展冒烟测试](README.md#操作说明)。
