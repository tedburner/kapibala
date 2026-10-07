# CLI Model Role Extensions

## Purpose

在已有统一命令和输入协调契约上，为模型角色提供可发现的绑定、选择和单次问答入口；明确当前角色、密钥、恢复以及默认模型命令的关系，让用户能看清实际使用的模型且错误输入不会进入模型历史。

## ADDED Requirements

### Requirement: Explicit model role commands
CLI SHALL 支持 /model <role> <id> 管理 planning、execution、fast、summary 绑定，/model route <role> 选择 default/planning/execution/fast 主任务角色，单次 --role 使用相同取值规则。帮助 SHALL 与实际参数和空闲约束一致，非法参数 SHALL 不调用模型或变更历史。

#### Scenario: Invalid role is entered
- **WHEN** 用户输入不支持的 route 或 --role 值
- **THEN** 报用法错误，不开始任务或创建替代绑定

### Requirement: Direct model choice returns to default role
普通 /model <id> SHALL 更新当前 default 绑定并选择 default 角色；/settings default <id> SHALL 仍只更新下次默认启动模型，不隐式热切换。当前角色 SHALL 在状态中与实际模型同时展示。

#### Scenario: User chooses a model while planning is selected
- **WHEN** 空闲时执行 /model <id>
- **THEN** 当前角色变为 default，下一任务请求明确选择的模型

### Requirement: Current role credentials refresh consistently
/model key 未指定 ID SHALL 使用当前任务角色的 Profile；同组密钥更新成功后 SHALL 刷新相关角色绑定，不使用旧密钥。持久化失败 SHALL 不假称更新成功，非 TTY SHALL 不等待秘密输入。

#### Scenario: Planning shares credentials with another model
- **WHEN** 用户更新当前 planning Profile 的密钥
- **THEN** 同组绑定后续请求使用新密钥，配置仍只保留一份组内密钥

### Requirement: Role lifetime is explicit
CLI 新进程 SHALL 默认选择 default，除非提供合法 --role。CLI 内恢复/切换历史 SHALL 保留当前明确角色，旧历史 SHALL 不恢复其旧角色或授权。SDK 每 run 的显式 role SHALL 使用同样模型选择规则。

#### Scenario: Resume a conversation from a new process
- **WHEN** 用户未传 --role 启动恢复旧 planning 会话
- **THEN** 采用当前 default 模型，恢复普通历史而不恢复旧 planning 选择或审批
