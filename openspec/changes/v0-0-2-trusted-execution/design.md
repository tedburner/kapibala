# Design

## Context

见 [proposal.md](proposal.md)。当前 `ToolExecutor` 先运行可改写参数的 `tool:before` Hook，再解析并执行工具；能力声明仅存在于 `ToolMetadata`，不参与裁决。`AgentSession` 的 `logger?: (msg: string) => void` 只在 CLI 传入 `--debug` 时接到终端，`step_log` 是展示事件而非可靠日志。历史由 `JSONLMessageStore` 保存，其内容包含模型上下文，不能充当脱敏的运行日志或授权审计。项目配置必须永久信任后才合并，提示词组装器尚无 L4 项目指令层。Core 保持 Headless、运行时零第三方依赖；每条 canonical `tool_use` 必须在后续历史中闭合。

## Goals / Non-Goals

**Goals:**

- 将结构化日志作为默认基础能力；一次操作可以跨模型、审批、工具执行、崩溃恢复与错误事件追踪。
- 在全部参数改写完成后对最终调用裁决，并在副作用前完成授权审计；若审批目标在等待期间变化，启动前重新裁决。
- 保持 CLI、SDK 对模式与错误的同一语义，同时由宿主实现交互和日志存储。
- 保证 `AGENTS.md` 热加载不改变一次运行中的指令快照。

**Non-Goals:**

- 不声称本地文件日志防篡改、集中留存或具备合规级身份认证；这些属于 v0.0.9 的加固工作。
- 不将 Bash 或 PowerShell 包装成文件沙箱，也不通过命令字符串静态分析保证其网络或文件行为。
- 不在 v0.0.2 实现完整五层配置通用合并引擎、远程日志上传、自动工具重试或 Skill/MCP。

## Decisions

### 1. 一套结构化日志接口，两类持久化通道

Core 新增 `logging/`，公开 `LogEvent`、`EventLogger`、`LogSink` 和可注入的上下文。事件至少有 `schemaVersion`、UTC 时间、`level`、`event`、`sessionId`、`runId`；工具事件另有内部生成的 `operationId` 和模型提供的 `toolUseId`。`operationId` 不依赖 v0.0.3 才引入的 canonical 消息 ID。正常运行记录 `INFO/WARN/ERROR` 及全部审计事件，`--debug` 再写入 `DEBUG/TRACE` 并由 CLI 向 stderr 显示；审计通道不受日志级别过滤。

文件存储放在用户级 `~/.kapibala/logs/` 与 `~/.kapibala/audit/`；CLI 使用文件 Sink，Core SDK 可注入自己的持久化 Sink，未注入时使用 Core 的用户级文件实现。用户若在 home 目录启动项目，这些目录仍可能落入文件工具根目录，且命令进程与日志属于同一系统用户，因此位置与文件权限不能充当防篡改或访问隔离承诺。文件按日且达到 10 MiB 时轮转；运行日志默认保留 30 天，审计日志不自动删除，并报告审计目录用量与空间不足。写入串行化以避免并发 JSONL 交错；审计每条写入完成并同步到文件后才确认成功。POSIX 尝试将目录和文件权限分别收紧至 `0700/0600`；Windows 不宣称 POSIX mode 等于 ACL 隔离。

示意结构：

```ts
interface LogEvent {
  schemaVersion: 1;
  timestamp: string;
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  channel: 'operation' | 'audit';
  event: string;
  sessionId: string;
  runId?: string;
  operationId?: string;
  toolUseId?: string;
  fields: Record<string, string | number | boolean | null>;
}

interface EventLogger {
  record(event: LogEvent): Promise<void>;
  recordAudit(event: LogEvent): Promise<void>; // 持久化失败即拒绝工具启动
}
```

