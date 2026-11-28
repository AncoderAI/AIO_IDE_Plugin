# AIO for VS Code（aio-ide 0.1.36）功能与架构只读分析报告

- 分析对象：`D:\Github\Ancoder\AIO_IDE_Plugin`
- 分析分支：`codex/workbench-bot`（工作区含未提交改动）
- 扩展版本：`0.1.36`（`package.json:5`；分析开始时为 `0.1.35`，分析期间工作区出现并发改动，已将版本号与 `.vscodeignore` 更新到当前状态）
- 工作台上游：Ancoder/AIO `2.0.2`，提交 `561bc25d4aeeec8310ab279e52e997b0f3ad1988`（`workbench/manifest.json:2-5`）
- 分析方式：只读阅读源码、文档与测试；执行了 `npm test`（分析中与并发改动后各一次，均为 58/58 通过）
- 证据约定：`相对路径:行号`，行号以当前工作区文件为准；并发改动可能使个别行号随后漂移

---

## 0. 执行摘要

AIO for VS Code 是“两层产品”：

1. **轻量启动器**：在 VS Code 集成终端中一键启动本机已安装的 OMP、Claude Code、Codex，并补齐终端剪贴板、路径引用、项目目录选择；
2. **完整 AIO 工作台**：把上游 AIO（原 Tauri/Electron 桌面版）的 React 界面与 Node 后台服务搬进 Webview，提供项目库、会话历史、Claude/Codex 流式对话、内嵌 PTY 终端、基础 Git 操作，以及可编排多个工作终端的 **Bot**。

核心设计是：**扩展宿主不直接运行 React/服务，而是启动一个子 Node 进程作为后台服务，通过 NDJSON 在 stdin/stdout 上做 RPC；Webview 里注入一个“伪 Tauri”桥，让上游 React 代码几乎不改地运行。**（`src/workbench.js:83-199,205-224`；`src/webview-bridge.js:249-259`；`workbench/service/workbench-service.cjs:31559-31650`）

本次验证：`npm test` 共 **58 项全部通过**（约 10.7 秒，含 Windows PTY 集成测试）。真实 VS Code / VSIX 验收脚本存在，但需要外部 `Code.exe` 与上游 Playwright，本次只读分析未执行。

---

## 1. 项目定位与目标用户

### 1.1 定位

- 扩展名与描述明确为“在项目终端中打开本机 OMP、Claude Code 和 Codex，或进入 AIO 工作台”（`package.json:3-4`）。
- README 把产品分为：
  - 资源管理器/活动栏的 **AIO 三个 CLI 入口**；
  - 独立的 **AIO 完整工作台**（`README.md` 全文，尤其“完整工作台”一节）。
- 不负责安装、登录或代理模型请求；CLI 与账户由用户自备（`DEVELOPMENT_PLAN.md` “用户已有的 CLI 安装及账户是运行前提”）。
- 以 Windows 为首要验收平台（`DEVELOPMENT_PLAN.md`），工作台内嵌终端当前按 **Windows x64** 打包（`README.md`；`workbench/service/workbench-service.cjs:30842`）。

### 1.2 目标用户

- 已安装并登录 OMP / Claude Code / Codex 的开发者；
- 使用 VS Code `^1.97.0`（`package.json:10`）；
- 在**受信任工作区**中工作（`package.json:15-17`，`src/launcher.js:72-76`）；
- 需要在一个窗口内切换项目、查看 CLI 历史、在统一界面里给 CLI 下任务，甚至让一个 Bot 调度多个编码 CLI 的用户；
- Remote 场景可用，但 CLI 必须安装在运行扩展的远程主机上（`README.md`；`package.json:12` 的 `extensionKind: ["workspace"]`）。

---

## 2. 核心功能清单（按用户可见功能分组）

### 2.1 本机 AI CLI 启动与发现

| 功能 | 用户入口 | 代码证据 |
|---|---|---|
| 选择三种 CLI 之一并打开终端 | 命令 `AIO: 选择 AI CLI 并打开终端`（`aio.openTerminal`） | `package.json:27`，`src/launcher.js:148-151` |
| 直接打开 OMP 终端 | 命令 `aio.openOmp`；活动栏 AIO 视图条目 | `package.json:28,68`，`src/launcher.js:152`，`src/extension.js:20-30` |
| 直接打开 Claude Code 终端 | 命令 `aio.openClaude` | `package.json:29`，`src/launcher.js:153` |
| 直接打开 Codex 终端 | 命令 `aio.openCodex` | `package.json:30`，`src/launcher.js:154` |
| 目录右键启动 | Explorer 右键 `AIO: 选择 AI CLI 并打开终端` | `package.json:57-61` |
| 检测本机 CLI 路径 | 命令 `AIO: 检测本机 CLI`（`aio.detectClis`） | `package.json:31`，`src/launcher.js:130-137,155` |
| 配置显式可执行文件路径 | 设置 `aio.ompPath` / `aio.claudePath` / `aio.codexPath` | `package.json:71-77`，`src/discovery.js:86-103` |
| 多根工作区选择目录 / 空窗口选择目录 | 启动时 QuickPick / OpenDialog | `src/launcher.js:17-42` |
| Windows shim 兼容 | `.cmd` / `.bat` / `.ps1` / `.exe` 分别处理 | `src/launcher.js:44-64` |
| 未受信任工作区阻止启动 | 警告并中止 | `src/launcher.js:72-76,88-95` |

### 2.2 终端输入、复制与粘贴

| 功能 | 入口 | 代码证据 |
|---|---|---|
| 复制 CLI 终端选区 | 终端标题栏按钮 / 命令 `aio.copyTerminalSelection` | `package.json:32,42-44`，`src/launcher.js:156-167` |
| 粘贴到 CLI 终端 | 终端标题栏按钮 / 命令 `aio.pasteIntoTerminal` | `package.json:33,42-44`，`src/launcher.js:156-163` |
| 工作台内嵌终端 Ctrl+C / Ctrl+V | Webview 键盘拦截 | `src/webview-bridge.js:54-66` |
| 工作台终端右键单击粘贴、Shift+右键保留菜单 | Webview contextmenu 拦截 | `src/webview-bridge.js:68-80` |
| 工作台终端复制/粘贴命令 | `aio.copyWorkbenchTerminalSelection` / `aio.pasteIntoWorkbenchTerminal` | `package.json:34-35,46-48`，`src/workbench.js:267-303,731-732` |
| 终端焦点归属控制 | 点击终端/非编辑区域获得键盘；点击表单让出 | `src/webview-bridge.js:33-117` |

