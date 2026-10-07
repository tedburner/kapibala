# Canonical History Protocol Extensions

## Purpose

在既有消息身份、交互终态和工具事务闭合规则之上，增加多协议来源与回传状态的保真约束，使原生响应、跨协议切换和摘要都保留普通历史语义，同时防止无效私有状态被写入目标模型请求或泄漏到展示。

## ADDED Requirements

### Requirement: Protocol independent tool result storage
所有协议 SHALL 保存 canonical tool 角色与 tool_result 内容，协议发送格式 SHALL 仅作用于独立请求投影。调用/结果别名转换 SHALL 同步、确定且不改持久 ID；恢复 SHALL 不重放工具。

#### Scenario: Claude planning history is used by OpenAI
- **WHEN** 包含 Anthropic 工具调用与结果的会话切换到 Responses
- **THEN** 结果仍闭合为统一历史并投影为匹配的函数结果，不被认成孤儿消息

### Requirement: Validated protocol provenance
新原生内容 SHALL 保存可验证的协议、模型、run、端点范围及版本来源；新加密状态 SHALL 有结构和大小约束。未知来源的旧思考 SHALL 保留可见内容，但不能伪造成有效签名/密文。

#### Scenario: Legacy thinking has no origin
- **WHEN** 加载缺少来源标记的旧 thinking 块
- **THEN** 可保留可见文字，原生请求不把它当成有效签名思考

### Requirement: Private state is excluded from summaries
摘要输入和过程日志 SHALL 排除签名、脱敏密文、加密 provider 状态及私有 Item 元数据。原始历史 SHALL 保留；当前协议合法回传状态 SHALL 计入请求预算，不能当精确 token 零开销。

#### Scenario: Another model produces a summary
- **WHEN** 摘要源历史包含签名和加密 reasoning
- **THEN** 摘要模型只收到可摘要文本/工具语义，不收到私有状态文字

### Requirement: New blocks preserve lifecycle and message boundaries
新内容类型 SHALL 参与加载校验和成功交互判断，规范化 SHALL 不合并有不兼容 phase/Item 边界的消息。有效最终回答包含新状态块时 SHALL 不被误判成中断，失败草稿 SHALL 仍不回放。

#### Scenario: Completed final answer contains provider state
- **WHEN** 成功 assistant 同时有最终文字和有效原生状态
- **THEN** 恢复保持成功终态与保护边界，不因新块类型丢失完成证据