运行事件清单首期覆盖 `session.started/finished`、`mode.changed`、`settings.loaded/migrated`、`instructions.loaded/failed`、`model.request.started/finished/failed`、`tool.requested/started/finished`、`permission.decided`、`run.aborted/failed`、`audit.outcome_unknown`。`tool.requested`、`permission.decided`、`tool.started`、`tool.finished` 归审计通道，其中授权记录写在工具启动前。授权来源枚举为 `human`、`mode`、`rule`、`session_cache`、`hard_limit`，同时记录 `allow/deny`、规则来源、审批选项和最终状态。人工身份在本地 CLI 仅标为 `local_user`，不伪造强认证身份；其它宿主可提供 principal。

日志 API 只接受经过白名单投影后的结构化字段。Core 提供集中脱敏和长度上限；路径可记录相对工作区的摘要，文件正文、模型输出、完整提示词、完整命令输出、API Key、认证头及环境变量值默认不入日志。`run_command` 审计记录解释器身份、真实工作目录摘要、命令长度、SHA-256 命令摘要、最终执行指纹及保守预览；预览只包含固定白名单命令类别及参数数量，不复制任何自由文本参数，未知类别写占位符，不持久化原始命令。完整命令只出现在现有会话历史的 `tool_use` 中，可用 `toolUseId` 关联；若崩溃发生在历史落盘前，日志只保证摘要和状态，不能承诺恢复完整命令。`--debug` 也执行同一脱敏；现有基线中的“dump 原始 SSE”表述须同步收紧。普通日志写入失败向宿主发诊断并继续运行；审计写入失败在执行前变为 `AUDIT_UNAVAILABLE` 工具错误。执行后写审计失败时返回 `AUDIT_WRITE_FAILED_AFTER_EXECUTION`，提示操作可能已发生并停止自动继续，避免误重试。

审计采用 `requested → decided → started → finished` 单向状态机；`started` 在拿到子进程 ID 后尽快写入，崩溃可能发生在 spawn 与写入之间，因此 `decided=allow` 且缺少终态的操作也视为结果未知。若进程已启动但 `started` 写入失败，立即请求中止、等待回收并返回结果未知，不继续后续工具。启动时流式扫描审计文件中的未闭合操作，追加 `audit.outcome_unknown`，保留原 `operationId`，并将该状态与历史自愈的工具结果关联；扫描不一次性加载全部审计历史。审计不把“缺少 finished”解释为“没有执行”，也不自动重试。对用户级日志的本地修改仍无法防护，这是本版明确接受的限制。

选择结构化 JSONL 是为了零依赖、可顺序追加和按 ID 检索。没有选择复用 `history.jsonl`，因为历史需要回填模型且可能包含敏感正文；也没有选择仅靠 `tool:after` Hook，因为它看不到执行前授权失败和崩溃中途的状态。CLI 增加 `/logs [count]` 查看最近脱敏事件与文件路径，`/status` 展示当前日志位置；非交互运行的日志写入不污染 stdout。

### 2. 最终授权门位于 ToolExecutor 的末端前置阶段

`ToolExecutor` 将操作拆为：记录请求 → 解析工具 → 顺序运行前置 Hook（可 `skip/modify`）→ 固定最终参数 → `PermissionPolicy.evaluate` → 如需询问则 `ApprovalChannel.request` → 复核实际执行目标与审批指纹 → 审计授权决定 → 执行工具 → 审计结果 → 构造 `tool_result`。复核发现目标变化则重新裁决，最多一次；仍变化则返回目标不稳定错误，避免无限审批循环。Hook 的跳过、异常和工具不存在也走审计与错误结果。权限插件可提供规则，但最终门由 Executor 固定调用，避免注册顺序或后续参数改写绕过授权。这是对设计基线“权限仅为普通 `tool:before` Hook”的必要收紧；Loop 仍不负责权限。

```text
tool_use
  -> audit(request)
  -> tool:before hooks / final input
  -> hard limits -> deny/session deny -> explicit ask -> session allow -> trusted allow -> mode default
  -> approval channel if needed
  -> revalidate approved target -> audit(decision) [failure: no execute]
  -> tool.execute
  -> audit(outcome) -> tool_result
```