### 2.3 完整工作台

| 功能 | 入口 | 代码证据 |
|---|---|---|
| 打开完整工作台 | 命令 `aio.openWorkbench`；Explorer 右键；启动时自动打开 | `package.json:39,61`，`src/workbench.js:725-735`，`src/extension.js:31-35` |
| 工作台在独立（复用右侧空组或新建）且锁定的编辑器组中打开 | 优先复用右侧空编辑器组，否则新建组，再 `lockEditorGroup` | `src/workbench.js:417-442` |
| 每窗口仅一个工作台面板 | 复用 `this.panel` / `this.opening` | `src/workbench.js:404-415` |
| React 项目库、项目会话、模型目录、Claude/Codex 流式对话、终端抽屉、基础 Git | 工作台 UI 页面 | `workbench/ui/index.html`，`workbench/ui/assets/ProjectsPage-*`、`SettingsPage-*`、`ActivityPage-*`、`TerminalDrawer-*`；RPC 分发见 `workbench/service/workbench-service.cjs:31071-31329` |
| 工作台内嵌终端（PTY） | 项目终端抽屉 | `workbench/service/workbench-service.cjs:1993-2050,31223-31305` |
| 恢复上次终端会话 | 服务关闭时保存、重启时恢复 | `workbench/service/workbench-service.cjs:31210-31221,31617-31643` |
| 基础 Git（状态/差异/暂存/取消暂存/还原/提交） | 工作台页面 | `workbench/service/workbench-service.cjs:31315-31326` |
| 主题：默认深色，可切浅色/跟随系统并持久化 | 工作台设置 | `test/default-theme.test.js:12-35`，`scripts/build-workbench.cjs:810-824` |

### 2.4 项目库、项目导入与切换

| 功能 | 入口 | 代码证据 |
|---|---|---|
| 把文件夹加入 AIO 项目库 | 工作台侧栏拖入；Explorer 拖到 `AIO → 拖入文件夹以添加项目`；右键 `在 AIO 中添加项目` | `src/file-drop.js:168-195,248-317`，`src/file-reference-tree.js:41-45,59-65,105-117` |
| 从工作台项目列表切换项目 | 点击项目名 | `src/file-drop.js:76-81,243-247`，`src/workbench.js:531-535,359-402` |
| 通过命令打开已登记项目 | `aio.openRegisteredProject` | `package.json:38,55`，`src/workbench.js:729-730` |
| 导入不改变 VS Code 工作区 | 文档与实现一致 | `README.md`；`src/file-reference-tree.js:43` |
| 打开 VS Code 文件夹时自动登记项目 | 工作区文件夹变化监听 | `src/project-registry.js:123-143,189-198`，`src/extension.js:13-18` |
| 项目删除的“墓碑”语义 | `projects:remove` 后写 removed 状态 | `src/project-registry.js:94-96,145-183`，`src/workbench.js:655-661` |
| 跨窗口项目切换交接（60 秒 TTL） | 写 globalState handoff 后 `vscode.openFolder` | `src/project-handoff.js:5-6,57-83`，`src/workbench.js:389-397` |

### 2.5 文件/文件夹引用与拖放

| 功能 | 入口 | 代码证据 |
|---|---|---|
| 将 Explorer 选中项引用到工作台输入区 | 右键 `在 AIO 对话中引用路径`（`aio.referenceInWorkbench`） | `package.json:36,58`，`src/file-reference-tree.js:92-104` |
| 拖到 Explorer 的 AIO 引用节点 | 原生 TreeView 拖放 | `src/file-reference-tree.js:34-88` |
| 直接拖到工作台 Composer/终端 | Webview 拖放 | `src/file-drop.js:197-318` |
| 引用格式与限制 | `@"绝对路径"`，最多 16 项，64 KiB，拒绝控制字符 | `src/file-drop.js:8-11,20-26,139-166` |
| 只引用不发送、不读取正文 | 插入光标处并触发 input 事件 | `src/file-drop.js:83-112` |
| 工作台项目导入拖放 | 侧栏 `.sidebar` 作为投放目标 | `src/file-drop.js:54-65,168-195` |

### 2.6 会话历史

| 功能 | 入口 | 代码证据 |
|---|---|---|
| 在项目行下显示 OMP/Claude/Codex 三个历史入口 | 注入到工作台侧栏项目分组 | `src/history-view.js:61-80` |
| 懒加载某项目某 CLI 的历史 | `aio-history:list` | `src/history-view.js:44-57`，`src/workbench.js:619-647` |
| 缓存历史并优先展示 | `workspaceState` 键 `aio.history-preview.v1.*` | `src/lazy-history.js:20-23`，`src/workbench.js:626-647` |
| 恢复历史会话 | `aio-history:resume`，按提供商拼参数 | `src/workbench.js:648-650`，`src/lazy-history.js:144-148` |
| Codex 历史来自 SQLite | 读取 `state_N.sqlite` 的 `threads` 表 | `src/lazy-history.js:52-65,88-102` |
| OMP/Claude 历史来自 JSONL | `~/.omp/agent/sessions`、`~/.claude/projects` | `src/lazy-history.js:104-142` |

### 2.7 文件预览与自动隐藏侧栏

| 功能 | 入口 | 代码证据 |
|---|---|---|
| 文件预览分组与工作台并排，2 秒后自动让位 | 工作台上缘“文件预览”入口/悬停 | `src/preview-group.js:8-9,99-159,200-221`；`README.md` |
| 左栏启动后 4 秒自动隐藏；悬停/点击按钮展开 | 工作台标题栏按钮 | `src/panel-auto-hide.js:15-46,228-247,285-293` |
| 右侧检查器自动显隐 | 标题栏第二个按钮 | `src/panel-auto-hide.js:90-95,228-247` |
| 子页面打开时锁定左栏 | `.workbench-page` 检测 | `src/panel-auto-hide.js:258-268` |
| 输入/终端区域不触发展开 | 受保护选择器 | `src/panel-auto-hide.js:8-13,296-323` |

### 2.8 Bot 编排（工作台核心差异化能力）

