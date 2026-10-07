# Model Provider Contract

## Purpose

定义多协议模型与统一 Agent 运行时之间可观察的输入、完成和工具安全契约，使宿主能够切换模型与协议，仍获得一致的历史、权限、取消和错误行为，避免协议差异导致错误端点请求或未完成工具执行。

## ADDED Requirements

### Requirement: Explicit protocol selection
系统 SHALL 按 Profile 显式协议选择 Chat Completions、OpenAI Responses 或 Anthropic Messages；厂商族和模型名称 SHALL 不隐式覆盖协议，失败 SHALL 不自动切换协议。

#### Scenario: Claude hosted behind a Chat gateway
- **WHEN** Claude 名称的自建 Profile 显式选择兼容 Chat
- **THEN** 请求发送到该网关 Chat 端点，不改为 Anthropic Messages

#### Scenario: Native provider fails
- **WHEN** 原生协议返回错误
- **THEN** 报告所属模型与协议的错误，不自动向兼容端点重试

### Requirement: Atomic model and provider binding
角色绑定 SHALL 将 Profile 与实际协议、模型和端点匹配的 Provider 一起生效。切换存在不匹配绑定时 SHALL 在网络调用前失败；任务执行期间 SHALL 保持绑定快照。

#### Scenario: Profile changes without a matching provider
- **WHEN** SDK 更换模型或协议却提供原来的不匹配 Provider
- **THEN** 明确报告绑定问题，实际模型请求次数为零

### Requirement: Complete response before tool execution
系统 SHALL 仅在完整响应通过终态、工具 ID/名称、唯一性和 JSON 对象参数校验后调度工具。无效 JSON、非对象参数、过滤、截断和断流 SHALL 不触发任何该响应工具，也不留下未执行工具历史。

#### Scenario: A batch contains one invalid call
- **WHEN** 响应中一个工具参数无效且其它参数完整
- **THEN** 整批调用在调度前失败，没有部分执行或悬空 tool_use

#### Scenario: Truncation contains a seemingly complete tool call
- **WHEN** 服务端终态表示截断但已经输出工具调用
- **THEN** 截断优先，系统不执行工具

### Requirement: Ordered final content without duplicate execution
系统 SHALL 保留服务端最终内容顺序；同一响应的增量与最终内容同时存在时 SHALL 只组装一次最终 assistant、只调度一次工具。既有仅提供增量的合法 Provider SHALL 继续可用。

#### Scenario: Final content repeats streamed tool deltas
- **WHEN** 同一调用先以增量出现，随后包含在完整内容中
- **THEN** 历史和工具执行均仅记录一次该调用

### Requirement: Cancellation and unknown usage remain truthful
取消和消费者提前结束 SHALL 等待在途清理及已经执行工具的结果闭合后释放会话锁。错误输出 SHALL 脱敏；缺失 usage SHALL 标为未知，不冒充真实零消耗。

#### Scenario: Consumer stops during tool progress
- **WHEN** 消费者结束事件迭代而工具仍在执行
- **THEN** 系统等待取消清理，保留已完成真实结果并闭合历史后释放锁