`PermissionPolicy` 是纯裁决器，输入工具元数据、最终参数、模式和带来源的规则，返回 `allow/deny/ask` 与原因码。宿主硬限制及 `Plan` 拒绝优先；任何匹配 `deny`（含会话拒绝缓存）一票否决，显式 `ask` 优于所有自动允许；允许缓存仅用于默认产生的询问；可信 `allow` 优于模式默认值。未声明能力的工具固定 `ask`，非交互时拒绝。仅用户级配置、命令行和已信任项目可贡献 `allow`；当前 CLI 对未信任项目配置仍维持“先信任或退出”，不从中读取可执行设置。项目 `AGENTS.md` 永远不输入裁决器。`FullAccess` 只是末位默认 `allow`，不注册工具、不覆盖前面的限制。

审批返回 `allow_once`、`allow_session`、`deny_session` 或取消；会话缓存键由工具名、声明能力和规范化后的最终参数计算，仅内存保存。Shell 另将解释器真实路径及文件身份、工作目录 realpath、完整命令、受限环境变量指纹、超时与输出策略加入 SHA-256 执行指纹。审批界面显示完整最终命令、真实工作目录、实际解释器和允许范围；审计只记摘要和脱敏预览。若能无歧义地绑定直接引用的脚本文件，指纹也包含其内容摘要并在启动前复核；无法绑定的外部脚本调用不提供 Shell 的 `allow_session`，仅能单次批准。任何会话允许都只表示这一次精确执行上下文，不承诺脚本在命令运行期间不可变。显式 `ask` 每次都问，缓存不能越过它。CLI 通过统一输入协调器使用现有 REPL 的 readline；单次运行在 TTY 下使用相同审批界面，非 TTY 返回拒绝。审批等待受会话 AbortSignal 控制，不占用工具执行超时额度。

当前实现将 Shell 会话级批准限制为无参数的 `pwd` / `Get-Location`，以及工作目录内无参数的直接 `.sh` / `.ps1` 调用。直接脚本的真实路径和自身内容进入指纹，审批后编辑会重新裁决；组合命令和间接调用仅能单次批准。脚本内部引用的依赖不在内容摘要内。

内置文件工具继续自行调用 `PathSandbox`，授权只能允许调用，不能让越界路径变合法。Shell 组合、展开与子进程不能靠字符串前缀可靠分析，因此 v0.0.2 不支持 `run_command` 的前缀或通配符规则；含此类 Shell 规则的配置加载失败并给出可定位诊断，不允许规则被静默忽略。Shell 的 `allow/ask/deny` 只支持绑定解释器和工作目录的完整命令匹配；整项工具或 `exec` capability 的 `deny/ask` 仍适用。工具名或 `exec` capability 的泛化 `allow` 不覆盖 Shell 默认询问，只有显式进入 `FullAccess` 或最终命令精确 `allow` 才能自动执行。后续若要扩大匹配语言，需要独立安全评审。

模型工具清单在每次请求前根据当前会话模式、显式关闭和整项 `deny` 构造。`Plan` 下不向模型提供执行、写入、网络工具，被整项拒绝的工具也从清单移除；运行时授权门仍保留，防止直接 SDK 调用或模型旧输出绕过。`/mode` 只在空闲切换，下一次模型请求使用新清单；同一运行的模式和规则使用固定快照。

### 3. 错误分类与历史闭合

`KapibalaError`/`ToolError` 扩展稳定 `code`、`retryPolicy`、`safeMessage` 和可选内部 `cause`；`ToolResultBlock` 增加可选 `errorCode/retryPolicy` 以兼容旧 JSONL。Executor 不再把未知 `Error.message` 原样送给模型。授权拒绝、缺失工具、Hook 异常、审计失败、超时和中止都映射为安全结果，错误细节只进入脱敏开发日志。