| 功能 | 入口 | 代码证据 |
|---|---|---|
| 底部 Bot 选择器：无 Bot / OMP / Claude Code / Codex | 工作台底部 | `test/bridge.test.js:15-35`（断言 `bot-selector` 与三个 Bot 标签）；`workbench/ui/assets/main-NrpSKFB4.js` |
| 选择 Bot 后创建 `_Bot` 终端 | 选择器 | `workbench/service/workbench-service.cjs:31261-31266` |
| Bot 创建/发送/关闭工作终端 | Bot 终端内的 `aio-bot` 控制脚本 | `workbench/service/aio-bot-cli.cjs:26-36,110-143` |
| 工作终端回报进度/阻塞/完成 | `aio-bot report <status> <summary>` | `workbench/service/aio-bot-cli.cjs:101-107,129-133` |
| Bot 拉取事件 | `aio-bot events [--wait ms]` | `workbench/service/aio-bot-cli.cjs:88-100`，服务端 `workbench/service/workbench-service.cjs:30735-30747` |
| 关闭 Bot 时清理其工作终端 | 终端退出事件 | `workbench/service/workbench-service.cjs:30658-30674` |
| 任务完成与进程退出区分 | `terminal_exit` 与 `agent_event` 分开入队 | `workbench/service/workbench-service.cjs:30658-30665,30794-30798` |

### 2.9 其他

- 工作台首次启动/重启自动打开，且每窗口一个标签（`src/extension.js:31-35`，`src/workbench.js:404-415`）。
- 设置/状态存储在 VS Code 扩展存储目录（`src/workbench.js:452-460`；`README.md`）。
- OMP 终端禁用 composer 预测文本（`workbench/service/aio-omp-config.yml`，`src/launcher.js:99-102`）。
- 活动栏/资源管理器两个 AIO 视图（`package.json:64-70`）。

---

## 3. 架构与关键模块

### 3.1 分层视图

```
VS Code Extension Host (src/)
├─ extension.js                 激活、自动开工作台、注册项目登记
├─ launcher.js + discovery.js   三 CLI 发现与 VS Code 集成终端启动
├─ workbench.js                 Webview 管理 + RPC 客户端 + 项目切换/历史/预览编排
│   ├─ project-registry.js      globalState 项目登记/墓碑/VS Code 工作区同步
│   ├─ project-handoff.js       跨窗口项目切换交接
│   ├─ preview-group.js         编辑器分组布局与文件预览自动折叠
│   ├─ lazy-history.js          OMP/Claude JSONL 与 Codex SQLite 历史
│   └─ file-drop.js             Webview 拖放（双端共用）
├─ file-reference-tree.js       Explorer 原生拖放树
├─ webview-bridge.js            Webview 内伪 Tauri 桥
├─ panel-auto-hide.js/css       Webview 侧栏自动显隐（DOM 注入）
└─ history-view.js              Webview 历史区域（DOM 注入）

Child Node process (workbench/service/)
├─ workbench-service.cjs        NDJSON RPC 服务；项目/会话/模型/编码会话/PTY/Git/Bot
├─ aio-bot-cli.cjs              Bot 控制 CLI（HTTP 客户端）
├─ aio-codex-editor.cjs         Codex 外部编辑器助手（多行回填）
├─ omp-metadata-worker.cjs      OMP 元数据子进程
├─ aio-terminal-host.exe        Rust PTY 前台进程
└─ node_modules/node-pty        Windows ConPTY 绑定

Webview (workbench/ui/)
└─ 上游 AIO 2.0.2 React 构建产物 + 三个注入脚本
```

### 3.2 关键模块职责与交互

| 模块 | 路径 | 职责 | 关键交互 |
|---|---|---|---|
| 扩展入口 | `src/extension.js` | 注册启动器、项目登记、工作台；启动完成后恢复项目交接或自动打开工作台 | 调用 `registerLauncher`、`new ProjectRegistry`、`registerWorkbench`、`resumeProjectHandoff`（`src/extension.js:11-36`） |
| 启动器 | `src/launcher.js` | 解析工作目录、发现可执行文件、构造 VS Code 终端、剪贴板命令 | `discoverCli`（`src/discovery.js:86-103`）、`createTerminal`（`src/launcher.js:103-108`） |
| 可执行文件发现 | `src/discovery.js` | 配置路径展开、PATH/PATHEXT/常见目录搜索、绝对路径校验 | 供启动器与 `aio.detectClis` 使用 |
| 工作台宿主 | `src/workbench.js` | 创建 Webview、CSP、宿主消息校验、子服务生命周期、通道转发、项目切换、文件引用、剪贴板、历史 | `WorkbenchHost` 与 `WorkbenchService`（`src/workbench.js:83-199,232-723`） |
| Webview 桥 | `src/webview-bridge.js` | 把 `__TAURI__.core.invoke` / `event.listen` 映射为 VS Code postMessage；终端键盘/剪贴板 | 与宿主 `aio:request`/`aio:event` 协议（`src/webview-bridge.js:160-259`） |
| 工作台服务 | `workbench/service/workbench-service.cjs` | 子进程；NDJSON 请求分发；项目/会话/编码 CLI/PTY/Git/Bot | `dispatch()`（`:31071-31329`）、主循环（`:31559-31650`） |
| 终端服务 | 同上 | `node-pty` 创建 PTY；输入/尺寸/退出；任务提交；输出限流；Codex 多行 | `TerminalService`（`:1993-2330`） |
| Bot 控制 | 同上 | 本机回环 HTTP 服务；会话/令牌/工作终端归属；事件队列 | `BotControlService`（`:30615-30810`） |
| 项目登记 | `src/project-registry.js` | 以 `scheme+authority+realpath` 哈希为 globalState 键；active/removed 状态 | 与服务 `projects:add-selected/remove` 同步（`:145-183`） |
| 项目交接 | `src/project-handoff.js` | 单文件夹工作区匹配；写 60 秒 handoff；目标窗口恢复 | `vscode.openFolder` 前写入（`src/workbench.js:389-397`） |
| 历史 | `src/lazy-history.js` | 逐文件读取 32KB 预览；Codex 用 `node:sqlite` | 通过宿主的 `aio-history:*` 暴露（`src/workbench.js:619-650`） |
| 预览分组 | `src/preview-group.js` | 记录基线布局、最大化切换、悬停/文件编辑时不折叠 | Windows PowerShell 悬停观察器（`:30-69`） |
| 侧栏自动隐藏 | `src/panel-auto-hide.js` | MutationObserver 适配 React DOM，注入按钮，管理左右栏 | 通过工具栏按钮点击触发 React 状态（`:90-126`） |
| 历史注入 | `src/history-view.js` | 在 `.sidebar .project-group` 内插入三提供商历史区 | 调用 `desktop_request` 的 `aio-history:*`（`:16-58`） |

