# 📝 版本发布与路线图 (RELEASES)

> 本文档承载 Kapibala 的版本号规则、各版本既有能力增强明细与版本路线图；
> README 只保留入口链接。版本号规则：Kapibala 按十进制位进位，小版本补丁位只使用 `0–9`，
> `v0.0.9` 的下一版本是 `v0.1.0`，不使用 `v0.0.10`；后续同理，`v0.1.9` 之后进入 `v0.2.0`。

---

## ✅ v0.0.1 既有能力增强（已完成）

以下工作已作为 v0.0.1 既有能力增强完成，不占用后续版本的新增能力范围：

- **请求与会话指标**：统一请求结束底栏与 `/status` 的统计口径；默认按 Git 分支、总耗时、上下文占用、本轮 Token、工具次数/耗时排列，`--debug` 追加模型耗时与 TTFT。
- **上下文窗口配置**：`ModelProfile.contextWindow` 支持整数与 `K/M` 简写，缺省按 `1M` 估算展示；内置模型使用目录中配置的真实窗口。
- **工具调用展示**：内置工具映射为面向用户的 `Read` / `Search` / `Write` / `Edit` 动作名，执行状态原地更新、参数脱敏与稳定截断；非 TTY 输出单条无 ANSI 记录。
- **工程加固**：跨平台开发入口、PathSandbox 与扩展底座测试补齐、Headless Core 架构门禁、文档状态约束（“已实现 / 待增强 / 未来版本”严格区分）。

> 上下文压缩状态不在 v0.0.1 伪造占位数据；等 v0.0.3 的压缩机制落地后，再由真实的压缩次数、摘要覆盖范围和最近压缩时间驱动展示。

---

## 🗺️ 版本路线图

