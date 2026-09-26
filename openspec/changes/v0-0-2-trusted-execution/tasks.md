# Tasks

## 1. 结构化日志基础

- [x] 1.1 在 Core 新建 `logging/` 的事件类型、上下文 ID、级别过滤与安全字段投影；为命令审计实现保守脱敏预览、SHA-256 命令摘要与执行指纹，用 `packages/core/tests/logging.test.ts` 验证普通/debug 级别、密钥/正文脱敏和不安全预览退化为占位符。
- [x] 1.2 实现用户级 JSONL 运行日志与审计日志 Sink、串行追加、按日/10 MiB 轮转、运行日志 30 天清理、审计同步写入与目录用量诊断；用临时目录测试轮转、保留、空间不足和写入失败，不把用户级目录当成同用户隔离边界。
- [x] 1.3 在 `AgentSession`、Loop 和 `ToolExecutor` 接入会话、模型、工具、错误关键事件及关联 ID；审计形成 `requested/decided/started/finished` 状态链，用假 Provider 的集成测试验证普通模式无需 `--debug` 即能回溯一次运行。
- [x] 1.4 将 CLI 的 `--debug` 改为结构化诊断级别并向 stderr 展示，加入 `/logs [count]` 只读查看与 `/status` 日志路径；用 CLI 测试验证普通输出简洁、debug 增量、非 TTY stdout 不被日志污染。
- [x] 1.5 启动时扫描审计未闭合操作并追加 `audit.outcome_unknown`，将操作 ID 与历史中的 `toolUseId` 关联；进程启动后 `started` 写入失败时请求中止并报告结果未知。用在决定后、spawn 后、结果写入前模拟崩溃与写入失败的测试验证不会误判为未执行或自动重试。

## 2. 错误契约与历史保障

- [x] 2.1 为 `KapibalaError`/工具结果补稳定 `code`、`retryPolicy` 与安全回填字段，并保持旧 JSONL 可读；用错误契约和旧历史样本测试验证。
- [x] 2.2 将工具解析、前置 Hook、审批、超时与中止异常统一转为安全 `tool_result`，不向模型回填原始内部异常；进程退出无法确认时使用 `OUTCOME_UNKNOWN`/`after_user_action`，用 Executor 测试覆盖失败路径和等待子进程回收的时序。
- [x] 2.3 在工具结果落盘后处理 `after_user_action` 与 `never`，保留连续错误熔断并禁止副作用工具自动重试；用多工具会话测试验证 `tool_use`/`tool_result` 全部闭合。

## 3. Core 权限与审计门

- [x] 3.1 在 `security/` 实现四态 `SessionMode` 与纯 `PermissionPolicy`，固定硬限制 → `deny`/会话拒绝 → 显式 `ask` → 会话允许 → 可信 `allow` → 模式默认值的顺序；Shell 只接受绑定解释器及工作目录的完整命令规则和整项 `deny/ask`，拒绝前缀/通配符及泛化 `allow` 的越权，用权限矩阵和组合命令配置测试验证。
- [x] 3.2 定义宿主注入的 `ApprovalChannel` 与精确范围会话缓存，处理仅本次允许、本会话允许/拒绝、取消和非交互拒绝；Shell 审批展示最终命令、真实工作目录、解释器与范围，执行指纹包含受限环境、超时/输出策略，可绑定脚本变化则复核、不能绑定则仅本次允许；用可控审批通道测试目标变化与缓存失效。
- [x] 3.3 调整 `ToolExecutor`：先记录请求、运行可改写 Hook，再对最终工具与参数裁决；审批后启动前复核目标，不稳定时有界重新裁决；决定审计成功后才执行，结果审计失败时报告状态不确定；用模拟文件 Sink 测试改写后授权、目标变化和执行前失败不产生副作用。
- [x] 3.4 将全部内置文件工具及 SDK 注册工具纳入统一门，并继续在内置文件工具内执行 `PathSandbox`；用端到端测试覆盖越界、未声明能力、`FullAccess` 显式 `deny/ask` 与每次操作的人工/自动来源日志。
- [x] 3.5 每次模型请求按固定模式快照、显式关闭与整项 `deny` 生成可见工具清单；用假 Provider 测试 `Plan` 不展示执行/写入/网络工具、模式切换刷新清单，以及直接 SDK 调用仍受最终授权门约束。