### 3.3 启动与请求时序

1. VS Code 启动后触发 `onStartupFinished`（`package.json:14`）。
2. `activate()` 注册启动器、项目登记、工作台，启动项目登记（`src/extension.js:11-18`）。
3. 若无项目交接且工作区受信任，自动 `workbenchHost.open()`（`src/extension.js:31-35`）。
4. `WorkbenchHost.createPanel()`：
   - 读取 `workbench/ui/index.html`；
   - 优先复用右侧空组或新建组，然后锁定（`src/workbench.js:417-442`）；
   - **先设置 HTML 与消息监听器**，再启动子服务（`src/workbench.js:488-500`），因此首屏不必等待服务与项目同步；
   - 选择 Node 运行时（要求 `node:sqlite`，最低 22.13）并 spawn 服务（`src/workbench.js:38-81,95-123`）。
5. Webview 加载时，`renderWorkbenchHtml` 注入严格 CSP，并按顺序注入桥、拖放、侧栏、历史脚本（`src/workbench.js:205-224`）。
6. React UI 通过 `window.__TAURI__.core.invoke('desktop_request', {channel,args})` 发请求；桥转成 `aio:request`；宿主校验后调用 `service.request(channel,args)`；服务以 `{id,result|error}` 行回包（`src/webview-bridge.js:160-166,226-233`；`src/workbench.js:144-173,515-603`；`workbench/service/workbench-service.cjs:31599-31614`）。
7. 服务事件以 `{event,payload}` 行上行；宿主转为 `aio:event`；React 的 `event.listen` 收到（`src/workbench.js:125-141,691-693`；`src/webview-bridge.js:234-237`）。

### 3.4 服务通道（部分）

- 项目：`projects:list-initial`、`projects:add-selected`、`projects:remove`、`projects:touch`、`projects:list-worktrees`（`:31141-31177`）。
- 会话/模型：`sessions:list/read`、`providers:catalog`（`:31178-31192`）。
- OMP Agent：`agent:start/command/stop/list`（`:31193-31209`）。
- Claude/Codex 流式：`coding:send/cancel/list/read`（`:31102-31112`）。
- 后台任务：`headless:start/get/cancel`（`:31091-31096`）。
- 终端：`terminal:create/list-restorable/submit-task/input/resize/kill/...`（`:31210-31305`）。
- 插件：`coding-plugins:list/set/set-executable`（`:31074-31090`）。
- Git：`git:status/diff/stage/unstage/restore/commit`（`:31315-31326`）。
- 明确未实现：更新器 `unsupported`、浏览器空状态、插件空列表、定时任务 `null`（`:31306-31314`）。

---

## 4. 技术栈、运行时依赖与打包方式

### 4.1 技术栈

| 层 | 技术 | 证据 |
|---|---|---|
| 扩展宿主 | Node.js CommonJS，VS Code Extension API `^1.97.0` | `package.json:10,13`；`src/*.js` |
| Webview UI | 上游 AIO 2.0.2 React 19.2.8 + Vite 构建产物 | `workbench/manifest.json` 依赖列表；`workbench/ui/index.html` |
| 终端 UI | `@xterm/xterm@6.0.0` + `@xterm/addon-fit` | `workbench/manifest.json` |
| Markdown | `react-markdown@10.1.0`、`remark-gfm`、`micromark` | 同上 |
| 后台服务 | esbuild 打包为 CJS，`target: node24` | `scripts/build-workbench.cjs:386-410`；`workbench/manifest.json` `nodeTarget: "24"` |
| PTY | `node-pty@1.1.0`（Windows ConPTY） + Rust `aio-terminal-host.exe` | `workbench/manifest.json`；`scripts/build-workbench.cjs:691-697`；`workbench/service/workbench-service.cjs:1993-2050` |
| SQLite | Node 内置 `node:sqlite`（读 Codex 历史） | `src/workbench.js:53`；`src/lazy-history.js:52-65` |
| Bot 控制 | Node `http` 回环服务 + Bearer 令牌 | `workbench/service/workbench-service.cjs:30578-30810` |
| 文件监视/布局 | VS Code 命令 `vscode.getEditorLayout`、`toggleMaximizeEditorGroup`、`lockEditorGroup` | `src/preview-group.js:99-221`，`src/workbench.js:417-442` |
| 平台辅助 | PowerShell（预览悬停、剪贴板保留测试） | `src/preview-hover.ps1`，`src/preview-group.js:39-57` |

### 4.2 运行时依赖

- 根 `package.json` **没有 `dependencies`**，打包使用 `vsce package --no-dependencies`（`package.json:19-24`）。
- 扩展实际依赖：
  - VS Code 自带 Node API；
  - 工作台服务子进程的 Node ≥ 22.13（含 `node:sqlite`）；
  - `workbench/service/node_modules/node-pty`（随 VSIX 打包）；
  - `workbench/service/aio-terminal-host.exe`（Windows x64）。
- 工作台 React 依赖全部预构建进 `workbench/ui/assets`，清单见 `workbench/manifest.json:41-116`。
- 根目录**无 `package-lock.json`**；构建依赖来自上游 AIO checkout（见 7.5）。

### 4.3 打包内容与方式

- 构建：`scripts/build-workbench.cjs`
  - 以 `AIO_SOURCE`（默认 `D:/Github/Ancoder/AIO`）为上游（`:16`）；
  - 校验同步的上游特性锚点（`:38-53`）；
  - Vite 构建 UI，并在构建期对上游 `App.tsx` 做键盘/面板补丁（`:99-140` 起）；
  - `git archive` 固定提交 `561bc25…` 后 esbuild 打包服务（`:372-450`）；
  - 复制 `scripts/aio-codex-editor.cjs` 到服务目录（`:667`）；
  - Rust `cargo build --release` 生成 `aio-terminal-host.exe`（`:691-697`）；
  - 复制 `node-pty`、许可证、写 `manifest.json`（`:701-806`）；
  - 后处理默认深色主题（`:810-824`）与 Bot 清单（`:826-834`）。
- 打包前检查：`scripts/check-workbench.cjs` 校验 manifest 声明资源、`node-pty` 与 `conpty.node` 是否存在（`:1-18`）。
- VSIX 输出：`dist/aio-ide.vsix`（`package.json:23`）；`.vscodeignore` 排除测试、脚本、文档、dist 内部等（`.vscodeignore`）。
- 当前 `dist/aio-ide.vsix` 已被 git 跟踪且处于修改状态（会话开始时 `git status`）。

---