| 版本 | 阶段重点 | 核心能力与扩展点 | 交付形态 |
|:---:|---|---|---|
| **v0.0.1** | **核心骨架、交互 CLI 与既有能力收尾**（已完成） | OpenAI 兼容协议、Slash 命令、首次配置向导、PathSandbox、崩溃历史自愈、请求级指标与上下文占用、Headless Core 架构门禁、跨平台一键开发脚本 | CLI (`kpbl`) + Core SDK |
| **v0.0.2** | **可信执行与项目指令**（功能已实现；[发布说明](releases/v0.0.2.md)） | 默认结构化运行日志与逐工具审计、四态 `SessionMode`、执行前授权与人工审批、结构化工具错误、多层 `AGENTS.md`；`run_command` 默认注册，解释器发现只用 `PATH` 与运行时探针（native Bash → WSL → PowerShell 兜底），每条命令仍单独裁决；`FullAccess` 只能在本次会话显式选择 | Core + CLI 增量 |
| **v0.0.3** | **历史会话、消息生命周期与上下文管理**（已发布；[发布说明](releases/v0.0.3.md)，[验收记录](verification/v0.0.3.md)） | 以 Pi 会话投影与滚动摘要为主体：独立版本化 JSONL、稳定 ID、SessionManager、历史列表与分支提示，默认新建及显式恢复；规范完整工具事务；保守读取/搜索结果剪裁 → 增量摘要，借鉴 Codex 恢复一致性，各级先提交后激活；摘要首尾截断与总预算、真实文件操作详情、可恢复失败熔断、稳定序列化与效果实测；完整保护当前任务和最近成功交互，超限停止，任务内部压缩后续再做；Core 六大领域重构及命令统一 | Core + CLI 增量 |
| **v0.0.4** | **多协议与场景模型路由**（已发布；[发布说明](releases/v0.0.4.md)，[验收记录](verification/v0.0.4.md)） | Anthropic 原生 Messages、OpenAI 原生 Responses、现有 Chat Completions 兼容层加固；共享合法历史与完整工具事务，扩展 `default` / `summary` 路由并落地 `fast` / `planning` / `execution` 显式场景选择，提供结构化思考事件基础；小模型意图分类留待后续 | Core + CLI 增量 |
| **v0.0.5** | **技能体系与过程输出折叠**（已发布；[发布说明](releases/v0.0.5.md)，[验收记录](verification/v0.0.5.md)） | 有界 SkillRegistry、按需加载、受控资源、来源落盘与只收紧权限；`/skills` / `/skill`、技能名 Tab、Ctrl+O、完整详情重定向；[迁移说明](migration/v0.0.5.md) | Core + CLI 增量 |
| **v0.0.6** | **MCP 生态扩展**（已发布；[发布说明](releases/v0.0.6.md)，[验收记录](verification/v0.0.6.md)，[迁移说明](migration/v0.0.6.md)） | 独立包接入 Stdio 与 Streamable HTTP；工具按 source 原子上下线、run 稳定声明与即时撤销，启动和调用分别授权；Prompt 可搜索并由固定 `/prompt` 入口调用；缓存压缩专项另行排期 | `@kiturone/kapibala-mcp` |
| **v0.0.7** | **会话增强与多智能体**（已发布；[发布说明](releases/v0.0.7.md)，[验收记录](verification/v0.0.7.md)，[迁移说明](migration/v0.0.7.md)） | 基于 v0.0.3 的独立会话、Envelope 因果 `parentId` 与基本 SessionManager，增强跨项目全文检索、历史分叉（DAG 树）、归档与子代理任务树观测；清理 Core 对全局 `process.cwd()` 的隐式依赖，强制显式 `workspaceRoot`；再接入 `spawn_agent`、父子追踪和角色模型绑定，子代理权限只继承或收紧。Worktree 物理隔离、审批冒泡与任务树 Token 分层账本明确未交付 | Core + 宿主增量 |
| **v0.0.8** | **产品化终端体验**（已发布；[发布说明](releases/v0.0.8.md)，[验收记录](verification/v0.0.8.md)，[迁移说明](migration/v0.0.8.md)） | 现代终端守护（ConPTY/CSI-u 拼包、Bracketed Paste 隔离、异常自愈恢复）、共享前端纯展示模型（`@kiturone/kapibala-cli/view-model` 导出，0 Node 依赖，WeakMap 缓存）、宿主桥接中枢与防抖分发、全量 Slash 命令结构化解耦（CommandOutput 统一输出，check-cli-boundary 门禁）、多任务状态观察（subscribeTaskChanges） | CLI 内部模块增量，不新增包 |
| **v0.0.9** | **本地客户端契约与发布前加固**（实现与本地验收完成，发布流程进行中；[发布说明](releases/v0.0.9.md)，[验收记录](verification/v0.0.9.md)，[迁移说明](migration/v0.0.9.md)） | 版本化 wire DTO、双向审批与控制信令、本地守护进程和受控本地传输（面向 CLI / Daemon / 桌面 IPC 通用通信契约）；已实现有界快照、审批与宿主隔离，Linux、Windows named pipe/ACL 与 Node 20 等平台验收仍待补齐。桌面/Web/移动多端及远程传输待契约稳定后逐步交付 | Core + 本地宿主适配 |
| **v0.1.0** | **阶段性整合版本** | 稳定已交付的 Core 公共 API、事件协议和本地客户端契约，完成迁移验证与发布流程；不新增客户端类型或运行时子系统 | CLI + Core SDK + 扩展包 |
| **v0.1.1** | **跨平台桌面客户端 (Electron)** | 基于 Electron 的现代化跨平台桌面客户端（Windows / macOS / Linux）；前端采用现代 Web 技术栈复用流式渲染与 ViewModel，主进程直连复用 Headless Core 与 MCP 模块；支持系统托盘、全局呼出快捷键、富文本思考过程与工具调用交互 | 独立桌面包 (`packages/desktop`) |


### v0.0.9 本地实现与发布边界（2026-10-21）

- CLI 内新增 protocol/client 子路径、本地 stdio/socket/pipe 宿主与 daemon/connect 入口，仍保持三个发布包；直接 CLI 兼容，协议版本独立为 1.0。
- 会话单控制者、操作 ID 去重、审批取消和有界一致快照已实现；重连不重发写操作，不提供跨连接事件重放。工作区写租约只覆盖同一宿主。
- 最终本地 `pnpm verify` 为 145 个测试文件、1252 项测试通过，`pnpm build`、macOS 真实 daemon/stdio 平台检查与三包 tarball 隔离安装通过；Linux/Windows/Node 20 与公共 registry smoke 见 [待补齐门禁](verification/v0.0.9.md)。版本号由发布脚本统一推进；本地通过不视为远端发布完成，公共 registry 与 GitHub Release 以标签工作流结果为准。

