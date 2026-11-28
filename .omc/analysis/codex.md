# AIO for VS Code 功能分析

分析基线为扩展 0.1.35（本地 HEAD `9be8065`）。以下以仓库代码、打包清单和生成产物为实现证据，文档中的验收结果注明为历史记录。结论涉及行为推断时单独标明。

## 1. 项目定位与目标用户

AIO 是一个 VS Code 桌面扩展。它提供项目目录中的本机 AI CLI 快捷入口，也把上游 AIO 的 React 工作台和 Node 服务接进 VS Code。目标用户可以从实现推断为已经安装并配置 OMP、Claude Code 或 Codex CLI，希望在 IDE 中切换项目、恢复会话、并行使用终端的开发者。启动器继承现有 CLI 的安装和登录状态。扩展在工作区宿主运行，仅支持受信任、非虚拟工作区。证据见 `README.md:3-17`、`DEVELOPMENT_PLAN.md:5-15`、`package.json:2-18`。

## 2. 用户可见功能与入口

| 功能组 | 入口 | 实现行为与证据 |
|---|---|---|
| 本机 CLI 启动与诊断 | 活动栏 **AIO → 编程智能体**、Explorer 的 **AIO**、目录右键、命令面板。命令为 `aio.openTerminal`、`aio.openOmp`、`aio.openClaude`、`aio.openCodex`、`aio.detectClis` | 每次启动一个独立的 VS Code 集成终端。工作目录优先取显式目录或当前文件所属工作区，必要时提示选择。CLI 路径可通过三项机器级配置覆盖。见 `package.json:26-31,57-76`、`src/extension.js:20-31`、`src/launcher.js:8-42,88-137`。 |
| 打开工作台与布局 | `aio.openWorkbench`、AIO 树或目录右键，受信任窗口启动时自动打开 | 每个窗口复用一个工作台，允许与原生文件编辑器并排。简单双组布局下支持预览区显隐，左侧项目栏和右侧检查器可通过标题栏按钮展开与固定，子页面可逐层返回。工作台默认深色。见 `src/extension.js:31-36`、`src/workbench.js:404-443`、`src/preview-group.js:108-235`、`src/panel-auto-hide.js:166-249`、`workbench/ui/index.html:2`、`README.md:31-43`。 |
| 项目库与工作区切换 | 工作台项目列表及目录选择器、拖放目录、Explorer 的导入节点或 `aio.importProjectInWorkbench`。点击登记项目主行触发切换，另有隐藏命令 `aio.openRegisteredProject` | 导入只登记项目。当前 VS Code 根目录会反向同步，路径去重，移除标记避免旧资料重新加入。点击登记项目可在当前窗口打开目录并恢复工作台。见 `package.json:36-61`、`src/file-reference-tree.js:34-103`、`src/project-registry.js:73-97,123-197`、`src/workbench.js:338-403,655-667,721-729`。 |
| 路径引用与剪贴板 | Explorer 右键 `aio.referenceInWorkbench`、引用拖入节点、Webview 输入区。原生终端标题栏使用 `aio.copyTerminalSelection` / `aio.pasteIntoTerminal`，内嵌终端上下文命令为 `aio.copyWorkbenchTerminalSelection` / `aio.pasteIntoWorkbenchTerminal` | 校验、引用文件或目录路径后插入可见草稿或终端输入，无自动提交或文件正文读取。内嵌终端支持有选区时 Ctrl+C、Ctrl+V、直接右键粘贴及 Shift+右键菜单。见 `README.md:7-13,45-49`、`src/file-drop.js:83-167,239-309`、`src/webview-bridge.js:33-113`、`src/launcher.js:156-167`。 |
| 会话与历史 | 项目旁按 OMP、Claude Code、Codex 展开的历史列表 | 按项目和 CLI 惰性加载本地历史，以首条用户输入或可用标题标记条目。已加载条目的预览可在重开时显示，点击条目通过相应原生 CLI 恢复。见 `src/history-view.js:16-73`、`src/lazy-history.js:25-66,78-147`、`src/workbench.js:605-650`。 |
| 工作台工具与任务 | 插件、设置、项目、活动、检查器、终端抽屉、底部对话框和 Bot 选择器 | 提供 CLI 插件启停和可执行文件选择、模型目录、Claude/Codex 流式对话、三种 CLI 后台任务、三种内嵌交互终端及基础 Git 操作。可选择无 Bot 或三种 Bot，底部输入跟随所选 Bot，即使当前查看另一个终端。技能、浏览器、长任务及更新器的限制见第 7 节。证据见 `README.md:25-29,51-61`、`workbench/service/workbench-service.cjs:31071-31209,31223-31328`、`workbench/ui/assets/index-B_10KawI.js:2`、`test/bridge.test.js:13-30`。 |