## 5. 与 OMP / Claude Code / Codex 的集成方式

### 5.1 CLI 发现

- 定义三种 CLI：`omp`、`claude`、`codex`（`src/discovery.js:7-11`）。
- 优先使用用户配置的绝对路径；否则在 PATH、`%APPDATA%\npm`、WinGet Links、`~/.local/bin` 搜索（`src/discovery.js:23-43,86-103`）。
- Windows 按 `PATHEXT` 尝试 `.exe/.cmd/.bat/.com`（`src/discovery.js:45-52`）。
- 显式配置若为相对路径或无法解析则视为未找到（`src/discovery.js:90-95`）。

### 5.2 启动方式（VS Code 集成终端）

| CLI | 启动参数/环境 | 证据 |
|---|---|---|
| OMP | `--config <拓展目录>/workbench/service/aio-omp-config.yml`；额外 `COLORFGBG` 跟随 VS Code 明暗主题 | `src/launcher.js:99-102,140-142`；配置内容 `composer.predictions: false`（`workbench/service/aio-omp-config.yml`） |
| Claude Code | 默认直接启动；无额外参数 | `src/launcher.js:153` |
| Codex | 追加 `-c disable_paste_burst=true`，避免粘贴突发被拆行 | `src/launcher.js:99-101` |
| `.cmd/.bat` | 通过 `cmd.exe /d /v:off /s /c` 调用，路径和参数经环境变量传递，避免拼接注入 | `src/launcher.js:44-54` |
| `.ps1` | 通过 `powershell.exe -NoLogo -NoProfile -File` | `src/launcher.js:55-62` |
| `.exe` | 直接作为 `shellPath` | `src/launcher.js:63` |

### 5.3 上下文注入方式

**轻量终端入口不做自动上下文注入。** 它只设置工作目录、主题环境与 Codex 粘贴参数。用户可手工引用路径：

- 引用以 `@"绝对路径"` 文本形式插入最近的 Composer 或终端输入区，**不自动发送、不读取文件正文**（`src/file-drop.js:83-112,139-166`；`README.md`）。
- 历史会话恢复通过 CLI 原生参数：
  - OMP：`--resume <sessionFile>`（VS Code 终端）/`--session-dir`（工作台）
  - Claude：`--resume <session-id>`；工作台“继续最近会话”用 `--continue`
  - Codex：`resume <session-id>`
  - 证据：`src/lazy-history.js:144-148`；`workbench/service/workbench-service.cjs:30937-30948`
- 工作台聊天/任务：React 发 `coding:send` 或 `agent:start`，服务端以非交互/流式方式启动 CLI 并回传增量（`workbench/service/workbench-service.cjs:31102-31112,31193-31203,31391-31406`）。

### 5.4 Bot 的系统提示注入

- Bot 终端会附加一段内置“AIO Bot”技能说明：
  - OMP：`--append-system-prompt=<prompt>`
  - Claude：`--append-system-prompt <prompt>`
  - Codex：`-c developer_instructions=<JSON>`
  - 证据：`workbench/service/workbench-service.cjs:30582-30586`
- Bot 提示文本与上游 `assets/omp-skills/skills/aio-bot/SKILL.md` 在构建时嵌入（`scripts/build-workbench.cjs:378-384`；运行时 `BOT_SYSTEM_PROMPT` 见 `workbench/service/workbench-service.cjs:30857`）。
- 工作终端附带更短的 Worker 提示，并要求“不要打印或泄露 `AIO_BOT_CAPABILITY`”（`workbench/service/workbench-service.cjs:30858,31251-31255`）。

### 5.5 Bot 控制协议（本机 HTTP）

**启动**：工作台服务在 `127.0.0.1` 的随机端口启动 `BotControlService`（`workbench/service/workbench-service.cjs:30692-30718`）。

**环境变量**：

| 变量 | 注入对象 | 含义 | 证据 |
|---|---|---|---|
| `AIO_BOT_API_URL` | Bot 与 Worker | 回环控制地址 | `:30642,30767` |
| `AIO_BOT_SESSION_ID` | Bot | Bot 会话 ID | `:30642` |
| `AIO_BOT_CAPABILITY` | Bot（会话令牌）/ Worker（报告令牌） | Bearer 令牌 | `:30642,30759,30767` |
| `AIO_BOT_CLI` | Bot 与 Worker | 随包 `aio-bot-cli.cjs` 绝对路径 | `:31264,31567` |
| `AIO_BOT_NODE` | Bot 与 Worker | 当前 Node 可执行文件 | 同上 |

**认证与授权**：

- 所有请求必须带 `Authorization: Bearer <token>`（`:30719-30727`）。
- Bot 会话令牌可创建/发送/关闭自己的终端；Worker 令牌**只能** `POST /v1/events` 上报，不能创建/控制其他终端（`:30728-30731`）。
- 终端操作校验 `session.workers.has(terminalId)`，越权返回 404（`:30779-30780`）。
- 令牌为 32 字节随机值；控制服务只监听回环地址（`:30708,30759`）。

**路由**：

| 方法/路径 | 作用 | 证据 |
|---|---|---|
| `GET /v1/terminals` | 列出本 Bot 创建的工作终端 | `:30732-30734` |
| `POST /v1/terminals` | 创建 `omp/claude/codex` 工作终端，可带 `model`、Codex `initialPrompt` | `:30749-30778` |
| `POST /v1/terminals/:id/input` | 向工作终端提交任务文本（≤64 KiB） | `:30781-30786` |
| `DELETE /v1/terminals/:id` | 关闭工作终端 | `:30787-30793` |
| `GET /v1/events?waitMs=` | 长轮询事件，等待上限 25 秒 | `:30735-30747` |
| `POST /v1/events` | Worker/Bot 上报事件 | `:30794-30798` |

**事件模型**：

- `terminal_created`：工作终端创建（`:30776`）。
- `agent_event`：Worker 上报（携带服务端绑定的 `terminalId`，`:30794-30797`）。
- `terminal_exit`：任意工作终端退出（`:30658-30665`）。
- 事件队列上限 256，满则丢弃最旧（`:30804-30809`）。
- Bot 终端自身退出时：丢弃 Bot 会话并杀掉其全部工作终端（`:30667-30673`）。
- Bot 完成任务与终端进程退出是两个不同事件（文档 `docs/BOT_DEVELOPMENT_PLAN.md`；实现同上）。

**Bot CLI**（`workbench/service/aio-bot-cli.cjs`）：

