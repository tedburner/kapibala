# CLI Skills Commands

## Purpose

让用户在终端中清楚地发现、检查和显式使用技能，使名称补全、来源与可用原因来自同一技能集合，并确保命令输入不会在忙碌、非法参数或加载失败时意外进入模型历史或执行任务。

## ADDED Requirements

### Requirement: Searchable skills and diagnostics
CLI SHALL 支持 /skills [query]，显示名称、描述、来源、用户/模型可调用性、不可用原因、目录遗漏及当前运行活动状态。补全 SHALL 由当前生效元数据生成，不硬编码名称；宿主 SHALL 可查看被覆盖/无效候选诊断。

#### Scenario: Disabled skill inspected
- **WHEN** 用户搜索一个被禁用或格式不支持的技能
- **THEN** 能看到对应原因而不是把它展示为可执行

### Requirement: Explicit invocation carries user task
CLI SHALL 支持 /skill <name> <task...>，把用户原始任务和宿主技能注入交给共享加载入口。缺少名称或任务 SHALL 返回用法，不自动执行；用户入口 SHALL 允许 user-only 技能并拒绝 user-invocable=false，不凭命令扩大信任或执行权限。

#### Scenario: User-only skill with task
- **WHEN** 用户明确调用仅限用户的技能并提供任务
- **THEN** 正文由宿主加载并与任务落盘，模型无需绕过加载工具限制

#### Scenario: Missing task
- **WHEN** 用户只输入 /skill <name>
- **THEN** 返回补充任务的用法，不启动模型或自动执行副作用

### Requirement: Busy and invalid commands do not mutate conversation
缺失技能、非法参数、忙碌或清理中的显式调用 MUST 拒绝，不开始模型请求或追加任务。加载失败不得留下成功注入；错误 SHALL 以诊断展示。切换会话 SHALL 等清理后重新绑定技能集合。

#### Scenario: Invocation during tool cleanup
- **WHEN** 当前任务正在取消并等待工具回收时输入 /skill
- **THEN** 命令拒绝，不排队串入审批或下一任务

### Requirement: Tool-disabled mode stays coherent
宿主关闭工具时 SHALL 禁用技能执行入口与模型目录，仍允许 /skills 查看元数据。仅用户可调用技能的集合 SHALL 省略模型加载目录，但真实用户成功激活后 SHALL 可受控读取该技能资源。技能事件与终端交互 SHALL 经公开宿主接口，CLI 不另实现领域授权逻辑。

#### Scenario: Explicit skill with tools disabled
- **WHEN** 宿主整体关闭工具或skills.enabled=false时用户调用/skill
- **THEN** 提示技能执行不可用，不注入要求调用不存在工具的正文

#### Scenario: Shell disabled but skill reads files
- **WHEN** CLI使用既有--disable-shell而调用只需要文件读取的合法技能
- **THEN** 技能与读取入口仍可用，命令工具保持关闭，不把它误解为整体禁用工具

### Requirement: Raw task and managed invocation stream
/skill SHALL 作为变更类rawTail命令注册，名称之后的任务保留引号/空格/换行，不做参数插值。CLI SHALL 经活动会话控制器和本轮事件渲染消费完整任务，复用取消/退出等待；不得直连Session绕过控制器或把任务交给只读状态渲染器。

#### Scenario: Task includes quoted text and newlines
- **WHEN** 用户输入技能名后带连续空格、引号和多行任务
- **THEN** 原任务完整进入用户文本，不经split/join改写或shell/$ARGUMENTS展开

#### Scenario: Cancel explicit skill task
- **WHEN** /skill运行中用户Ctrl+C或退出
- **THEN** 控制器保持busy直到工具回收和状态清理，随后才允许切换或释放会话
