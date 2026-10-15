# Spec Delta: CLI MCP management

## Purpose

定义 REPL 与非交互宿主的 MCP 管理、工具诊断和 Prompt 命令体验，使只读查询、连接变更及用户任务各有明确门禁，并复用活动会话与输入所有权而不提前建设完整 TUI。

## ADDED Requirements

### Requirement: Fixed management and prompt commands
CLI SHALL 提供 /mcp、/mcp tools、/mcp reconnect|enable|disable、/prompts、/prompt 与 --no-mcp，保留 MCP 命名空间和来源；原始 MCP 工具不作为用户 Slash 命令。

#### Scenario: Two servers expose the same prompt name
- **WHEN** 两个 Server 提供同名 Prompt
- **THEN** 用户以 server/name 区分，固定 /prompt 入口不与内置命令冲突

### Requirement: Readonly commands do not initiate execution
CLI SHALL 允许忙碌期读取本地状态/目录快照，查询不得隐式连接或发起审批；重连、开关和模板执行走统一变更门禁。

#### Scenario: Status is requested while a remote tool runs
- **WHEN** 用户在工具执行期间查询 /mcp
- **THEN** 返回当前安全状态而不占用新审批输入或发起连接

#### Scenario: Reconnect is requested during prompt preparation
- **WHEN** 本轮模板准备、执行或清理期间用户请求重连
- **THEN** CLI 拒绝变更并保持当前任务及连接所有权

### Requirement: Input ownership and noninteractive refusal
CLI SHALL 在取得输入所有权的阶段展示启动/调用审批，非 TTY 输出无 ANSI；需要人工授权但缺通道时明确拒绝，不能后台抢占输入或悬挂。

#### Scenario: Multiple servers require startup approval
- **WHEN** 多个 Server 并发准备且需要人工启动批准
- **THEN** 审批按输入所有者串行呈现，不能同时读取终端或吞掉 REPL 命令

#### Scenario: Piped invocation needs authorization
- **WHEN** 单次问答从非 TTY 执行且未预授权 Server
- **THEN** 输出可操作拒绝，不等待交互、不打印 ANSI 和凭据

### Requirement: Session switching preserves independent ownership
CLI SHALL 为目标会话创建独立 MCP 状态；目标 required Server 失败保持旧会话，切换后旧资源有明确清理所有者，不能共享项目审批或连接实例。

#### Scenario: New session fails required startup
- **WHEN** 新建/恢复目标的 required Server 无法启动
- **THEN** 当前会话及其工具仍可使用，失败目标资源被清理

### Requirement: Prompt input is not duplicated into history or echo
CLI SHALL 从 raw-tail 解析 `/prompt <server>/<name> <arguments-json>`，但提交的单条 user 消息仅包含无 arguments-json 的调用标识、显式任务正文和模板；应用主动回显、metadata、诊断及审计不重复原始参数。帮助 SHALL 说明正文及模板可能带参数值进入模型、历史与摘要，参数不重复记录不等于自动脱敏，也不承诺清除终端输入或外部 shell 历史。

#### Scenario: Raw-tail JSON contains spaces and sensitive values
- **WHEN** 用户通过含空格的合法 JSON 参数调用 Prompt
- **THEN** 参数被正确解析并用于受控获取，但不作为整条原命令落入 user 正文或应用回显；无参数 JSON 的调用标识、显式任务正文和模板单条提交

### Requirement: Diagnostic and detailed output are truthful
CLI SHALL 分开展示连接、Tools、Prompts 状态，并展示失败/禁用/未信任/目录遗漏和当前会话开关；连接 ready 不应被展示为全部能力就绪。summary/detailed 仅展开实际保留的安全结果，已知成功附宿主错误不得显示为远端未知或鼓励重试；帮助不得宣称延期能力（含本版排除的缓存友好压缩专项）已交付。

#### Scenario: Mixed server has available Tools but unavailable Prompts
- **WHEN** Server 连接与 Tools ready，而 Prompts unavailable
- **THEN** 状态明确显示能力差异，工具可继续按策略执行，用户 Prompt 调用被拒绝而不是按空目录成功处理

#### Scenario: A large result is truncated
- **WHEN** 用户展开被预算截断的 MCP 工具结果
- **THEN** 明确显示省略事实，不伪造完整原文、资源读取或 OAuth 功能入口

### Requirement: Plugin extension inspection and contributes contract
CLI SHALL 提供 `/plugins [name]`（别名 `/plugin`）只读诊断命令，展示当前会话已挂载的插件列表及其声明的扩展贡献元数据（贡献命令、技能目录与运行概况）；Core 的 `AgentPlugin` 契约 SHALL 支持声明式 `contributes: PluginContribution`（包含 `commands` 与 `skillsRoots`），使扩展能力在逻辑层面统一由插件容器声明与装配，同时保持 Core 0 运行时依赖与 Headless 约束。

#### Scenario: User queries mounted plugins in active session
- **WHEN** 用户在终端输入 `/plugins` 或 `/plugin`
- **THEN** CLI 从活动会话中读取已挂载插件只读列表，格式化输出插件名、版本、描述以及所贡献的斜杠命令与生态概况，在会话忙碌期安全放行且不产生写操作