- `list`、`create <omp|claude|codex> [--model] [--stdin]`、`send <id> <prompt>|--stdin`、`close <id>`、`events [--wait ms]`、`report <status> <summary>`（`:26-36`）。
- `--stdin` 只允许 Codex 的首任务创建（`:69-70`），正文上限 64 KiB（`:167-176`）。
- 输出支持 `--json`；人类可读输出为 tab 分隔（`:144-153`）。

### 5.6 Codex 多行提交（Windows 工作台）

问题：直接向 PTY 写入多行文本会被 Codex 的粘贴/提交启发式拆成多次请求。

方案：

1. 服务为每个 Codex 终端创建独立 spool 目录（`workbench/service/workbench-service.cjs:30911-30926`）。
2. 将 `VISUAL`/`EDITOR` 覆盖为 `node aio-codex-editor.cjs`（`:30916-30924`）。
3. 提交多行任务时：
   - 写入 `request.json`（含 nonce、字节数、SHA-256）；
   - 向 PTY 发送 `BEL`（`\x07`）触发 Codex 外部编辑器；
   - 助手程序校验完整性、若草稿为空则写入、写 `ack.json`（`workbench/service/aio-codex-editor.cjs:43-110`）；
   - 服务等待 ack、等待终端切回就绪/括号粘贴模式，再发送 `Esc`、`Home`、`Enter`（`:2149-2213`）。
4. 若终端已有手工草稿，助手返回 `draft-not-empty`，服务报错且不覆盖（`aio-codex-editor.cjs:73-84`；服务 `:2185-2187`）。
5. 新终端的首任务仍可用 `create codex --stdin`，直接作为位置参数传入（服务 `:31256-31259`；Bot 提示 `:30857`）。

---

## 6. 构建、测试与验证方式

### 6.1 常用命令

| 目的 | 命令 | 证据/说明 |
|---|---|---|
| 自动测试 | `npm test` | `node --test test/*.test.js`（`package.json:20`） |
| 构建工作台资源 | `AIO_SOURCE=<AIO 仓库> npm run build:workbench` | `package.json:21`；`scripts/build-workbench.cjs:16` |
| 仅构建 UI | `npm run build:workbench -- --ui-only` | `scripts/build-workbench.cjs:830-840` |
| 校验同步上游特性 | `npm run build:workbench -- --verify-synced-upstream` | `scripts/build-workbench.cjs:832` |
| 打包前检查 | `node scripts/check-workbench.cjs`（`prepackage` 自动） | `package.json:22`；`scripts/check-workbench.cjs:1-18` |
| 打 VSIX | `npm run package` | `vsce package --no-dependencies --out dist/aio-ide.vsix`（`package.json:23`） |
| 安装 VSIX | `code --install-extension dist/aio-ide.vsix` | `README.md` |
| 开发调试 | `code --extensionDevelopmentPath=. .` | `README.md` |

### 6.2 本次实际验证

- 执行 `npm test`：
  - 结果：**tests 58 / pass 58 / fail 0 / skipped 0**（分析中与并发改动后复跑均通过）；
  - 用时约 **10.7–10.8 秒**；
  - 包含 Windows PTY 集成测试（`test/workbench-terminal.test.js:13-59`，三提供商创建、输入、resize、kill）。
- 测试覆盖（静态与单元）：
  - 工作台桥请求/事件/键盘/拖放（`test/bridge.test.js`）；
  - 启动器、Windows shim、多根工作区、信任限制（`test/launcher.test.js`）；
  - 项目登记、交接、历史懒加载、文件拖放、预览分组、侧栏自动隐藏；
  - Bot 捆绑物静态断言与 CLI 传输（`test/bot-runtime.test.js:15-71`）；
  - 上游同步证据（`test/upstream-sync.test.js:8-38`）；
  - 默认深色主题持久化（`test/default-theme.test.js`）；
  - 启动首屏早于项目同步（`test/startup-panel.test.js`）。

### 6.3 真实 VS Code / VSIX 验收（未在本次执行）

| 脚本 | 作用 | 前置条件 |
|---|---|---|
| `test-host/run-smoke.cjs` | 开发扩展宿主冒烟：命令、三 CLI 夹具、终端创建/关闭 | `VSCODE_EXECUTABLE_PATH`（`test-host/README.md`） |
| `test-host/run-smoke.cjs --installed` | 使用本机 `omp.exe/claude.exe/codex.exe` | PATH 中存在三 CLI |
| `test-host-ui/verify-workbench.cjs dist/aio-ide.vsix` | 安装 VSIX、验证真实 React 页面、桥、项目/会话/PTY | 桌面版 `Code.exe`；上游 checkout 的 Playwright（`test-host-ui/verify-workbench.cjs:60`） |
| `AIO_TEST_BOT_UI=1 node test-host-ui/verify-workbench.cjs …` | Bot 选择、跨标签路由、关闭 | 同上 |
| `AIO_TEST_CODEX_SUBMISSION_EXE=<codex>` | 真实 Codex 提交（本地模拟 Responses） | 本机 Codex |
| `test-host-ui/verify-autostart.cjs` | 首屏自动打开、单标签、耗时 | 桌面版 VS Code |
| `verify-bot-ui.cjs` / `verify-codex-submission.cjs` / `verify-workbench-clipboard.cjs` 等 | Bot、多行提交、剪贴板、拖放、键盘路由等 | 同上 |

> 说明：这些脚本不在 `npm test` 中，且依赖外部可执行文件/上游依赖；本次只读分析未运行，因此“真实界面验收”属于**文档已记录、当前未复验**的状态。

---

## 7. 风险、局限与待完善点（基于代码证据）

### 7.1 环境与平台门槛

1. **Node.js 运行时硬门槛（高）**
   - 工作台要求 Node ≥ 22.13 且支持 `node:sqlite`；VS Code 自带 Node 不满足时会去 PATH 找外部 Node，否则直接报错（`src/workbench.js:22,47-81`；`src/workbench.js:53` 探测 `require('node:sqlite')`）。
   - 影响：部分 VS Code 版本/精简安装的用户无法打开完整工作台，只能使用轻量终端入口。

2. **内嵌 PTY 仅 Windows x64（高）**
   - 非 Windows 直接抛错：“currently packaged for Windows only”（`workbench/service/workbench-service.cjs:30842`）。
   - 清单固定 `platform: win32`、`architecture: x64`（`workbench/manifest.json:6-7`）；`node-pty` 仅带 `win32-x64` 预编译（同文件依赖与 `check-workbench.cjs:11-14`）。
   - 影响：macOS/Linux/Windows ARM 无法使用工作台终端（轻量启动器理论上可跨平台，但未在本仓库验证）。