### v0.0.8 已确认交付边界（2026-10-17）

- 终端底层基础设施与输入守护：`TerminalModeGuard` 接管未捕获异常与进程退出，保障光标（`\x1b[?25h`）、备用屏（`\x1b[?1049l`）与 rawMode 可靠恢复；`TerminalInputFramer` 引入 40ms 拼包缓冲解决 ConPTY 分片，Bracketed Paste 隔离换行与快捷键并设 1MiB 上限防 DoS；`TerminalInputStream` 保证 stdin 单读者互斥；`TerminalEditor` 基于 `Intl.Segmenter` 支持 Unicode 宽字符、组合字符与历史回滚；
- 跨端纯展示模型（`@kiturone/kapibala-cli/view-model`）：导出无副作用的展示状态与纯函数 Reducer，提供独立构建产物（`tsconfig.view-model.json` / `tsup.view-model.config.ts`），`check-view-model.ts` 门禁保证 0 Node 内置依赖，供终端与未来桌面端共享；`selectMessages` 引入 WeakMap 快照缓存；
- 宿主桥接中枢与命令输出解耦：`SessionPresentationHost` 与 `PresentationStore` 统一订阅分发与 16ms 防抖；全量迁移 `packages/cli/src/commands/*` 20+ 内置命令至结构化 `CommandOutput`，消除运行期隐式 `console.log`，`check-cli-boundary.ts` 架构门禁强制约束；
- 多任务状态观察：Core `AgentRuntime` 提供 `subscribeTaskChanges` 只读通知订阅，CLI 宿主 `TaskObservationHost` 实时聚合子任务并在状态模型反映进度；
- 本版明确未交付：全屏 Ink TUI 主视图切换（阶段 D 平滑过渡至下一版）、Electron 桌面客户端包（按路线图排入 v0.1.1）、Git Worktree 物理隔离与审批冒泡队列。

### v0.0.7 已确认交付边界（2026-10-16）

- 彻底移除 Core 内部对隐式 `process.cwd()` 的依赖，`AgentSession` 构造要求显式 `workspaceRoot` 绝对路径（缺少抛出 `WORKSPACE_ROOT_REQUIRED`），Windows 路径规范化统一走 `fs.realpathSync.native`；
- `PathSandbox` 重构为会话持有实例，引入 `WorkspaceLeaseCoordinator`（单例 `sharedWorkspaceLeaseCoordinator`）互斥写租约；架构门禁与单测阻止隐式目录操作；
- 会话升级为 Schema v2 Envelope，分离物理时序与因果链（`parentId`/`branchId`），解耦三大版本号；存量 v1 日志只读保护，`open` 与 `continueRecent` 默认自动创建 `_v2` 升级副本；
- 持久分支支持 `selectBranch`、`createBranch` 与 `forkSession` 导出独立会话（剥离来源 `upgradeIdentity`、导入历史不计费）；因果回溯校验工具闭合，严禁未闭合工具事务分叉，识别 `history_repair` 叠加记录并拒绝以全局控制记录作为切点；
- 引入 `AgentRuntime` 后台任务调度器，管理子代理状态机，`spawn_agent` 受理即刻闭合父工具事务；`SubagentOutbox` 以追加日志耐久保存终态与 ACK 并可读回，`SessionInbox` 按 `eventId` 幂等写入父历史；
- 通知投递为显式拉取：`/agents collect <id>` 注入来源分支，异分支拒绝并提示切换；空闲自动唤醒投递本版未接入；
- 层级安全限额与权限求交：`deriveChildPolicy` 以父会话真实模式、规则与工具表逐轴收紧求交，内置 5 类角色预设与场景模型路由，`modelOverride` 受理前校验；Plan 模式硬拦截 `agent:spawn`；最大深度熔断与树级槽位/累计额度生效；
- `CrossProjectSessionCatalog` 支持跨项目全局会话扫描、有界正则 worker（复用单 worker + 随剩余 deadline 收缩超时）熔断检索；支持 `archive_state` 逻辑归档与恢复，运行中会话硬拦截归档；
- 扩展 CLI 命令：`/history`（--tree/--search/--all/--agents）、`/branch`、`/fork`、`/archive`、`/agents`；终端底栏子代理紧凑状态行与 Ctrl+O 展开详情，秘密输入期间自动缓冲后台异步输出；
- 本版明确未交付（相关未接线组件已删除）：Git Worktree 物理隔离（`isolation:'worktree'` 受理前显式拒绝）、父终端审批冒泡队列、跨任务树 Token 分层账本、空闲自动投递、`branchWithSummary` 跨分支摘要注入；
- 全量门禁（112 个测试文件 / 1033 项通过、3 项因 Windows 符号链接权限跳过）通过；进程回收用例按平台分支，本机 Windows `taskkill /T /F` 分支实测通过。

