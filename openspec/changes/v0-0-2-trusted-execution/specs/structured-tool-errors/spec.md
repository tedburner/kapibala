# Spec Delta

## Purpose

让工具失败、审批拒绝、取消和超时以稳定且安全的结构进入会话历史，使模型与宿主能区分可修复错误和需要用户处理的终态错误。

## ADDED Requirements

### Requirement: 工具错误携带稳定分类
工具失败 SHALL 提供稳定错误码与 `never`、`immediate`、`backoff`、`after_user_action` 之一的重试策略。发送给模型的错误描述 MUST 脱敏；内部异常堆栈只能进入受控开发诊断，不进入模型历史。

#### Scenario: 审批被拒绝
- **WHEN** 用户拒绝一次工具审批
- **THEN** 工具结果带权限拒绝码与需要用户行动的重试策略，且不包含审批系统的内部堆栈

### Requirement: 失败不破坏工具事务
任何已进入 canonical 历史的 `tool_use` SHALL 在下一条相应工具结果中闭合。授权拒绝、审批取消、日志失败、工具超时、Hook 异常与中止都 MUST 生成合法错误结果，之后才可结束运行或进入下一步。命令进程无法确认退出、执行后审计失败或崩溃恢复时，结果 SHALL 明确标记 `OUTCOME_UNKNOWN` 类状态与 `after_user_action`，不得伪称命令没有产生副作用。

#### Scenario: 多工具中一个被拒绝
- **WHEN** 同一模型消息包含多个工具调用，其中一个被拒绝
- **THEN** 每个 `tool_use` 都有对应 `tool_result`，历史可被后续 Provider 接收

#### Scenario: 超时但无法确认子进程退出
- **WHEN** 命令超时，系统已发出终止请求但不能确认整个子进程树回收
- **THEN** 工具结果标记结果未知，历史闭合，并停止自动继续或重试

### Requirement: 终态错误不盲目重试
`after_user_action` SHALL 在相关工具结果记录并落盘后结束当前运行，等待新用户输入。`never` SHALL 阻止同一运行中对相同工具和参数的重复调用。系统 MUST NOT 自动重试可能有副作用的工具；`immediate` 与 `backoff` 仅标示错误性质，不代表本版本自动执行重试。

#### Scenario: 需要用户处理
- **WHEN** 工具返回 `after_user_action`
- **THEN** 当前运行在闭合工具历史后结束，并向宿主报告需要用户处理

#### Scenario: 不可重复错误
- **WHEN** 模型在同一运行中重复发起相同且已标记 `never` 的调用
- **THEN** 第二次不执行工具，返回明确的终态错误结果

### Requirement: 旧历史兼容
此前不含错误码或重试策略的工具结果 SHALL 继续可读取。Provider SHALL 只序列化模型协议允许的安全信息，不把内部错误对象直接写入 wire 消息。

#### Scenario: 加载旧会话
- **WHEN** 会话历史包含 v0.0.1 格式的工具错误
- **THEN** 新版本可以加载并继续对话