## 3. 架构与关键模块

主要调用链为 **React 工作台 → VS Code Webview 桥 → 扩展宿主 → Node 服务 → CLI / PTY / 本地存储**。原生启动器从扩展宿主直接走 VS Code 终端 API。服务层通过 stdout 返回请求结果和事件，PTY 输出由服务再推回 Webview。见 `src/launcher.js:88-116`、`src/webview-bridge.js:160-238`、`src/workbench.js:95-174,471-498`、`workbench/service/workbench-service.cjs:30821-30844,31559-31616`。

| 模块 | 职责与关键交互 |
|---|---|
| `src/extension.js` | 激活时装配启动器、项目登记、工作台和 Explorer 引用树，优先恢复项目交接。见 11–36 行。 |
| `src/discovery.js`、`src/launcher.js` | 探测机器配置、PATH、平台候选路径及扩展名，选择可信工作目录并创建终端。Windows 的 `.cmd/.bat` 用命令解释器和独立环境变量传参，`.ps1` 用 PowerShell，普通可执行文件直启。见前者 7–106 行、后者 8–117 行。 |
| `src/workbench.js`、`src/webview-bridge.js` | 宿主管理面板、CSP 和资源路径、原生选择器、请求 ID 与事件转发，使用 stdio 逐行 JSON 连接服务。面板先渲染，服务准备后处理请求，随后同步项目，关闭标签清理后台服务。桥兼容上游 Tauri 调用接口并管理 xterm 焦点与剪贴板。见前者 38–225、444–513、515–714 行，后者 22–132、160–253 行。 |
| `src/project-registry.js`、`src/project-handoff.js` | 用户级登记表按 URI scheme、远程 authority 和路径识别项目，串行合并项目表与服务状态。切换使用按目的目录存储的短时交接，保留当前远程 authority。见前者 8–24、65–184 行，后者 5–82 行。 |
| `src/file-drop.js`、`src/file-reference-tree.js` | 识别 Explorer 和 Webview 拖放格式，校验、解析并格式化路径，区分导入项目和引用输入。见前者 8–52、83–196、239–309 行，后者 6–114 行。 |
| `src/history-view.js`、`src/lazy-history.js` | 在项目树上挂载历史入口，读取 CLI 特有存储并缓存列表。OMP 和 Claude 读取会话文件片段，Codex 以只读 SQLite 查询线程。恢复参数分别为 OMP `--resume <文件>`、Claude `--resume <ID>`、Codex `resume <ID>`。见前者 16–75 行、后者 35–66、78–167 行。 |
| `src/panel-auto-hide.js`、`src/panel-auto-hide.css`、`src/preview-group.js`、`src/preview-hover.ps1` | Webview 控制左右侧栏、内容避让和标题栏触发器。宿主管理原生编辑器组，Windows 观察器利用 UI Automation 与鼠标位置回报悬停。见各文件 8–69、5–85、30–68 与 108–235、21–63 与 66–113 行。 |
| `workbench/ui/` | `index.html:2-10` 是入口，`assets/` 是 Vite 生成的带哈希 JS/CSS，含 React 主界面、终端抽屉、转录及项目、插件、设置、活动等页面和 vendor 包。入口对服务方法的调用见 `workbench/ui/assets/index-B_10KawI.js:2`。 |
| `workbench/service/` | `workbench-service.cjs` 汇集项目、设置、SQLite、会话、模型、Git、任务、PTY 和 Bot；`omp-metadata-worker.cjs` 支撑会话元数据读取；另有 Bot CLI、Codex 编辑器桥、OMP 配置、Windows PTY 宿主和随包 `node-pty`。见 `workbench/manifest.json:19-32,87-93`、`workbench/service/workbench-service.cjs:31331-31416,31559-31616`。 |