### v0.0.6 已确认交付边界（2026-10-15）

- MCP 生态以独立公共包 `@kiturone/kapibala-mcp` 交付，保持 Core 纯粹 Headless 且零外部运行时依赖。三包依赖拓扑由架构门禁与自愈脚本全量约束。
- 支持 Stdio 与 Streamable HTTP（SSE）双传输。内置跨平台进程树强制回收与 RFC 1918 私网拦截；启动授权与工具调用授权分离，非 TTY 环境拒绝未经审批的 Stdio 服务启动。
- 工具统一映射为 `mcp__<server>__<tool>` 命名空间并在终端格式化展示；敏感参数自动脱敏为 `[REDACTED]`。
- 历史会话记录可选 `mcpSource` v1 元数据，发送外部模型 wire 时剥离，严格保持历史闭合不变量。
- 新增 `/mcp`、`/mcp tools`、`/mcp reconnect`、`/mcp enable/disable` 管理命令，新增 `/prompts` 与 `/prompt` 受控模板调用；提供 `--no-mcp` 宿主禁用开关。
- 本地全量门禁（100 个测试文件 / 943 项通过、3 项因 Windows 符号链接权限跳过）、独立 tarball 安装冒烟（`scripts/v0.0.6-pack-smoke.ts`）及真实 CLI 平台回归（`scripts/v0.0.6-platform-check.mjs`）全部通过。外部 npm Trusted Publisher 配置属远端发布前置。规划阶段不修改版本号。

### v0.0.4 已确认规划范围（2026-10-05）

- 原生 Anthropic Messages 与 OpenAI Responses 分别接入同一个 Agent 工具循环；保留第三方 Chat Completions 兼容网关，并加固工具参数、停止原因与断流校验。内置 Claude/OpenAI Profile 显式选择对应原生协议，自建 Profile 不自动改协议。
- `planning`、`execution`、`fast` 由用户或 SDK 显式选择，一次 `run` 内角色不随工具调用自动变化；`summary` 独立。提供可见思考块事件和按模型计算的输出预算，不推断隐藏思考。
- 版本开发范围、实施顺序、迁移与验收门槛见 [v0.0.4 完整开发方案](superpowers/specs/2026-10-05-v0-0-4-development-plan.md)，协议细节见 [技术设计](superpowers/specs/2026-10-05-v0-0-4-multi-protocol-routing-design.md)。技术方案于 2026-10-06 确认，工作区实现及本地验收于 2026-10-07 完成；41 项进度见 [OpenSpec tasks](../openspec/changes/v0-0-4-multi-protocol-routing/tasks.md)，证据见 [验收记录](verification/v0.0.4.md)，接入见 [迁移说明](migration/v0.0.4.md)。真实付费 API 未验收；npm 与 GitHub Release 已于 2026-10-07 发布并完成远端安装验收。自动意图分类、托管工具、多模态和界面折叠不进入本版。

### v0.0.3 已确认交付边界（2026-09-27）