Loop 在所有工具结果装配、历史闭合并落盘之后处理策略：`after_user_action` 结束当前运行并派发宿主可显示的状态；`never` 在本次运行中阻止相同工具与参数再次执行；`immediate/backoff` 仅描述错误性质，本版本不自动重试可能有副作用的工具。当前连续错误熔断保留，判断发生在工具结果落盘后。执行后审计失败、无法确认子进程树退出及崩溃恢复中的未闭合操作均使用 `OUTCOME_UNKNOWN` 类状态与 `after_user_action`，不得被当作可重试的纯失败；历史补齐只保证协议合法，不证明操作未发生。

### 4. AGENTS.md 由独立加载器产生轮次快照

Core 新增 `instructions/`，宿主传入 `projectRoot` 和 `cwd`；CLI 优先使用 Git 工作树根，否则以 cwd 为项目根。用户层固定 `~/.kapibala/AGENTS.md`，项目层只沿项目根到 cwd 的目录链查找，并先校验真实路径仍处于链内。单文件上限 32 KiB、总量 128 KiB、最多 16 层；超限、不可读或解析异常不得部分注入。每次 `AgentSession.run()` 在写入新的 user 消息前检查文件链并原子替换快照；当前运行只消费启动时快照。刷新失败保留上次快照并发诊断；首次加载失败无快照时明确终止本轮。

`PromptAssembler` 将快照作为 L4 层，按用户层 → 项目根 → cwd 顺序附带来源标签。`/status` 或 `/instructions` 展示路径、加载时间和诊断，不回显全文。指令属于提示词输入，不解析其中的权限命令。没有选择每个模型步骤都重读，因为同一轮工具循环会出现约束漂移；也不把项目指令写进 canonical 历史，避免旧内容永久积累。

### 5. 跨平台命令工具的默认注册、环境选择与进程生命周期

`run_command` 是 v0.0.2 的基础工具：CLI 默认注册，并在允许执行的模式下向模型提供，无需额外启用参数。用户可通过 `--disable-shell` 或用户级 `shell.enabled=false` 关闭；SDK 宿主可作相同的显式选择，项目配置及 `AGENTS.md` 不能改变注册状态。注册只决定工具能否进入可用清单；每条命令仍经过统一权限和审计入口。默认 `Approval`/`Auto` 模式下命令请求人工批准，`Plan` 隐藏并拒绝，`FullAccess` 按显式规则和硬限制裁决；切换模式不能重新启用已关闭的工具。

本地源码参考：Claude-Code 的 `src/tools.ts` 将 `BashTool` 纳入基础工具列表，`src/tools/BashTool/BashTool.tsx` 通过 `checkPermissions` 处理调用授权；其 `PowerShellTool` 有独立的环境门控，不能据此推断它对所有用户默认开放。Grok 重建仓库的 `source/packages/agent/tools/core/shell/create-shell-tool.ts` 在创建工具后仍运行 preflight、审批与执行流程；`source/packages/shell-exec/platform-shell.ts` 分别发现 Git Bash 和 PowerShell。Kapibala 借鉴“默认提供命令能力、每次调用独立授权”的分层，并自行定义 Windows 的自动降级规则，不照搬两者的全部沙箱或审批实现。

`--shell auto|bash|wsl|pwsh|powershell`（或解释器可执行文件全路径）指定执行环境，缺省为 `auto`。发现只依赖 `PATH` 环境变量与用户显式给出的路径，不写死任何安装目录（Git for Windows 的安装位置因机器而异，且 PortableGit 等发行版路径不含固定片段）。宿主在会话启动时解析可执行文件的绝对路径和文件身份，以无副作用探针验证预期参数、路径语义和工作目录可用后固定环境，模型输入只包含命令，不能改选环境。bash 家族候选以运行时 `uname` 探针分类：报告 MINGW/MSYS/Cygwin 的为 native Bash，Windows 上报告 Linux 的是 WSL launcher（独立 `wsl` 环境，工作目录由 launcher 映射为 POSIX 路径）。POSIX `auto` 选择 Bash；Windows `auto` 按 native Bash → WSL → PowerShell 7 (`pwsh`) → Windows PowerShell (`powershell.exe`) 依次兜底。若 `auto` 没有找到可用环境，宿主报告诊断并从工具清单移除无法执行的工具，其余工具照常可用；显式指定的环境（具名或全路径）不可用或类型不符时启动失败并给出明确错误，不把一种语法静默交给另一环境——PATH 上没有 Bash 的用户必须显式提供 `bash.exe` 全路径才能获得 Bash。状态、工具说明和日志明确显示实际环境，使模型按 Bash 或 PowerShell 语法生成命令。没有 Git Bash 的 Windows 机器只需 PowerShell 即能使用命令工具。