## 4. 技术栈、运行时依赖与打包

- 扩展使用 CommonJS JavaScript 和 VS Code Extension API，声明 VS Code `^1.97.0`。工作台优先探测扩展宿主自带 Node，次选 PATH 中可执行的 Node，最低 22.13 且需能加载 `node:sqlite`。生成服务的构建目标是 Node 24。工作台资料落在扩展 `storageUri` 或空窗口的 `globalStorageUri` 下。见 `package.json:10-18`、`src/workbench.js:19-22,38-80,444-494`、`workbench/manifest.json:16-18`。
- Webview 使用 React 19、xterm 6、Markdown/GFM 等依赖。服务使用 `node-pty`、原生 Windows 终端宿主、SQLite 与 CLI 子进程。仓库内工作台内嵌终端按 Windows x64 预构建，普通安装直接使用这些产物。第三方依赖与许可证记录位于 `workbench/manifest.json:28-115` 和 `workbench/licenses/`。见 `README.md:59-63`、`workbench/service/workbench-service.cjs:30840-30844`。
- 重建入口以外部上游 `Ancoder/AIO` checkout 的 `research/tauri-spike` 为基础，使用 Vite/React 插件构建 UI、esbuild 打包服务，服务源码通过 Git 归档提取固定 Bot 提交。Windows 宿主使用 Cargo 和 MSVC，原生 PTY 预构建物由脚本复制。VSIX 由 `vsce package --no-dependencies` 生成，prepackage 检查随包资产。见 `scripts/build-workbench.cjs:15-34,98-105,371-403,689-715,773-807`、`scripts/check-workbench.cjs:1-20`、`package.json:19-24`、`.vscodeignore:1-18`。

## 5. 三种 CLI 的启动、上下文与 Bot 协议

| CLI | 工作台启动和对话方式 | Bot / worker 指令注入 |
|---|---|---|
| OMP | 原生入口和工作台终端随附关闭输入预测的 OMP 配置。后台 Agent 使用 OMP RPC 并指定 cwd，可传恢复文件。 | 通过 `--append-system-prompt=<内容>` 追加角色指令。见 `src/launcher.js:88-116`、`workbench/service/aio-omp-config.yml:1-2`、`workbench/service/workbench-service.cjs:2805-2820,30582-30585,30928-30948`。 |
| Claude Code | 内嵌终端按是否已有会话使用会话 ID、恢复或继续方式。流式对话适配器用 CLI 的 stream-json，与会话 ID 关联。 | 通过 `--append-system-prompt` 和独立参数追加角色指令。见 `workbench/service/workbench-service.cjs:1360-1399,1538-1555,28479-28487,30582-30585,30928-30948`。 |
| Codex CLI | 内嵌终端通过原生 CLI 参数恢复。流式适配器启动 `codex app-server`，经 stdio 创建或恢复线程并提交 turn。新 worker 的 UTF-8 首任务可作为单个原生位置参数交给 CLI。 | 通过 `-c developer_instructions=…` 注入角色指令；已运行的 Windows 终端使用独立临时目录和外部编辑器握手回填多行任务。见 `workbench/service/workbench-service.cjs:853-863,1045-1109,2157-2229,30582-30585,30911-30948,31250-31265`、`scripts/aio-codex-editor.cjs:41-105`。 |

工作目录构成初始项目上下文。用户引用的路径写入草稿，CLI 是否读取相关文件由随后提交的请求和 CLI 行为决定。工作台对话、CLI 终端输入和 Bot 投递各有明确入口。见 `src/file-drop.js:83-112,139-165`、`workbench/service/workbench-service.cjs:31015-31035,31102-31112,31242-31269,31287-31298`。