- 历史会话能力从 v0.0.7 提前到 v0.0.3，与消息生命周期、上下文预算和滚动摘要共同交付；工作区版本已更新为 v0.0.3。自动与 Windows/POSIX 恢复门禁通过，三组真实工具任务小规模质量验收已完成，费用、缓存与模型限制见验收记录；npm 与 GitHub Release 已于 2026-09-27 发布并完成远端安装验收。
- 用户级 `~/.kapibala/sessions/<project-key>/` 按工作树分组，每会话独立文件；列表使用可重建元数据，记录 `gitBranch` 并提供环境分支漂移感知，选中后才加载对应正文。分文件解决不同任务混存，检查点解决模型上下文膨胀，原始历史仍会随单会话增长。
- 消息身份推荐使用时间单调递增的 UUIDv7；底层持久化 Envelope 显式保留可选的 `parentId: string | null` 字段以支持未来因果历史 DAG 与分叉，避免后续二次破坏性数据迁移。
- 普通 `kpbl` 与无恢复参数的单次问答默认新建；`/history` 查看列表，`/resume [id]` 切换续答，`--continue`/`--resume <id>` 启动恢复；`/new` 和受管 CLI `/clear` 保留旧历史，SDK reset 保持清空语义。
- 旧工作区 `.kapibala/history.jsonl` 整体导入为可选择的独立会话，保留原文件；恢复不重放工具、不继承审批缓存、不隐式改变执行 cwd。
- 压缩以 Pi 为主体，保留保守两级处理：保护范围外成功 read_file/glob/grep 结果先剪裁，仍达到阈值再滚动摘要；剪裁不改原文，后续摘要取原始结果。借鉴 Codex 恢复一致性，剪裁与摘要各自校验、持久提交后激活，重启重建适用状态。
- 摘要工具输入保留默认 2000 Unicode code point 首尾片段并检查整个请求预算；文件详情区分成功/失败/未知。三次自动摘要操作失败仅暂停自动摘要，最终硬预算决定任务是否停止；失败状态恢复、手动重试和配置周期有明确规则。稳定锚点只保证未变前缀一致，剪裁无额外模型调用但不承诺零延迟或缓存命中；真实质量、费用和缓存 usage 独立验收。
- 首版不做任务内部压缩或切分：完整保留当前交互、最近成功交互及其后的失败/中断交互，保护范围超限明确停止；该能力留待后续单独设计，不承诺超长单任务可无限续跑。跨项目检索、分叉、归档及多智能体仍在 v0.0.7。
- Core 内部组织结构已完成“六大领域分层”重构（types/、runtime/、context/、capabilities/、models/、extensibility/），执行引擎通过共享契约接入上下文准备；保留既有公开符号与基础 SDK 用法，新增能力和内部深路径迁移边界见迁移说明。
- 常用 Slash 命令整理纳入本版：新增 `/context` 预算明细（支持字符比例条 Visualized Gauge）与 `/compact` 手动压缩；采用 `/permissions`（兼容 `/mode`）、`/settings`（别名 `/config`），统一模型/配置重复子命令。`/clear` 保留为 `/new` 别名，`/quit` 保留为 `/exit` 别名。完整命令表见 [技术方案的 CLI 命令部分](../openspec/changes/v0-0-3-session-context/design.md#4-cli-命令和输入协调)，行为验收见 [CLI 命令契约](../openspec/changes/v0-0-3-session-context/specs/cli-command-contract/spec.md)。
- 命令注册、别名、参数、分组帮助与执行状态约束共用目录；菜单和秘密输入复用 REPL 输入协调器，非 TTY 不挂起。默认模型写入使用原始全局配置且保存成功后才更新内存；手动压缩不绕过完整轮次保护规则。命令面板模糊匹配、Tab 补全仍在 v0.0.8。
- 提案、验收规范与实施进度见 [v0.0.3 OpenSpec change](../openspec/changes/v0-0-3-session-context/proposal.md)。

## CLI 过程输出折叠与展开（规划补充，2026-09-28）

该能力分阶段交付，折叠只影响 CLI 展示，不改变 Core 的消息历史、工具事务闭合或落盘规则。

- **v0.0.4 — 事件基础**：Anthropic 原生 Provider 将模型实际提供、允许展示的思考内容以结构化事件传给 CLI；OpenAI Responses 只在 API 明确返回可见推理摘要时提供相应展示事件，加密推理 Item 不展示。工具调用及结果继续保留完整事件；Provider 未提供或已隐藏的思考内容不由 CLI 推测生成。
- **v0.0.5 — 默认折叠（已发布）**：CLI 默认将思考、工具调用和工具结果显示为简短摘要；TTY Ctrl+O 切换本轮详情，菜单/密钥/审批期间禁用。所有回答文本、错误、取消和权限请求完整可见；`--output-detail detailed` 提供非交互完整公开过程。当前轮次缓存最多 1 MiB，不能回收任意终端 scrollback；非 TTY detailed 流不受缓存截断。
- **v0.1.0 — 点击展开**：在可重绘、可滚动的终端会话视图中，支持点击过程块展开或收起；同时处理鼠标事件、窗口尺寸变化、终端兼容及复制文本体验，并为不支持鼠标的环境保留键盘操作。

验收时应确认折叠/展开不会遗漏流式输出，不会影响 SessionEvent 消费、消息落盘、工具结果闭合与会话恢复。

## 缓存友好的上下文压缩（专项增强与实测待排期）

> 原为 2026-09-28 的 v0.0.6 补充规划；2026-10-13 方案优化后，专项增强与实测移出 v0.0.6 MCP 交付，目标版本待定。以下目标保留，不标记完成；既有上下文压缩和完整事务规则不撤销，具体已交付边界仍以 v0.0.3/v0.0.4 记录为准。MCP 目录稳定不等于缓存专项验收通过。

- **目标**：在现有上下文压缩基础上，提高压缩后续轮次对 DeepSeek 等服务端前缀缓存的复用机会；优先保证上下文质量与长度约束，不以缓存命中率替代压缩目标。
- **投影规则**：原始消息历史和落盘记录保持不变；压缩只改变发送给模型的投影。每次压缩形成一个固定的摘要检查点，后续轮次在其后追加最近的完整消息；仅在下一次确需压缩时更新检查点。保持固定指令及可复用内容的顺序和序列化稳定，避免无关动态字段插入请求前缀。
- **工具事务**：压缩边界不得拆开 `tool_use` 与对应 `tool_result`；恢复、取消和失败轮次继续遵守既有 canonical 历史规则。
- **缓存预期**：摘要替换旧历史后，首次请求不保证命中被替换部分的旧缓存；新前缀建立后，后续请求才有机会复用。缓存由服务端管理，Kapibala 不实现本地模型 KV 缓存，也不承诺命中率。
- **验证与观测**：在 Provider 返回相关用量时记录缓存命中和未命中 token 数，比较压缩前、压缩后首轮及后续轮次的输入量、缓存命中、费用和响应质量；对不提供缓存用量的 Provider 保持兼容。

---

## 🖥️ 跨平台桌面客户端规划（Electron，v0.1.1）

> 选型确立于 2026-10-15：基于工程务实性、全栈 TypeScript 一致性与 AI 编程生态（Monaco Editor、node-pty 原生终端、Shiki 高亮、IME 输入法成熟度），选用 **Electron** 作为 Kapibala 跨平台桌面客户端（Windows / macOS / Linux）核心底座。主进程直接复用已有 TypeScript Headless Core 与 MCP 模块，以极高研发效率交付高品质桌面体验。

### 1. 架构定位与设计模式

- **严格遵守 Headless Core 原则**：桌面客户端作为独立包 `packages/desktop`（`@kiturone/kapibala-desktop`）交付，Core 保持 0 外部运行时依赖与纯粹 Headless。
- **主进程（Main Process，Node.js 环境）直连引擎**：
  - 主进程作为宿主直接 `import { AgentSession } from '@kiturone/kapibala'` 与 `@kiturone/kapibala-mcp`；
  - 零 Rust 胶水代码，零 Sidecar 进程管理、端口分配与鉴权握手成本；
  - 负责原生窗口生命周期、系统托盘（System Tray）、全局快捷键唤醒、原生菜单与系统通知；
  - 调度文件 IO 与子进程，天然支持集成 `node-pty` 提供工业级交互式终端能力。
- **安全隔离桥接（Preload & ContextBridge）**：
  - 严格开启 `contextIsolation: true` 与 `sandbox: true`；
  - 主进程与渲染进程之间通过强类型 IPC（Typed IPC / TRPC）通道传输规范的 `SessionEvent` 与控制信令，渲染进程无 Node 原生特权。
- **渲染进程（Renderer Process，Web 前端）**：
  - 采用 React / Vite / Tailwind CSS，复用 v0.0.8 沉淀的前端 ViewModel；
  - 实现流畅的流式 Markdown 打字机、Thinking 推理块折叠/展开、代码语法高亮与工具调用审批卡片。

### 2. 面向桌面客户端的关键技术调整（顺应路线图演进）

1. **工作区上下文彻底参数化（消除 `process.cwd()` 隐式依赖，v0.0.7~v0.0.8 落实）**：
   - `AgentSession`、`PathSandbox` 以及内置文件与命令工具一律由显式注入的 `workspaceRoot` 与 `executionCwd` 驱动；
   - 彻底解除全局进程环境依赖，支持桌面端在单进程内同时托管多个独立项目的工作区会话，互不串扰。
2. **事件 DTO 版本化与双向 RPC 控制信令（v0.0.9 落实）**：
   - 将 `SessionEvent` 规范化为结构稳定的数据传输对象（`WireSessionEvent`，版本号显式声明）；
   - 扩展双向控制流：工具执行前审批通过带唯一 `requestId` 和超时控制的 `approval_requested` 信令发起，渲染层弹窗确认后回发 `approval_response` 闭环；窗口异常或超时自动安全熔断。
3. **跨平台进程树强制回收与生命周期守卫（v0.0.9 ~ v0.1.1 落实）**：
   - 主进程统一管理工具命令子进程生命周期；
   - 任务中断或客户端退出时，统一通过 Windows Job Object / `taskkill /T /F` 与 macOS/POSIX 进程组 `kill(-pid, SIGKILL)` 深度回收所有子命令进程树，杜绝孤儿进程后台残留。

### 3. 分阶段实施路径

| 阶段 | 关联版本 | 交付重点 |
|---|---|---|
| **准备阶段：路径解耦与前端抽象** | **v0.0.7 ~ v0.0.8** | 消除 Core 内对 `process.cwd()` 的隐式依赖；在终端产品化演进中抽象出共享前端 `ViewModel`（流式 Markdown、Thinking 块折叠、工具参数脱敏展示），供 TUI 与桌面端双向复用。 |
| **第一阶段：通信契约与双向信令** | **v0.0.9** | 规范化版本化事件 DTO；实现本地守护进程与双向审批 RPC 信令通道，为主进程与多宿主提供统一的通信契约。 |
| **第二阶段：稳定整合与全量门禁** | **v0.1.0** | 冻结 Core 公共 API 与本地客户端通信协议，完成多平台宿主隔离与回归测试，不引入新客户端业务。 |
| **第三阶段：桌面客户端核心交付** | **v0.1.1** | 初始化 `packages/desktop`（`@kiturone/kapibala-desktop`）；构建 Electron 主进程与 Typed IPC 桥接；接入 Web 前端流式对话、历史抽屉与弹窗审批；交付 Win（NSIS / 免安装压缩包）与 Mac（DMG）安装包。 |
| **第四阶段：体验增强与自动更新** | **v0.1.x+** | 接入 `electron-updater` 增量自动更新；配置 macOS Apple Notarization 公证与 Windows 代码签名流水线；支持全局快捷键呼出小窗与拖拽文件输入。 |

### 4. Windows 与 macOS 平台差异适配基线

- **路径一致性**：文件与工作区交互严格采用 `fs.realpathSync.native` 规范化绝对路径，杜绝 Windows 8.3 短路径别名与 macOS 路径失配。
- **窗口与生命周期体验**：
  - **macOS**：隐藏默认标题栏并保留原生交通灯控制区（`hiddenInset`），支持毛玻璃背景质感（Vibrancy）；关闭主窗口保持 Dock 常驻，按 `Cmd+Q` 彻底退出并安全回收所有进程树。
  - **Windows**：原生支持 Snap Layout 窗口吸附布局与深色/浅色模式自适应；支持最小化到系统托盘（System Tray）并在后台保持状态。
- **安全与权限边界**：工具调用执行前授权与沙箱拦截逻辑统一由 Core 侧裁决，桌面端仅作为用户审批与交互展示通道，不私设越权通道。



