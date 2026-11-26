# 0.1.21 对照上游 Tauri 提交

核对 AIO 的 492adf86872f0bb05723e67a8290690c7baf506c。Windows Claude 检测、可执行文件覆盖、插件状态和后台会话适配已经存在于随包 sidecar。VS Code 的原生文件选择框补齐了上游的 .exe 过滤条件。页面栈、深色默认、左右按钮及终端布局继续使用当前插件的实现。

在 Windows 上运行上游 verify-cli-plugins.mjs，对本仓库的 workbench-service.cjs 验收通过。宿主桥接的 13 项定向测试通过。打包排除本地 .omc 工具目录。