## 4. CLI 模式、配置与审批交互

- [x] 4.1 扩展设置读取与来源验证，支持用户级默认 `Approval/Plan/Auto`、可信权限规则、`--permission` 覆盖和 `/mode` 空闲切换；`FullAccess` 只接受本次会话显式选择，用户级或项目级默认值触发诊断并退回 `Approval`；用配置测试验证旧设置、规则错误拒绝、全局写入不物化内置模型。
- [x] 4.2 用同一个输入协调器实现 REPL 与单次模式的人工审批，支持 Abort、TTY 和非 TTY；用 CLI 测试验证审批响应不被当作普通聊天输入且拒绝/取消有合法结果。
- [x] 4.3 更新 `/help`、`/status` 与模式/审批提示，`/mode full-access` 需明确确认且 CLI 持续显示当前模式；用命令测试验证用户能区分 `FullAccess` 默认批准与人工批准，非交互仅显式命令行参数可选该模式。

## 5. 多层项目指令

- [x] 5.1 新建 `instructions/` 加载器，发现用户级及项目根到 cwd 的 `AGENTS.md`，限制 32 KiB/文件、128 KiB 总量和 16 层；用临时目录测试顺序、符号链接、缺失、超限和首次失败。
- [x] 5.2 在每次 `AgentSession.run()` 的轮次边界原子刷新指令快照，`PromptAssembler` 注入 L4 来源标记；用假 Provider 测试运行中修改只在下一轮生效、刷新失败保留旧快照。
- [x] 5.3 加入 `/instructions` 来源诊断并确认指令文本不能改变模式、注册工具或授权；用 CLI 与权限集成测试验证。

## 6. 默认可用的跨平台命令工具

- [x] 6.1 新增默认注册的 `run_command`、显式关闭入口 `--disable-shell`/用户级 `shell.enabled=false`、SDK 宿主开关及 `--shell auto|bash|wsl|pwsh|powershell`（或解释器全路径）；解释器发现只依赖 `PATH` 与用户显式路径，不写死安装目录，bash 家族以运行时 `uname` 探针分类（native Bash / WSL），并验证可执行文件身份与工作目录可用。用注册测试验证默认工具可见、显式关闭后 `FullAccess` 不重新启用、项目配置不能更改注册状态、仅有 WSL launcher 时 `auto` 兜底到 `wsl` 或 PowerShell、强制选择缺失或类型不符环境时报错、`auto` 无可用环境时仅禁用 `run_command` 并诊断。
- [x] 6.2 实现 Bash 与 PowerShell 执行适配器、受限环境继承及 PowerShell 5.1/7 UTF-8 输出归一；命令工具使用可等待资源回收的独立超时契约，默认 120 秒、最大 10 分钟，POSIX/Windows 均先请求终止再确认进程树退出。用真实进程测试验证正常退出、超时、中止、孙进程回收和回收失败的结果未知状态，不以 `Promise.race` 返回作为退出证明。
- [x] 6.3 让 `run_command` 走统一权限和审计门，审批与进程启动记录同一执行指纹；明确提示宿主用户权限与 PathSandbox 边界。用端到端测试验证四模式、完整命令 `ask/deny/allow`、工作目录与解释器变化不复用旧批准、审计失败前不启动进程。
- [x] 6.4 实现节流进度事件、64 KiB 模型内联输出、工作区专用目录最多 16 MiB 的受管结果文件、继续排空超限输出及 7 天清理；用大输出和长时间命令测试验证可中止、可按行读取文件、截断标志准确、不会删除非受管文件。

## 7. 文档与发布门禁

