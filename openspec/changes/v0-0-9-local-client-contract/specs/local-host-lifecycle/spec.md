# ADDED Requirements

### Requirement: 资源与工作区隔离

宿主 MUST 按 native 物理工作区身份管理会话，并显式注入宿主级写租约；每会话 MUST 独立拥有配置、Provider、技能和 MCP 容器。

#### Scenario: 同会话被占用

- **WHEN** 直接 CLI 已持有目标 conversation 锁
- **THEN** 返回 SESSION_BUSY，不偷锁

#### Scenario: 缺信任或密钥

- **WHEN** create/open 缺少项目授权或有效模型配置
- **THEN** 结构化失败，不等待终端输入，不授予信任

#### Scenario: 关闭一会话

- **WHEN** 关闭 idle 会话而另一会话正在调用其独立 MCP
- **THEN** 释放目标容器，不影响另一会话

### Requirement: 控制与运行终态

每会话 MUST 仅一个控制者与一个活动运行，变更操作 MUST 校验 controlEpoch；取消确认 MUST NOT 当作清理完成。

#### Scenario: 观察者运行

- **WHEN** observe 连接提交 run/start
- **THEN** 返回 CONTROL_REQUIRED，不执行

#### Scenario: 控制者断线

- **WHEN** 有活动运行的控制连接关闭
- **THEN** 撤销审批并取消，清理完成前不授予新控制权

#### Scenario: 取消竞争

- **WHEN** 取消与工具自然完成同时发生
- **THEN** 保留真实完成结果，tool_use/result 闭合落盘后才发终态

### Requirement: 快照与重连

attach MUST 原子建立订阅并捕获水位，快照之后只发送更大 seq；快照 MUST 包含已完成历史、活动尾部、运行状态与待审批摘要，历史 MUST 以 canonical store 为真源。跨连接事件重放不在 v1 契约内。

#### Scenario: 订阅期间产出

- **WHEN** 捕获快照时有新事件
- **THEN** 客户端获得快照 N 与全部 seq>N 事件，无遗漏或重复正文

#### Scenario: 快照期间存在待审批

- **WHEN** 活动运行等待审批时观察者 attach
- **THEN** 快照包含脱敏待审批摘要，观察者不能代替控制者回复

#### Scenario: 游标过期或进程重启

- **WHEN** 快照游标过期、缺失或 serverInstanceId 不符
- **THEN** 返回 RESYNC_REQUIRED，重新 attach 获取完整快照，不重发写任务

#### Scenario: 幂等运行

- **WHEN** 同实例同 session 重复 clientOperationId
- **THEN** 相同参数返回原接收结果；不同参数拒绝