Bot 控制器绑定动态端口的本机回环 HTTP，通过按会话签发的 Bearer 凭据识别 Bot。创建的 worker 继承项目与 cwd、可选模型和工具入口，同时收到权限限于报告的独立凭据。控制脚本提供 `list`、`create`、`send`、`close`、`events`、`report`。服务支持列出和创建会话所属终端、按 ID 投递和关闭、长轮询消费事件以及报告状态。worker 报告由服务附加终端 ID，终端退出与任务报告分别记录，关闭 Bot 时关联 worker 会清理。成功投递表示输入已送达，任务状态由报告或退出事件体现。见 `workbench/service/aio-bot-cli.cjs:27-35,60-140`、`workbench/service/workbench-service.cjs:30635-30690,30708-30812,31559-31577`、`docs/BOT_DEVELOPMENT_PLAN.md:5-11`。

## 6. 构建、测试与验证

| 用途 | 命令或前置条件 |
|---|---|
| 从预构建资产打包或安装 | 准备 VS Code 打包工具后运行 `npm run package`。安装使用 `code --install-extension dist/aio-ide.vsix`，开发窗口用 `code --extensionDevelopmentPath=. .`。`node scripts/check-workbench.cjs` 可独立检查打包前置文件。见 `package.json:19-24`、`README.md:19-21`。 |
| 重建工作台 | 将 `AIO_SOURCE` 指向装有开发依赖的上游 checkout，准备 Git、tar，Windows 准备 Rust/Cargo 和 MSVC，运行 `npm run build:workbench`。可用 `node scripts/build-workbench.cjs --verify-synced-upstream` 检查上游提交和特征。见 `README.md:63`、`scripts/build-workbench.cjs:15-55,371-395,689-698,835-870`。 |
| 自动测试 | `npm test` 执行 `node --test test/*.test.js`，覆盖探测和引号、Webview 消息、项目登记和交接、拖放、主题与布局、历史惰性加载、Bot CLI 和 Codex 编辑器桥，以及 Windows 的 PTY 测试。见 `package.json:19-23`、`test/launcher.test.js:13-113`、`test/lazy-history.test.js:15-59`、`test/bot-runtime.test.js:15-73`、`test/workbench-terminal.test.js:13`。 |
| 真实扩展宿主 | Windows 设置 `VSCODE_EXECUTABLE_PATH`，运行 `node test-host/run-smoke.cjs` 使用隔离目录与 CLI 夹具。加 `--installed` 验证 PATH 中三个真实 CLI 可并存和退出，不发任务。见 `test-host/README.md:5-20`。 |
| 桌面 UI / VSIX | 设置 `VSCODE_EXECUTABLE_PATH` 为 `Code.exe`，通过 `AIO_SOURCE` 提供 Playwright，运行 `node test-host-ui/verify-workbench.cjs dist/aio-ide.vsix`。可设置 `AIO_TEST_BOT_UI=1`、`AIO_TEST_CODEX_SUBMISSION_EXE`、`AIO_TEST_NATIVE_DROP=1` 等。项目正反向同步和自启动还有 `verify-project-switch.cjs`、`verify-reverse-sync.cjs`、`verify-autostart.cjs` 独立入口，接收 VSIX 路径。见 `test-host-ui/verify-workbench.cjs:59-104,113-123,151-236`、`test-host-ui/verify-project-switch.cjs:128-133`、`test-host-ui/verify-reverse-sync.cjs:105-110`、`test-host-ui/verify-autostart.cjs:82-87`、`docs/BOT_DEVELOPMENT_PLAN.md:13-17`。 |

本次实际执行 `node scripts/check-workbench.cjs`，退出码为 0。功能与风险结论来自静态审阅。测试套件、桌面 UI、真实账号和 Git 写操作本次未运行。`docs/execution/` 记录逐版改动及相应复验，`docs/user-input/` 保存按北京时间归档的用户需求，归档和执行总结规则见 `AGENTS.md:1-7`。历史验收的环境和范围见 `DEVELOPMENT_PLAN.md:21-30`、`docs/execution/2026-11-27-workbench-bot.md`、`docs/execution/2026-11-27-codex-warm-multiline.md`、`docs/execution/2026-11-27-async-runtime-probe.md`。

## 7. 风险、局限与待完善点

