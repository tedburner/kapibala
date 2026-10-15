# Spec Delta: MCP tool execution

## Purpose

定义模型可见 MCP 工具的稳定名称、有限目录、输入验证与逐调用权限，使远端声明能够进入统一 Harness 而不会通过自述只读、同名替换或审批缓存绕过宿主和活动技能的安全边界。

## ADDED Requirements

### Requirement: Stable collision safe names
系统 SHALL 使用保留 MCP 命名空间的模型工具名称，处理字符、长度和清洗碰撞，并使名称映射不依赖发现顺序；原始 Server/Tool 身份供诊断查询。

#### Scenario: Normalization collapses two names
- **WHEN** 两个原始名称清洗后相同或超过模型名称长度上限
- **THEN** 两者有稳定不同的模型名称，倒序发现不会交换映射

### Requirement: Bounded complete discovery and advertisement
系统 SHALL 有界遍历目录分页并检测重复 cursor，完整候选发布前验证；刷新失败保留旧目录并标陈旧，模型预算按完整工具条目省略且遗漏项不可执行。

#### Scenario: Pagination repeats a cursor
- **WHEN** Server 返回重复游标或超过分页上限
- **THEN** 新目录不部分发布，旧目录保持且出现明确诊断

#### Scenario: Catalog exceeds model declaration budget
- **WHEN** 已过滤目录超出工具数量或完整请求预算
- **THEN** 系统按稳定顺序省略完整工具，报告遗漏并拒绝本 run 调用遗漏项

### Requirement: Change notifications suspend stale authority
系统 SHALL 为 Tools 独立维护 catalogEpoch 与 refreshToken（不与 Prompts 共用），每次变更通知立即递增 epoch、使旧刷新令牌失效并暂停该能力未发送调用。只有 client、connectionGeneration、能力类型、epoch、refreshToken 仍为当前且无后续 dirty 通知的完整候选才能原子发布；过期成功与失败都不得污染新状态。同一 generation、相同 toolDigest 的旧引用可经当前完整复核恢复资格，不要求当前 epoch 与 run 快照原始 epoch 永远相等。通知合并、补刷次数和总截止 SHALL 有界，持续变化时保持 stale/unavailable，不无限追逐通知或自动恢复。

#### Scenario: Announced refresh fails
- **WHEN** Server 通知工具变化但目录刷新失败或游标超限
- **THEN** 旧目录可诊断但不可执行，required 来源阻止新任务，不在超时后自动恢复

#### Scenario: Complete refresh confirms an unchanged tool
- **WHEN** 同连接完整目录复核证明某工具摘要完全未变且刷新令牌仍是最新
- **THEN** 该旧实例恢复本轮执行资格，新增项仍在下一 run 生效

#### Scenario: A stale refresh completes after a newer notification
- **WHEN** 刷新成功响应对应的 epoch 或 refreshToken 已过期
- **THEN** 该结果不得覆盖当前状态、发布候选或恢复任何执行资格

#### Scenario: A stale refresh failure follows a successful refresh
- **WHEN** 旧 refreshToken 的失败在新 token 已成功发布目录后到达
- **THEN** 当前 ready 状态与执行资格保持不变，不被旧失败改成 stale/unavailable

#### Scenario: Notifications continue throughout refresh
- **WHEN** Server 持续通知导致候选在完整复核前反复过期
- **THEN** 系统在补刷次数或原总截止耗尽后停止本轮刷新并保持 stale/unavailable，不无限发请求或恢复过期资格

#### Scenario: Final send check observes a catalog change
- **WHEN** 目录在审批、hook 或异步审计后、底层 transport 发送前发生变化或断连
- **THEN** 同步临界区复核立即阻断出队，调用以工具变化或服务不可用失败闭合，发送次数严格为零，复核与底层出队之间不发生事件循环让步，不切换到同名新实例

### Requirement: Final arguments are validated before dispatch
系统 SHALL 在发现时校验远端 Schema，并通过 Core 通用可选 `Tool.validateInput?(input)` 在最后一个可改参 hook 之后、权限审批前校验最终调用参数；该方法无副作用、不改参、不访问远端。系统 SHALL 拒绝不支持约束、远端引用和非对象输入，不修改或静默删除参数；校验拒绝或异常均不产生审批或远端调用，最终参数快照由校验、权限、审批缓存、身份计算和发送共享。

#### Scenario: A hook changes arguments to an invalid value
- **WHEN** 准备钩子将参数修改为不符合已绑定 Schema 的对象
- **THEN** 参数错误作为工具结果闭合，审批次数和发送次数均为零

#### Scenario: Validation and dispatch use one final snapshot
- **WHEN** 参数通过校验后，权限或 transport 阶段试图使用另一份参数
- **THEN** 系统拒绝该调用或使用同一最终参数快照，不允许静默改参后发送

### Requirement: Server hints cannot grant privileges
系统 SHALL 新增通用 Capability `external:call` 并将其纳入 Core `CAPABILITIES` 集合与类型以支持规则合法校验；外部调用默认 dangerous=true，Plan 拒绝外部调用；annotations 不自动授权本地只读，硬拒绝、deny 及 Skill 白名单优先于缓存和模式。

#### Scenario: Tool claims readOnlyHint in Auto mode
- **WHEN** 远端声明 readOnlyHint=true 但宿主没有显式允许
- **THEN** 调用仍需要审批，不能凭该 hint 自动获得受沙箱保护的只读资格

#### Scenario: FullAccess conflicts with a Skill hard limit
- **WHEN** FullAccess 当前会话中活动 Skill 不允许该 MCP 工具
- **THEN** 远端调用被拒绝，不能以模式或用户缓存放行

### Requirement: Approval binds final identity and arguments
系统 SHALL 将批准绑定到配置目标、连接代次、本次裁决捕获的当前能力目录 epoch、工具定义和最终参数，`SessionApprovalCache.key()` SHALL 将 `ApprovalRequest.executionIdentity`（包含目标、generation、epoch、toolDigest）深度纳入哈希计算，发送前复核；重连、目录变化或目标变化使旧批准失效，不跨连接或 epoch 复用旧允许缓存。审批中 epoch 变化后即使当前完整复核证明摘要未变，本次旧调用仍须零发送闭合；恢复资格的旧引用可在新调用中按当前 epoch 重新审批并执行。

#### Scenario: Definition changes while approval is pending
- **WHEN** 用户确认前后工具 Schema、目录 epoch 或连接身份变化
- **THEN** 系统报告工具变化且不发送旧批准调用

#### Scenario: Unchanged refresh cannot revive a pending approval
- **WHEN** 审批期间收到通知，当前完整复核随后确认同 generation、同 digest
- **THEN** 本次旧调用发送次数为零；后续新调用可使用恢复的旧引用，绑定当前 epoch 并重新审批，不因快照原始 epoch 较旧而永久拒绝

#### Scenario: Session approval is reused after reconnect
- **WHEN** 同名工具以新连接代次接入并收到相同参数调用
- **THEN** 因 executionIdentity 变化导致缓存键哈希不匹配，旧 allow_session 不命中，新调用按当前策略重新裁决