### 7.2 上游耦合与可维护性

3. **构建期字符串补丁非常脆弱（高）**
   - `build-workbench.cjs` 对上游 React `App.tsx`、生成后的 `main-*.js`、`terminal.ts`、`workbench-service.ts` 做多处精确字符串替换；锚点不匹配即抛错（例如 `scripts/build-workbench.cjs:99-140,350-370,398-450`）。
   - 服务固定到上游提交 `561bc25…`，并通过 `git archive` 取源码（`:372-384`）。
   - 影响：上游任何重命名/压缩变化都会导致构建失败；当前测试也多为字符串包含断言（`test/bot-runtime.test.js:15-35`，`test/upstream-sync.test.js:21-33`），无法证明行为正确。

4. **工作台 UI 通过 DOM 注入与按钮“代点”适配（中高）**
   - 历史区域直接查找 `.sidebar .project-group` 并插入 DOM（`src/history-view.js:61-80`）。
   - 侧栏自动隐藏通过点击上游工具栏按钮触发 React 状态（`src/panel-auto-hide.js:90-126,228-247`）。
   - 文件预览通过 `toggleMaximizeEditorGroup` 与布局快照实现（`src/preview-group.js:200-221`）。
   - 影响：上游类名、按钮顺序、DOM 结构一变化即失效；这类功能难以用单元测试稳定覆盖。

### 7.3 功能完整度

5. **上游能力只迁移了一部分（中）**
   - 服务明确返回占位值：更新器 `unsupported`、浏览器空标签、插件空列表、定时任务 `null`（`workbench/service/workbench-service.cjs:31306-31314`）。
   - 宿主主动短路 `sessions:list`、`terminal:list-restorable`、`coding:list`、`coding:list-summaries`、`app:list-coding-cli-history`（`src/workbench.js:611-614`），改由自定义 `aio-history:*` 与 `terminal:list-restorable` 特例提供。
   - 影响：上游 UI 的“会话/历史”页面可能为空或行为不同于桌面版；README 也承认浏览器、定时任务、技能执行、桌面更新器仍在迁移范围。

6. **Codex 多行后续任务限制较多（中）**
   - 仅 Codex、仅 Windows、且终端必须由 AIO 配置了外部编辑器 spool；否则报“不支持可靠多行后续任务”（`workbench/service/workbench-service.cjs:2150`）。
   - 提交总超时 8 秒（`:2126`）；终端已有草稿时拒绝（`:2185-2187`）；需要等待括号粘贴模式与输出代数变化（`:2192-2198`）。
   - OMP/Claude 的多行后续依赖括号粘贴模式，不满足则报错（`:2135-2137`）。
   - 影响：Bot 向已运行终端投递长任务时可能失败，需要重试/改用新终端 `create --stdin`。

7. **项目切换会触发 VS Code 重新打开文件夹（中）**
   - `performProjectSwitch` 写入 60 秒 handoff 后执行 `vscode.openFolder`（`src/workbench.js:389-397`；`src/project-handoff.js:5-6`）。
   - 仅单文件夹工作区且目标为已登记项目根时匹配（`src/project-handoff.js:35-42`）。
   - 影响：切换项目会造成窗口重载；多根工作区、未保存编辑、非根目录项目的行为受 VS Code 原生流程约束。

### 7.4 安全与信任边界

8. **Bot 令牌是环境变量中的 Bearer 凭据（中）**
   - Bot 终端持有会话令牌，可创建/控制/关闭其工作终端；Worker 令牌仅能上报（`workbench/service/workbench-service.cjs:30639-30642,30719-30731`）。
   - 控制服务只监听 `127.0.0.1`（`:30708`），但本机任意能读取该环境变量/进程环境的程序都可复用令牌；提示词要求 Worker 不泄露令牌（`:30858`），但这只是行为约束，不是强制隔离。
   - 影响：对本地多用户/恶意软件的防护有限；属于“本机可信”模型。

9. **执行外部 CLI 与 shell 的固有风险**
   - 扩展会启动用户配置或 PATH 中找到的可执行文件（`.cmd/.ps1/.exe`），并在用户项目目录中运行（`src/launcher.js:44-64,88-108`）。
   - 这是产品预期行为，但意味着工作区/项目内容对 CLI 完全可见；扩展本身未做内容沙箱。

10. **未跟踪的 `install.cmd` 会下载并执行远程脚本（需确认）**
    - 工作区存在未跟踪文件 `install.cmd`，内容从 `https://herdr.dev/install.ps1` 下载后交给 PowerShell 执行（`install.cmd:1-24`）。
    - 它与 AIO 扩展源码/文档无引用关系。当前 `.vscodeignore:18` 已将它（以及 `debug.log`、`**/.omc/**`）排除出 VSIX，因此默认不会被打包；但该文件仍在工作区中，误执行仍会拉取远程脚本。
    - 影响：属于供应链风险；建议确认来源后再决定是否保留/删除。

### 7.5 构建、测试与发布

11. **无可复现锁文件、无 CI 证据（中高）**
    - 根目录只有 `package.json`，没有 `package-lock.json`；工作台构建依赖外部 `AIO_SOURCE` 与其 `node_modules`，还需要 Rust/Cargo/MSVC（`scripts/build-workbench.cjs:16,372-410,691-697`）。
    - 仓库内未发现 CI 配置（未发现 `.github/workflows`）。
    - 影响：不同机器构建出的 VSIX 可能不一致；上游提交固定缓解了源码漂移，但工具链未锁定。

12. **真实 UI 验收不在默认测试内（中）**
    - `npm test` 的 58 项以单元/静态/PTY 为主；真实 Webview、Bot 选择器、Codex 多行提交依赖 `test-host-ui/*` 与外部 `Code.exe`/Playwright（`test-host-ui/verify-workbench.cjs:60`）。
    - 影响：默认 CI 无法捕获 React/DOM/布局回归。

13. **性能数据为一次性测量（低）**
    - 执行记录称首屏从 5.84s 降至 3.60s，但明确说明“每种场景的一次测量，用户日常配置下的耗时仍待实测”（`docs/execution/2026-11-27-async-runtime-probe.md`）。
    - 影响：不能据此承诺所有环境的启动性能。

