# AIO for VS Code 开发方案

## 源码分析

基线为 AIO 仓库的 `research/tauri-spike`。根 README 的 OMP 单后端说明描述早期桌面版。Tauri 的 `workbench-service.ts` 在 `resolveTerminalAgent` 明确支持 OMP、Claude Code、Codex，先解析已安装的程序，再传入会话参数。不同终端有独立生命周期。

`workbench-renderer.ts` 将 React 工作台接入请求和事件。`src-tauri/src/workbench.rs` 管理 Node 服务、原生目录选择、可执行文件选择及进程退出。`workbench-service.ts` 实现项目、设置、会话、模型、Git、CLI 插件和任务等操作。`README.md` 区分已连接的功能和仅有探针或仍待迁移的功能。仅凭渲染层存在菜单不能判定后端已实现。

## 迁移步骤与验收

1. 建立 VS Code 扩展，在命令面板及目录右键提供统一入口，选择三种本机 CLI 之一。解析可信的用户配置与 PATH，在选中目录中创建独立的集成终端。验收带空格路径、多根工作区、程序缺失、取消与多终端并存。
2. 为完整工作台复用上游渲染器与服务协议，将 Tauri 请求、事件和文件选择适配到 VS Code。扩展宿主负责工作台进程生命周期，VS Code 管理原生终端。区分来源已实现的功能和预览版自身限制。
3. 提供可安装的 VSIX、使用说明、自动测试与本机验证记录。方案、可运行功能和验证结果分别提交并推送到当前 Git 远端。

用户已有的 CLI 安装及账户是运行前提。打开 CLI 不触发安装、登录或发送模型请求。以 Windows 为首要验收平台。
