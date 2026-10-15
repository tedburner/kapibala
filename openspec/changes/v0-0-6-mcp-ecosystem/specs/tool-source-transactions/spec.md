# Spec Delta: Tool source transactions

## Purpose

定义动态工具来源的原子更新、稳定运行视图与撤销规则，使模型声明、审批目标和实际执行保持一致，避免来源冲突或异步目录刷新产生半注册状态及同名替代执行。

## ADDED Requirements

### Requirement: Atomic source replacement
系统 SHALL 将同一来源的候选工具集在提交前同时预检查候选批内自身重名与跨来源名称冲突，任一冲突均全部拒绝并保持原注册表完全不变；注销只移除该来源拥有的条目。

#### Scenario: Conflict leaves the previous catalog intact
- **WHEN** 候选集合最后一个名称与其他来源冲突
- **THEN** 当前来源原工具全部保留，候选中前面的工具也不得部分可见

#### Scenario: Batch contains duplicate names within itself
- **WHEN** 同一来源的候选工具集自身包含两个同名工具
- **THEN** 系统在预检阶段拒绝提交并报错，原注册表保持完全不变，不发生同名静默覆盖或注销后遗留丢项

#### Scenario: Removing one source preserves other sources
- **WHEN** 宿主注销一个动态来源
- **THEN** 该来源条目消失，其他来源与内置工具保持原身份

### Requirement: Stable request and execution snapshot
系统 SHALL 将本次任务的动态工具声明与执行实例绑定到同一不可变视图；在任务运行锁生效、执行准备（`runPreparedTask` 的 prepare 阶段）开始时捕获不可变运行视图（`ToolRegistrySnapshot`），从准备阶段到整个 run 的所有 turn 循环均通过该快照生成模型可见目录与解析执行实例；同一 run 的 MCP 工具续答声明在所有步骤间严格保持稳定，全局注册表在运行期间新增或变更的定义只能从下一 run 可见。

#### Scenario: Refresh during native continuation
- **WHEN** 已开始原生协议工具续答且远端公布新增工具
- **THEN** 本 run 后续请求保持原 MCP 声明，下一 run 才能看到新增项

#### Scenario: Turn loop does not read mutating global registry
- **WHEN** 任务在多 step 推进过程中，后台连接完成目录刷新并提交至全局注册表
- **THEN** 当前 run 后续各 step 仍使用初始快照视图，工具声明列表与 Schema 不发生漂移

#### Scenario: A model hook invents an executable name
- **WHEN** 请求钩子加入没有对应运行视图执行实例的工具名称
- **THEN** 系统在发送模型请求前拒绝不一致请求，不按运行期同名查找补齐

### Requirement: Immediate revocation without substitution
系统 SHALL 立即撤销断连、移除或身份变化的旧工具执行资格，保留本轮协议声明但不得把旧调用转发给同名新实例；已发送调用继续记录真实结果或未知事实。

#### Scenario: Server reconnects after the model request
- **WHEN** 模型按旧目录生成调用而同名 Server 已建立新连接
- **THEN** 未发送旧调用返回身份变化或不可用结果，不能转发给新连接

#### Scenario: Revocation follows a completed remote response
- **WHEN** 调用已收到真实成功响应后其来源被撤销
- **THEN** 系统保存真实成功，不将其改写为未执行或取消

### Requirement: Revalidation restores references but not old approvals
系统 SHALL 区分 run 不可变定义快照与当前执行资格；同一连接代次、相同工具摘要的旧引用在当前完整目录复核后可恢复资格，不要求当前 epoch 永远等于快照创建时 epoch。每次调用 SHALL 绑定其开始裁决时的当前 epoch；审批期间 epoch 变化使该次未发送调用失效，即使随后复核确认摘要相同也不得复活该次批准。

#### Scenario: An unchanged reference receives a new approval
- **WHEN** 旧引用在较新 epoch 完整复核后恢复资格且发生一次新调用
- **THEN** 新调用使用当前 epoch 重新校验与审批，可执行原引用而不改写本 run 声明或转调新实例

#### Scenario: A pending approval spans a refresh
- **WHEN** 审批等待期间 epoch 变化后又完整复核为相同摘要
- **THEN** 本次旧调用零发送闭合；后续新调用才可在当前 epoch 重新裁决

### Requirement: Optional validation shares final immutable arguments
Core SHALL 提供通用可选 `Tool.validateInput?(input)`，在最后一个可改参 hook 之后、权限及人工审批之前调用；校验无副作用、不改参、不访问远端。校验、权限、审批缓存、执行身份与发送 SHALL 共享同一最终参数快照，校验拒绝或异常均闭合为错误结果而不触发审批或发送。

#### Scenario: Optional validation throws
- **WHEN** 工具的 validateInput 对最终参数抛出异常
- **THEN** 系统生成校验错误结果且审批次数、远端发送次数均为零，不按未实现校验器放行

#### Scenario: Validation attempts to mutate arguments
- **WHEN** 校验器或后续执行阶段尝试改变已确定的参数
- **THEN** 系统阻止修改或拒绝该调用，不发送与已校验及批准快照不同的参数

### Requirement: Backward compatible ordinary tools
系统 SHALL 保持缺少新可选校验/身份/结果契约的既有工具行为；动态工具机制不得绕过 Skill 硬限制或改写受保护的原生协议前缀。

#### Scenario: Ordinary output contains a business isError property
- **WHEN** 既有工具返回含 isError 字段的普通业务对象而没有显式选择结果适配
- **THEN** 系统仍按既有对象输出语义处理，不自动判为工具执行失败

#### Scenario: Skill narrows an otherwise available external tool
- **WHEN** 动态工具在运行视图可用但活动 Skill 白名单排除了它
- **THEN** 执行被硬拒绝，快照、审批缓存或 FullAccess 不能绕过
