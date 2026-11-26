# 0.1.20 文件预览紧邻 Explorer

创建工作台分组时读取 VS Code 主侧栏的位置。Explorer 在左侧时按 Explorer、文件、AIO 排列，Explorer 在右侧时按 AIO、文件、Explorer 排列。文件组保持可打开，AIO 工作台使用独立锁定组。Windows 鼠标区域检测支持两种方向。

49 项自动测试通过。分别用左右侧栏的隔离 VS Code 1.97 安装 0.1.20，先聚焦 AIO，再从 Explorer 连续点击两个文件，通过原生编辑器和 Webview 的几何位置确认顺序。验收覆盖从单组启动的标准两组布局；用户自定义的多组布局仍保留。