- [x] 7.1 更新设计基线、路线图、README 与 SDK 迁移说明：将默认结构化日志和逐工具审计移入 v0.0.2，澄清 `FullAccess` 本次选择、命令工具默认可用与显式关闭、Windows Git Bash/PowerShell 选择、命令隔离及审计回溯边界、输出文件和 `--debug` 脱敏语义；核对既有章节编号和交叉引用不变。
- [x] 7.2 在全部能力验收后统一调整 Core/CLI/package 的 v0.0.2 版本与帮助文案；运行 `pnpm dev --no-start` 验证构建、校验和版本显示。
- [ ] 7.3 运行 `pnpm verify`，并在 Windows 与至少一个 POSIX CI 环境运行真实命令/生命周期检查；在有 Git Bash 的 Windows 环境验证自动与显式选择，仅有 WSL launcher 的环境验证 `wsl` 兜底。复核命令规则、审批指纹、审计崩溃恢复、`Plan` 工具清单、大输出读取和 `FullAccess` 本次选择验收。必需平台命令工具未通过时继续修复，暂缓 v0.0.2 发布。

## 当前验收记录（2026-09-26）

- Windows 本机此前 `pnpm dev --no-start` 已通过；本轮修复后 `pnpm verify` 与 `pnpm build` 通过，38 个测试文件、284 个通过、3 个既有跳过。新增回归覆盖审批控制字符转义、消费者提前结束迭代时的工具清理与历史落盘、普通日志失败降级，以及 WSL 输出编码和内联/文件 UTF-8 边界截断；PowerShell 真实进程执行、中止、子进程回收、受限环境、输出上限、审批和审计门仍通过。
- 3.2：Shell 会话级批准仅对无参数 `pwd` / `Get-Location` 及工作目录内无参数的直接 `.sh` / `.ps1` 调用开放；直接脚本绑定真实路径和自身内容，组合命令仅能单次批准。
- 4.1：自动审批审查拒绝从项目设置合并可执行 `allow` 规则，理由是项目内容即使先被信任，后续仍可变更并扩大权限。当前 CLI 只接受用户级执行规则，项目权限与 Shell 字段拒绝；用户级与项目配置的 `FullAccess` 默认值均单独诊断并回退 `Approval`，旧配置缺失执行字段时安全退回默认值。
- 6.2：本轮在新的 WSL Ubuntu 隔离副本中使用缓存的官方 Node 24.18.1 与 pnpm 12.4.1，离线安装后 `pnpm dev --no-start` 通过：38 个测试文件、287 个全部通过。POSIX Bash 真实进程执行、超时、中止、孙进程回收、回收确认失败时的结果未知、UTF-8 和受限环境均通过。Windows Git Bash 的全部 21 项真实命令验收通过；修复了 `taskkill /T` 漏掉重挂父进程的 MSYS 后代，采用 MSYS 组信号、Windows launcher 回收及进程组消失确认。以上本地验收仍不能替代远端 CI。
- 7.2：Core/CLI/根目录 package.json 版本号已统一提升至 `0.0.2`，CLI 帮助及版本命令已更新为 `kpbl v0.0.2`；`pnpm dev --no-start` 构建与校验通过，`kpbl -v` 与 `kpbl -h` 正常显示新版本。
- 7.3：Windows + Ubuntu CI 工作流和 Git Bash 显式测试已加入，但尚未在远端 CI 运行；package.json 中的 `0.0.2` 是待发布工作区版本，远端 CI 与 Git Bash 验收完成前不宣布 v0.0.2 发布，任务仍未勾选。
- Code review 复盘（2026-09-26）：原实现写死 Git Bash 安装目录并用路径白名单识别，本机 PortableGit 与自定义盘符安装的 Git Bash 均被发现失败。已改为只用 `PATH` 与运行时 `uname` 探针分类，新增 `wsl` 兜底层与显式解释器全路径支持，`auto` 无环境时降级为仅禁用 `run_command`；shell-execution spec、proposal、design、迁移说明与 README 已同步。
- 发布包验收：Core 与 CLI 的 `0.0.2` tarball 各含 9 个文件，仅包含 dist、package.json、README 与 LICENSE；CLI 的 workspace Core 依赖已转换为精确版本 `0.0.2`。新目录独立安装、ESM/CJS 公共导出、`kpbl --version/--help` 与两包 `npm publish --dry-run --access public` 通过；npm 登录身份为 `kiturone`。
