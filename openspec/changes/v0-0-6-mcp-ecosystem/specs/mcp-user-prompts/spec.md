# Spec Delta: MCP user prompts

## Purpose

定义用户对 MCP Prompt 的发现、参数化调用和受控任务提交，使远端模板作为可追踪的用户上下文进入现有会话，而不会伪造系统或模型历史、绕过运行锁或通过历史来源字段恢复旧授权。

## ADDED Requirements

### Requirement: Metadata discovery is separate from invocation
系统 SHALL 提供稳定 Server/Prompt ID、描述、参数、来源和可用性查询，发现/搜索不预取正文或启动模型；只有用户显式调用才请求模板正文。

#### Scenario: User searches prompt metadata
- **WHEN** 用户或 SDK 宿主搜索本地 Prompt 目录
- **THEN** 仅返回元数据，正文请求次数与模型请求次数均为零

### Requirement: Prompt arguments and identity are checked
系统 SHALL 接受 JSON 字符串对象参数，按必填/未知参数和当前连接身份校验，失败先于获取或提交；用户调用必须要求当前 Prompts 目录 ready，连接 ready 或混合 Server 的 Tools ready 均不能代替。Prompts SHALL 独立维护 catalogEpoch 和 refreshToken，通知立即递增 epoch、暂停未发送获取及尚未提交模板；只有当前 client/generation/能力/epoch/token 的完整复核能恢复可用性，过期成功或失败均不污染状态。刷新合并、补刷次数和总截止有界，持续通知时保持 stale/unavailable，不冒充空集成功。每次准备绑定开始时的当前 epoch，获取前和最终提交前均复核；期间 epoch 变化使该次准备失败，即使新复核确认同一摘要也只允许之后重新开始的调用。

#### Scenario: Required argument is missing
- **WHEN** 显式调用缺少模板必填参数或参数值不是字符串
- **THEN** 结果为参数错误，不发起正文请求且不追加用户任务

#### Scenario: Prompt identity changes during preparation
- **WHEN** 获取正文期间 Server/Prompt 身份变更
- **THEN** 准备失败并要求重新选择，不将旧模板以新来源提交

#### Scenario: Prompt catalog changes after fetch but before commit
- **WHEN** 模板已经获取，但预算检查或异步准备期间通知改变 Prompt epoch，最终提交前即使已刷新为相同摘要
- **THEN** 本次准备零 user append、零加载事件、零模型请求；用户可在当前 ready epoch 发起新的准备，旧准备不复活

#### Scenario: Old refresh success and failure arrive after a newer refresh
- **WHEN** 新 refreshToken 已发布 Prompt 目录后旧 token 返回成功或失败
- **THEN** 两类迟到结果均被忽略，不能覆盖目录、改写 ready 或恢复旧准备的提交资格

#### Scenario: Continuous notifications exhaust the refresh budget
- **WHEN** Prompt 目录在补刷期间持续收到通知
- **THEN** 达到补刷次数或原总截止后停止本轮刷新，保持不可获取/提交状态，不无限排队且不影响独立 Tools 状态

### Requirement: Explicit invocation does not override hard policy
系统 SHALL 对模板获取应用宿主硬限制、Plan 和 deny 规则；显式用户调用只表示该次获取许可意图，不授权模板建议的后续工具执行。

#### Scenario: Plan mode requests a remote template
- **WHEN** Plan 模式中用户显式执行远端 Prompt
- **THEN** 系统拒绝外部获取，正文请求和用户任务追加次数均为零

#### Scenario: A template suggests destructive tools
- **WHEN** 用户获准取得包含写入/执行建议的模板
- **THEN** 后续工具仍逐次经过权限/Skill/审批，不能继承模板获取许可

### Requirement: Preparation uses the task lifecycle
系统 SHALL 在会话和活动控制器同一运行锁及取消范围内准备完整模板，取得结果并通过输入预算后单条提交用户消息，提交成功后才请求模型。

#### Scenario: Prompt fetch is cancelled
- **WHEN** 用户在远端模板获取期间取消或消费者结束
- **THEN** 获取有界收口，历史无半份用户任务，准备期间其他变更动作被拒绝

#### Scenario: Input budget cannot fit the template
- **WHEN** 完整文本模板无法满足实际请求输入预算
- **THEN** 系统拒绝准备，不截断指令冒充成功且模型请求次数为零

### Requirement: Remote roles remain user context
系统 SHALL 按原始顺序将文本模板中的角色作为标签表达在用户上下文中，不写成真实 assistant/system 历史；不可安全表达的必需非文本内容应明确拒绝。

#### Scenario: Template includes assistant examples
- **WHEN** 模板含 user/assistant 多条文本示例
- **THEN** 本轮仅追加一条 user 任务，示例带标签保序，不伪造 assistant 回应

### Requirement: One user message avoids duplicate raw arguments
系统 SHALL 将不含 arguments-json 的调用标识（如 `/prompt server/name`）、调用方显式任务正文和完整模板作为单条 user 消息提交，不保存整条原始命令作为任务正文。Prompt metadata/provenance、应用主动回显、诊断及审计 SHALL 不重复保存或打印原始参数对象。显式任务正文或模板可能包含参数值并进入模型、历史与摘要；此规则不是自动秘密脱敏，不承诺清除终端输入回显或外部 shell 历史。

#### Scenario: Arguments include a value also present in the template
- **WHEN** 用户以 arguments-json 调用 Prompt，模板文本引用其中某值
- **THEN** 只提交无 arguments-json 的调用标识、显式任务正文和模板，不在来源字段或应用回显再复制参数；模板中的值仍可能进入模型和持久历史

#### Scenario: Explicit task text contains a secret
- **WHEN** 调用方主动将秘密放入显式任务正文
- **THEN** 文档如实说明正文可被模型消费并进入历史/摘要，不承诺参数过滤会自动脱敏该正文或删除终端与外部 shell 记录

### Requirement: Provenance is committed and nonauthorizing
系统 SHALL 保存可选 promptSource v1 来源及内容摘要，不保存 arguments-json 或认证值，提交后发布加载事件；旧历史可缺省来源，来源不进入模型私有 wire，也不授予恢复权限或重新获取资格。

#### Scenario: Message persistence fails
- **WHEN** 模板准备成功但 user 消息追加失败
- **THEN** 不发布已加载事件、不启动模型、不激活任何新权限

#### Scenario: Historical prompt is resumed without its server
- **WHEN** 恢复包含 Prompt 来源的旧历史且当前未配置该 Server
- **THEN** 保存文本仍可消费，不连接旧端点或重新获取模板，来源仅供解释