注册的 `run_command` 标记 `dangerous: true`，保守声明 `fs:read/fs:write/exec/net:outbound/env:read`：这些能力表示命令*可能*触及的宿主资源，不表示已实现细粒度隔离。`Approval`/`Auto` 默认询问，`Plan` 拒绝，`FullAccess` 可在无显式 `deny/ask` 时自动放行。工具说明和审批提示必须明确当前系统用户权限和 PathSandbox 不适用于命令进程。

执行适配器统一使用 `spawn(executable, args, { shell: false, cwd, env: allowlistedEnv })`。Bash/WSL 参数为 `--noprofile --norc -c <command>`；PowerShell 参数为 `-NoLogo -NoProfile -NonInteractive -Command <command>`。适配器负责 PowerShell 5.1/7 的 UTF-8 输出处理、退出码与 stdout/stderr 归一；若需固定编码前置语句，该语句由宿主确定并在审计中标明，展示和批准的用户命令保持一致。模型工具参数首期只含 `command`、可选 `timeout_ms`；命令长度上限 8 KiB，默认超时 120 秒，最大 10 分钟，最终超时值进入审批指纹。限制继承的环境变量可以减少意外暴露，但命令仍可读取当前用户有权访问的文件，不能据此声称隔离。

`run_command` 自己管理进程生命周期，不能直接套用当前 `ToolExecutor.withTimeout()` 的 `Promise.race` 语义：该实现只会停止等待，不能证明子进程结束。Executor 对命令工具委托其超时与中止控制，或改用一个能等待资源回收的可取消执行契约。POSIX 以独立进程组运行并先发 `SIGTERM`、宽限后发 `SIGKILL`；Windows 采用受控子进程树终止，并在结束前确认进程状态。只有确认进程树退出或明确记为结果未知后，才能写终态审计并返回工具结果；回收失败不得显示“已中止成功”。实现时需验证 Windows `taskkill /T /F` 等受控终止方式的返回值和子进程状态，不能仅凭发出终止命令推断成功。

模型内联输出上限为 stdout/stderr 合计 64 KiB；一旦超过，把已缓冲的开头与后续输出一起写入工作区 `.kapibala/tool-results/<operationId>.txt`，文件最多 16 MiB，再超出则继续排空管道但丢弃内容，避免阻塞子进程。结果含退出码、内联截断和文件截断标记、文件路径；现有 `read_file` 可按行读取该路径。CLI 通过 `SessionEvent` 展示节流后的已运行时间、输出字节数和可中止状态；未经脱敏的输出不写入日志。工具结果文件不视为保密存储，随工作区访问权限暴露，按 7 天清理且不触碰用户创建的同名文件；清理只作用于该专用目录内按操作 ID 命名的受管文件。后台命令与交互式 stdin 不在 v0.0.2 范围。

### 6. 配置、发布与验证边界

CLI `--permission <approval|plan|auto|full-access>` 覆盖用户级默认模式，REPL `/mode` 在空闲时切换。`FullAccess` 只允许本次会话主动选择：`/mode full-access` 在 TTY 下明确确认，显式 `--permission full-access` 代表命令行本次选择；用户级与项目级配置中的默认 `FullAccess` 均不生效，改用 `Approval` 并显示诊断。SDK 宿主需在本次会话显式传入该模式。CLI 在横幅或状态区持续显示当前模式，不能只在切换瞬间提示。项目设置不得将模式提高为 `FullAccess`，权限规则按来源加载并保留来源信息，不通过现有浅合并丢失规则来源。全局设置写入仍使用 `loadGlobalSettingsForWrite()`，保留旧配置不含权限字段时的默认 `Approval`，不物化全部内置模型。`--debug` 仅设置日志详细度和终端诊断，不控制日志系统开关。`/logs`、`/mode`、`/instructions` 纳入 `/help`。

