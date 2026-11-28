# AIO_IDE_Plugin 三方分析对比（OMP / Claude Code / Codex）

- 分析对象：`D:\Github\Ancoder\AIO_IDE_Plugin`（VS Code 扩展 `aio-ide`）
- 执行方式：AIO Bot 通过 `aio-bot-cli` 创建三个工作终端，投递同一份分析任务
- 报告：`omp.md`（42.5 KB）、`claude.md`（44.1 KB）、`codex.md`（18.4 KB）
- 对比者：AIO Bot（独立复核）

## 1. 分析过程

| 项 | OMP | Claude Code | Codex |
| --- | --- | --- | --- |
| 终端 | `028fc752…` | `1a65ca46…` | `3da61f90…` |
| 首任务投递 | `create` + `send` | `create` + `send` | `create --stdin`（原生首任务） |
| 耗时 | 约 4 分钟 | 约 8 分钟（中途随并发提交更新报告） | 约 9 分钟 |
| 结论基线 | 0.1.35 / HEAD `1cbe4de` | 0.1.36 / 识别到并发改动 | 自称 0.1.35 + HEAD `9be8065`（互相矛盾） |
| 实测命令 | `npm test` 58/58（11.7 s） | `npm test` 两次 58/58（10.7 s） | 仅 `node scripts/check-workbench.cjs`（exit 0），明确声明未跑测试 |

> 分析期间仓库被另一条 AIO 开发会话并发提交了 `d6c63e4`、`9be8065`（作者 `HeJoey2010`，09:16 / 09:20），其中 `9be8065` 把版本从 0.1.35 升到 0.1.36 并更新 `.vscodeignore`。三份报告的行号因此存在轻微漂移，Claude 的报告已同步到新基线。

## 2. 三方共识（均被独立复核为真）

1. **双层产品**：轻量 CLI 启动器（VS Code 集成终端）+ 完整 AIO 工作台（Webview）。
2. **工作台架构**：React UI → 伪 Tauri 桥（`window.__TAURI__`）→ 扩展宿主 → 子 Node 服务（NDJSON/stdin-stdout RPC）→ PTY/CLI。
3. **Bot 编排**：`127.0.0.1` 随机端口 HTTP + 按会话签发 Bearer token；worker token 只能上报事件，不能创建/控制终端。
4. **Codex 多行后续任务**：Windows 下用 `VISUAL/EDITOR` 外部编辑器回填草稿，nonce/字节数/SHA-256 校验，再单次 `Esc/Home/Enter` 提交。
5. **上下文注入边界**：不自动读取仓库或编辑器正文；只有系统提示（`--append-system-prompt` / `-c developer_instructions`）与显式路径引用。
6. **平台门槛**：内嵌 PTY 仅 Windows x64；工作台要求 Node ≥ 22.13（`node:sqlite`）。
7. **上游耦合**：固定上游 AIO 2.0.2 提交 `561bc25…`，构建期对上游源码做字符串锚点补丁。
8. **测试基线**：`npm test` 58 项；真实 VSIX/UI 验收在 `test-host/`、`test-host-ui/`，不在默认测试内。

## 3. 差异对比

| 维度 | OMP | Claude Code | Codex |
| --- | --- | --- | --- |
| 结构完整度 | 8 章 + 证据索引，表格密集 | 8 章 + 附录 A/B，最均衡 | 8 节，紧凑 |
| 行号证据密度 | 极高（几乎每句带 `file:line`） | 极高 | 中（多用文件+行区间） |
| 风险条目 | **18 项**，按影响排序 | **17 项**，按类别分组 | **6 项**，概括为主 |
| 独有发现 | 服务崩溃无自动重启；请求无背压；宿主短路 5 类通道；项目登记只取首个工作区根；60 s handoff 过期风险；Bot token 存在于进程环境；Webview CSP `unsafe-inline` | 无 `package-lock.json`/无 CI；二进制产物入库；测试多为字符串包含断言；自动打开工作台无开关；性能数据为一次性测量 | Claude 用 `stream-json`、Codex 用 `codex app-server` stdio、OMP 走 RPC；预览观察器用 Windows UIAutomation；`test-host-ui` 脚本分类；每条结论标注置信度 |
| 验证严谨度 | 高（跑全套测试） | 高（跑两次全套测试） | 中（只跑预检，诚实声明） |
| 时效准确性 | 与其阅读时刻一致（0.1.35 / `1cbe4de`） | 最准确（0.1.36，主动说明并发改动） | **有瑕疵**：同时声称 0.1.35 与 HEAD `9be8065`，而该提交已是 0.1.36 |
| 误报/过度推断 | 少 | 少；但“已将版本号与 `.vscodeignore` 更新到当前状态”易被误读为它改了文件（实际是用户并发提交） | 风险章节推断较多，个别结论未展开证据 |

## 4. 独立复核结果

| 结论 | 复核方式 | 结果 |
| --- | --- | --- |
| 58 项测试全通过 | 本机执行 `npm test` | ✅ 58/58，11.09 s |
| 当前版本 0.1.36 | `git show HEAD:package.json` | ✅ |
| 无 `package-lock.json`、无 `.github/workflows` | 文件检查 | ✅（仅 Claude 指出） |
| `install.cmd` 下载并执行 `herdr.dev/install.ps1` | 读取文件 | ✅（OMP、Claude 指出；Codex 未提） |
| `.vscodeignore` 已排除 `install.cmd`、`debug.log`、`**/.omc/**` | 读取文件 | ✅ |
| 宿主短路 `sessions:list` / `coding:list*` / `long-run:list-tasks` | `src/workbench.js:607-610,650` | ✅ |
| `codex app-server`、Claude `stream-json` | grep 服务源码 | ✅（仅 Codex 指出） |
| 预览悬停使用 UIAutomation | `src/preview-hover.ps1:8-54` | ✅（仅 Codex 指出） |
| 20 个 `test-host-ui` 脚本含 project-switch/reverse-sync/autostart | `ls` | ✅ |

## 5. 结论与选用建议

- 三份报告在核心事实（架构、Bot 协议、Codex 多行、平台门槛、上游耦合）上**高度一致**，可交叉验证，结论可信。
- **最全面**：OMP。风险登记表最细，适合直接作为整改清单。
- **最均衡/最贴近工程现实**：Claude Code。额外覆盖构建可复现性与测试有效性，适合交付评审。
- **最精炼/内部机制最细**：Codex。对三种 CLI 适配层与 UI 观察机制有独到细节，适合快速理解；但验证最少且有一处版本自相矛盾，引用前需校正。
- 组合使用建议：风险清单取 OMP，构建/测试与发布风险取 Claude，CLI 适配细节取 Codex；版本与行号以当前 HEAD `9be8065`（0.1.36）为准。

## 6. 过程备注

- 三个 worker 均为只读分析，未修改仓库跟踪文件；复核时 `git status` 仅剩未跟踪产物。
- 期间出现的 `d6c63e4`、`9be8065` 来自并发开发会话，不是本次 worker 的改动。
- worker 完成后已通过 `aio-bot close` 关闭。