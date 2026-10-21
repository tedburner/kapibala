# ADDED Requirements

### Requirement: 审批归属与参数绑定

服务端 MUST 保留原始 ApprovalRequest，只向控制端请求五选一决策，MUST 校验 approvalId/runId/controlEpoch 与 pending 状态。

#### Scenario: 过期或伪造回复

- **WHEN** 观察者、旧控制者或迟到回复尝试允许
- **THEN** 拒绝回复且不执行工具

#### Scenario: 修改参数

- **WHEN** 客户端回复附加新执行参数
- **THEN** 拒绝非法响应，不改变服务端实际执行参数

#### Scenario: 会话选择

- **WHEN** 控制端回复 allow_session 或 deny_session
- **THEN** 遵循现有缓存与 sessionAllowed 语义，不扩大权限

### Requirement: 撤销与展示

审批 MUST 默认 120 秒到期；断线、取消、关闭 MUST settle 为 cancel；脱敏展示不足以理解目标时 MUST 拒绝。

#### Scenario: 控制断开

- **WHEN** approval/request 尚未完成时控制端断开
- **THEN** Promise 收敛为 cancel，pending 与定时器被释放

#### Scenario: 秘密目标

- **WHEN** 展示脱敏后无法理解实际目标
- **THEN** 明确拒绝，不要求盲批

