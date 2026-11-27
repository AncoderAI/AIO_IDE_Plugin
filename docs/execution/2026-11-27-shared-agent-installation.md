# 共享编程智能体的安装状态

旧版按工作区保存三个插件的状态和清单。新版把这两项保存在当前 VS Code 扩展的全局存储中，首次升级按插件迁移旧工作区记录，项目、会话继续使用工作区存储。独立窗口写入时加锁，读取时重新读取已提交状态。

69 项测试通过。使用独立 Windows VS Code 配置，从项目 A 安装三个插件，打开 B 确认仍已启用，在 B 禁用 Codex 后回到 A 确认状态保留。自动测试还覆盖迁移、卸载和并发更新。0.1.56 已安装到本机 VS Code。

## macOS 适配判断

建议沿用同一个扩展 ID 和代码库。共享存储使用 Node 文件与路径 API。内嵌终端当前有 Windows 平台检查，Windows 包内含终端宿主和 ConPTY 组件。macOS 应接入 Unix PTY，按本机 shell 启动，分别在 Apple Silicon 和 Intel 上验证原生组件、输入输出、调整尺寸、退出、Bot 投递与预览交互。Windows 的 PowerShell 悬停观察器已有平台保护。通过验证后可用同一扩展 ID 发布 win32-x64、darwin-arm64、darwin-x64 平台包。本次未构建或验证 macOS 安装包。

[VS Code 平台包说明](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platformspecific-extensions)