14. **自动打开工作台可能打扰用户（低）**
    - 每次受信任窗口启动且无项目交接时都会自动打开工作台（`src/extension.js:31-35`）。
    - 影响：不希望使用完整工作台的用户需要额外关闭标签；设置中未见“禁用自动打开”的开关。

### 7.6 其他

15. **可执行文件发现依赖 VS Code 继承的 PATH（低）**
    - 文档建议在 PATH 未更新时手动配置 `aio.*Path`（`README.md`；`package.json:71-77`）。
    - Windows 上只搜索有限常见目录（`src/discovery.js:28-34`）。
16. **文档与实现均为中文/Windows 导向（低）**
    - 错误信息、配置说明、验收脚本大量中文；国际化仅工作台设置中有 `locale` 枚举（`workbench/service/workbench-service.cjs:31035-31043`）。
17. **仓库包含二进制产物（低）**
    - `dist/aio-ide.vsix` 被跟踪；`workbench/service/aio-terminal-host.exe`、`node-pty` 预编译也在仓库中。
    - 影响：仓库体积、二进制审查与 diff 噪声。

---

## 8. 可复核结论摘要（10 条以内）

1. **AIO 是“CLI 启动器 + 上游 AIO 工作台”的双层 VS Code 扩展**：轻量入口用 VS Code 集成终端启动 OMP/Claude/Codex（`src/launcher.js:88-117`），完整入口把 AIO 2.0.2 的 React UI 与 Node 服务嵌入 Webview（`src/workbench.js:444-513`；`workbench/manifest.json:2-5`）。
2. **工作台采用“子进程 + NDJSON RPC + 伪 Tauri 桥”架构**：扩展宿主 spawn 服务（`src/workbench.js:95-123`），Webview 注入 `window.__TAURI__`（`src/webview-bridge.js:249-259`），请求经 `desktop_request` 转发（`src/workbench.js:605-689`）。
3. **工作台的终端是真正的 PTY**：Windows x64 下用 `node-pty` + Rust `aio-terminal-host.exe`，支持输入、resize、退出事件和输出限流（`workbench/service/workbench-service.cjs:1993-2050,2297-2318`）。
4. **Bot 是本项目最有辨识度的能力**：选择器创建 `_Bot` 终端（`workbench/service/workbench-service.cjs:31261-31266`），Bot 通过本机 HTTP（随机端口 + Bearer 令牌）创建/发送/关闭工作终端（`:30578-30810`），Worker 令牌只能上报事件（`:30728-30731`）。
5. **Bot 的控制协议边界清晰**：`GET/POST /v1/terminals`、`POST /v1/terminals/:id/input`、`DELETE /v1/terminals/:id`、`GET/POST /v1/events`；事件含 `terminal_created`、`agent_event`、`terminal_exit`（`:30732-30798`）。
6. **上下文注入是“系统提示 + 文本引用”，不是自动读仓库**：Bot 用 CLI 原生 `--append-system-prompt` / `developer_instructions` 注入技能（`:30582-30586`）；文件引用只是插入 `@"路径"` 文本（`src/file-drop.js:139-166`），不读取正文、不自动发送。
7. **Codex 多行后续任务通过外部编辑器回填实现**：`aio-codex-editor.cjs` 用 nonce/字节数/SHA-256 校验请求，服务等待 ack 与终端就绪后发送一次 Enter（`workbench/service/workbench-service.cjs:2149-2213`；`workbench/service/aio-codex-editor.cjs:43-110`）。
8. **项目切换依赖 VS Code 原生“重新打开文件夹”与 60 秒 handoff**：`vscode.openFolder` 前写 globalState，目标窗口恢复（`src/workbench.js:389-397`；`src/project-handoff.js:57-83`）。
9. **当前测试基线为 58 项全通过**：本次运行 `npm test` 得到 58/58、约 10.7 秒；但真实 Webview/Bot/Codex 验收脚本未纳入默认测试，需要外部 VS Code 与上游 Playwright（`test-host-ui/verify-workbench.cjs:60`）。
10. **主要工程风险是上游耦合与平台门槛**：构建期对上游 React/服务做字符串补丁（`scripts/build-workbench.cjs:99-140,398-450`），且工作台要求 Node ≥ 22.13 与 Windows x64 PTY（`src/workbench.js:22,47-81`；`workbench/service/workbench-service.cjs:30842`）。

---

## 附录 A：本次未验证/待验证事项

- 未运行 `test-host/run-smoke.cjs` 与 `test-host-ui/*`（需要桌面版 VS Code、外部 CLI、上游 Playwright）。
- 未在 macOS/Linux/Windows ARM 上验证轻量启动器与工作台。
- 未对真实 OMP/Claude/Codex 账户发起模型请求；Bot 的模型选择、真实任务编排仅依据代码与既有执行记录。
- 未验证 VS Code 版本低于 1.97 或 Node 版本不足时的降级体验。
- 未审计上游 AIO 2.0.2 全部代码，仅审计本仓库携带的构建产物与集成层。

## 附录 B：关键证据索引

| 主题 | 位置 |
|---|---|
| 扩展清单/命令/设置 | `package.json:1-80` |
| 激活与自动打开 | `src/extension.js:11-37` |
| CLI 发现/启动 | `src/discovery.js:7-117`，`src/launcher.js:44-168` |
| 工作台宿主/RPC | `src/workbench.js:19-199,404-603,605-747` |
| Webview 桥 | `src/webview-bridge.js:1-261` |
| 服务分发 | `workbench/service/workbench-service.cjs:31071-31329` |
| PTY/多行提交 | `workbench/service/workbench-service.cjs:1993-2330` |
| Bot 控制 | `workbench/service/workbench-service.cjs:30578-30810,31565-31579` |
| Bot CLI | `workbench/service/aio-bot-cli.cjs:26-193` |
| Codex 编辑器助手 | `workbench/service/aio-codex-editor.cjs:1-118` |
| 项目登记/交接 | `src/project-registry.js:8-207`，`src/project-handoff.js:1-88` |
| 历史 | `src/lazy-history.js:1-170`，`src/history-view.js:1-82` |
| 文件引用/拖放 | `src/file-drop.js:1-324`，`src/file-reference-tree.js:1-121` |
| 预览/自动隐藏 | `src/preview-group.js:1-270`，`src/panel-auto-hide.js:1-384` |
| 构建 | `scripts/build-workbench.cjs:1-870`，`scripts/check-workbench.cjs:1-18` |
| 测试 | `test/*.test.js`，`test-host/README.md`，`test-host-ui/*.cjs` |
| 执行记录 | `docs/execution/2026-11-27-*.md` |