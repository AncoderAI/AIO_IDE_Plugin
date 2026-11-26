# 0.1.9 内嵌 CLI 终端剪贴板

在实际 xterm 实例上注册选区读取、粘贴、聚焦和可见性检查。VS Code 的工作台右键菜单只在终端区域提供「复制」「粘贴」。菜单通过扩展宿主访问系统剪贴板；普通工作台消息不能请求读取剪贴板。

在内嵌终端内，Ctrl+C 对已有选区执行复制，Ctrl+V 使用浏览器粘贴通路。没有选区时保留 CLI 的 Ctrl+C 中断行为。底部聊天框仍按普通文本框处理。

Windows 真实 VS Code 验收使用离线 CLI 夹具启动工作台 TerminalDrawer。鼠标选区、Ctrl+C、Ctrl+V、右键菜单「复制」「粘贴」全部通过。两种粘贴方式均在按下 Enter 后才提交中文文本；测试结束后恢复系统剪贴板。测试入口为 `AIO_TEST_WORKBENCH_CLIPBOARD=1` 下的 `test-host-ui/verify-workbench.cjs`。
