# Scenario Model Routing

## Purpose

让用户和 SDK 宿主按任务用途显式选择预设模型，保持一次工具任务内模型和费用来源可预测；明确普通默认任务、摘要回退、缺配置和权限模式的边界，避免把模型角色名称误当成自动规划或工具授权。

## ADDED Requirements

### Requirement: Default tasks use the configured default model
未显式选择主任务角色 SHALL 使用 defaultModel 对应绑定，不要求场景配置。首次内置默认 SHALL 继续为 deepseek-flash；用户修改默认模型 SHALL 决定后续默认任务模型。

#### Scenario: No scenario mappings exist
- **WHEN** 用户普通启动并输入任务，没有 planning/execution/fast 配置
- **THEN** 全部主任务步骤使用当前 default 绑定，不增加分类请求

### Requirement: Explicit role is fixed for the entire run
用户/SDK 显式选择 planning、execution 或 fast 后 SHALL 在整个 run 固定该绑定；工具调用 SHALL 不自动切阶段。缺角色绑定或可用密钥 SHALL 请求前报错，不静默回退 default。

#### Scenario: Planning needs several reads
- **WHEN** planning 任务经过多次读取工具续答
- **THEN** 每个模型步骤仍使用 planning 模型

#### Scenario: Explicit fast role is unconfigured
- **WHEN** 用户选择 fast 而没有对应绑定
- **THEN** 报告缺配置且零模型请求

### Requirement: Model role does not grant permissions
角色 SHALL 只选择模型，不自动追加规划提示词、自动执行计划或修改授权模式。只读规划 SHALL 由独立 Plan 权限规则裁决，角色切换 SHALL 不继承或放大授权。

#### Scenario: Planning model requests a write
- **WHEN** planning 模型请求写操作且权限模式为 Plan
- **THEN** 现有只读规则拒绝操作，不因模型角色放行

### Requirement: Summary routing has independent fallback
summary SHALL 只服务摘要，未绑定时 SHALL 回退 default，按其实际模型和目的预算独立记账。主任务采用其它角色 SHALL 不隐式把摘要来源标为该角色。

#### Scenario: Planning runs with no summary binding
- **WHEN** planning 任务需要允许范围内的摘要且 summary 未绑定
- **THEN** 摘要使用 default 模型，主任务仍使用 planning

### Requirement: Metrics belong to the actual binding
每次主任务请求的预算、上下文窗口、usage、错误和日志 SHALL 取本次实际角色绑定；角色变化 SHALL 仅在空闲时生效，不能改动在途请求。

#### Scenario: Execution model has a smaller context window
- **WHEN** 用户空闲时从 planning 切到 execution
- **THEN** 下一 run 按 execution 窗口检查历史预算，状态和错误均显示 execution 实际模型