| 项目 | 证据和影响 |
|---|---|
| 原生构件的架构限制 | 内嵌 PTY 服务明确拒绝非 Windows，随包原生构件为 win32-x64。Remote 场景中路径和可执行文件以扩展宿主为准。其他组合的工作台及完整终端体验缺少当前仓库验收证据。见 `package.json:10-18`、`README.md:17,61`、`workbench/manifest.json:16-25`、`workbench/service/workbench-service.cjs:30840-30844`。 |
| 上游界面覆盖范围 | 服务对更新器返回 unsupported，长任务与技能执行查询返回空值，浏览器返回空状态，通用插件发现返回待迁移提示；编程 CLI 插件注册有单独的已实现接口。见 `src/workbench.js:654`、`workbench/service/workbench-service.cjs:31074-31090,31306-31314`。 |
| CLI 版本耦合 | 历史依赖 CLI 的目录命名、会话字段和 Codex threads 表，列表和首段读取受上限约束。Windows Codex 多行投递依赖外部编辑器及 TUI 就绪、粘贴模式信号，已有草稿时主动停止。推断是 CLI 升级可能改变历史可见性或自动投递时序。见 `src/lazy-history.js:11-13,35-66,88-147`、`workbench/service/workbench-service.cjs:2157-2229,30911-30925`。 |
| 前端和预览维护成本 | 侧栏、历史和预览依赖生成页面的选择器、Windows UI Automation 和简单双组布局。构建还对特定生成片段打补丁。推断是升级上游渲染器或 VS Code 后，这些适配比原生终端启动路径更容易出现回归。README 已记录部分 Windows 版本的 Webview 拖放回归及 Explorer 备用入口。见 `src/history-view.js:61-73`、`src/preview-group.js:15-25,108-162`、`src/preview-hover.ps1:21-63`、`scripts/build-workbench.cjs:285-350`、`README.md:43-47`。 |
| 文档与产物版本差异 | README 标注工作台 2.0.1，开发方案记载初始基线 2.0.1；当前生成清单标注 2.0.2 和两个已同步提交，扩展自身版本为 0.1.35。见 `README.md:59`、`DEVELOPMENT_PLAN.md:19`、`workbench/manifest.json:2-14`、`package.json:5`。 |
| 验收范围 | 历史记录中模型响应采用夹具，模型目录、活动记录和 Git 并未逐项用真实账号与写操作验收。Codex UI 复验可启动真实 CLI，模型端仍用本地模拟接口。见 `DEVELOPMENT_PLAN.md:23-28`、`docs/BOT_DEVELOPMENT_PLAN.md:9-15`、`test-host-ui/verify-codex-submission.cjs:13-71`。 |

## 8. 可复核结论摘要

1. **高置信度。** 0.1.35 扩展启动时注册三个 CLI 快捷入口，并在受信任窗口打开或恢复工作台。见 `package.json:5,12-18`、`src/extension.js:11-36`。
2. **高置信度。** 原生终端由 VS Code 管理，内嵌终端由 Webview 后方独立服务管理。见 `src/launcher.js:88-116`、`src/workbench.js:95-122`、`workbench/service/workbench-service.cjs:30840-30844,31223-31269`。
3. **高置信度。** 文件引用插入路径，项目导入只更新库，项目切换会打开目标文件夹并交接。见 `src/file-drop.js:83-112,139-196`、`src/workbench.js:338-403`。
4. **高置信度。** 三 CLI 的历史按项目展开加载，点击条目通过原生 CLI 恢复。见 `src/history-view.js:16-55`、`src/workbench.js:619-650`。
5. **高置信度。** Bot 管理会话所属 worker，worker 可报告状态，终端退出单独产生事件。见 `workbench/service/workbench-service.cjs:30644-30690,30723-30799`。
6. **高置信度。** Codex 首任务走原生参数，Windows 已有会话的多行任务通过外部编辑器握手，保留已有草稿。见 `workbench/service/workbench-service.cjs:2157-2229,31250-31259`。
7. **高置信度。** 随包工作台清单为 AIO 2.0.2、目标 Node 24、Windows x64，宿主运行时最低 Node 22.13；资产预检通过。见 `workbench/manifest.json:2-25`、`src/workbench.js:19-22,47-80`、`scripts/check-workbench.cjs:1-20`。
8. **高置信度。** 浏览器、长任务、通用技能执行和更新器仍有迁移缺口，真实账号和 Git 写操作覆盖有限。见 `workbench/service/workbench-service.cjs:31306-31326`、`DEVELOPMENT_PLAN.md:25-30`。