验证以 `pnpm verify` 为门禁，并在 Windows PowerShell 与 POSIX Bash 上使用真实子进程生命周期用例覆盖正常执行、中止、超时、输出超限和工作目录变化；有 Git Bash 的 Windows 环境另测自动与显式选择 Bash，只有 WSL Bash 时验证选择 `wsl`，WSL 不可用时再验证回退 PowerShell。核心端到端用例用假的 Provider、审批通道和临时文件 Sink，不接触真实模型、密钥或外网。发布顺序为日志基础 → 权限与错误 → 项目指令 → CLI 交互与配置 → 跨平台命令工具。命令工具的代码合入之前必须通过权限、审计和历史闭合用例；v0.0.2 的发布验收必须包含默认可用的命令工具，以及审计崩溃恢复和子进程回收用例。

## Risks / Trade-offs

- [工具代码或 Hook 自身在授权前产生副作用] → 插件代码与 Hook 仍在宿主进程内运行；本版本只保证经 Executor 的工具调用授权，接口文档禁止前置 Hook 做副作用。真正的插件隔离归入后续版本。
- [本地审计被同一系统用户修改，尤其命令工具已启用] → 用户级目录与限制权限只减少误访问，不构成隔离；明确非防篡改性质，后续集中留存和宿主隔离再加固。
- [命令引用的脚本或外部资源在执行期间变化] → 审批绑定可解析的启动目标并在启动前复核；对无法绑定的目标禁用会话批准，明确本版本不保证执行期间所有依赖不可变。
- [审计只留脱敏预览与摘要，崩溃时历史可能尚未落盘] → 明确结果未知和无法恢复完整命令的限制；不为回溯而默认保存可能含密钥的原始命令。
- [FullAccess 与默认可用的 Shell 组合形成宿主级执行能力] → 仅允许本次主动选择、持续显示模式，保留显式规则与宿主硬限制；本版本不声称拥有命令进程沙箱。
- [审计写入导致工具延迟] → 仅审计事件逐条同步；普通运行日志可顺序追加。以可靠留痕优先于极低写入延迟。
- [Windows 子进程树回收不完全] → 超时/中止后核查进程状态，不能确认时返回不确定结果并记录错误；端到端覆盖该平台。
- [权限默认收紧影响 SDK 既有工具] → 作为 **BREAKING** 变更写迁移说明，要求声明 capability 或配置人工审批；旧历史与设置继续读取。
- [AGENTS.md 文本含提示词注入] → 它只影响模型行为；最终授权由代码裁决，且项目指令不能注册工具或放宽规则。

## Migration Plan

1. 先增加兼容的日志、错误与配置字段，使 v0.0.1 历史和全局配置继续加载；发布说明告知 SDK 自定义工具的新授权要求。
2. 在文件工具上启用最终授权与审计门，并通过四态、Hook 改写及审计失败回归测试；此阶段命令工具仍不注册。
3. 启用 CLI 模式、审批、指令加载和诊断命令；保留既有项目配置的信任确认流程。
4. 最后将 `run_command` 纳入默认工具注册，完成 Windows PowerShell 与 POSIX Bash 的执行和子进程回收验证；Windows Git Bash 可用时验证自动与显式选择。若任一必需平台的命令执行验收失败，继续修复并暂缓宣布 v0.0.2 完成，不以关闭命令工具的方式通过发布门禁。
5. 用户回退版本时，新日志文件和新配置可选字段不会改变旧版历史格式；旧版忽略新字段。若回退后工具权限不可用，发布说明明确旧版不具备 v0.0.2 的执行前授权。
