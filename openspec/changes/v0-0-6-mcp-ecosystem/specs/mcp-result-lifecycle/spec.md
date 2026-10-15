# Spec Delta: MCP result lifecycle

## Purpose

定义 MCP 业务响应、协议异常、宿主转换失败和未知执行结果的可恢复表示，确保文本及结构化内容有界、敏感元数据不泄漏，并在取消或持久化失败时保持每个已记录工具调用的事务闭合。

## ADDED Requirements

### Requirement: Versioned execution facts remain separate from host errors
canonical 工具结果 SHALL 支持可选 `execution: { version: 1, dispatchOutcome: 'not_sent' | 'succeeded' | 'failed' | 'unknown', hostError?: { phase: 'validation' | 'projection' | 'hook' | 'audit', code: string } }`。适配器 SHALL 按发送证据及有效远端响应先记录 dispatchOutcome，Executor 再附加宿主错误，不得由后续转换、hook 或审计改写远端事实。发送前失败为 not_sent，有效成功为 succeeded，有效业务失败为 failed，可能已发送但缺乏可靠最终响应才为 unknown。该可选 v1 字段 SHALL 同步序列化、validators、历史恢复、审计及 Provider 投影边界；旧结果无此字段仍可读，不推断不存在的发送事实，模型仅消费安全有限的结果内容。

#### Scenario: Old history has no execution metadata
- **WHEN** 恢复旧 JSONL 工具结果且未保存 execution
- **THEN** 原结果继续可读，不要求迁移补字段或伪造远端发送状态

#### Scenario: A local hook fails after a valid failure response
- **WHEN** 适配器已记录有效业务失败，随后结果 hook 抛错
- **THEN** 保留 dispatchOutcome=failed 并附加 hostError.phase=hook，不改成 unknown、succeeded 或 not_sent

### Requirement: Preserve business result semantics
系统 SHALL 将有效文本与结构化结果转换为 canonical 输出，将远端 isError=true 记为业务失败；宿主转换失败与远端业务失败/未知结果必须可区分。远端 failed 仅表示有效失败响应，不保证没有副作用或已经回滚。

#### Scenario: Server reports a business failure
- **WHEN** Server 返回有效 isError=true 及可操作错误文本
- **THEN** 结果标 isError 并保留安全反馈，不能显示为成功或只保存对象字符串

#### Scenario: Known success cannot be projected
- **WHEN** 已收到成功业务响应但宿主输出校验/转换失败
- **THEN** 保留 execution.dispatchOutcome=succeeded，附加 hostError.phase=projection 及安全错误码，按 after_user_action 暂停而不自动重放；不宣称远端失败或 OUTCOME_UNKNOWN

### Requirement: Bounded safe content
系统 SHALL 在传输/解码阶段限制协议输入，并有界转换保存内容；截断显式标记，JSON 不破碎，二进制与私有元数据不透传，不自动下载 Resource Link。

#### Scenario: Text exceeds the retained output budget
- **WHEN** 有效文本结果超过模型/历史保留预算
- **THEN** 保留首尾及省略标记，不宣称完整原文已另存可读取

#### Scenario: Response contains base64 media and private metadata
- **WHEN** Server 返回图片/音频 Base64、私有 _meta 与资源链接
- **THEN** 历史不含媒体Base64或私有值，返回省略说明/链接描述且不发起下载

### Requirement: Sent calls are never automatically replayed
应用、SDK 和 transport SHALL 均不自动重发任何已经发送的 tools/call，不因 legacy 模式的 session-expired / 404 session missing、modern 模式的 401 鉴权挑战 / 400 协议不匹配，或断流、超时、取消而隐式重放；连接重建或响应流续接不得成为第二次业务调用。已发送且无可靠最终响应时记录 execution.dispatchOutcome=unknown、OUTCOME_UNKNOWN/after_user_action；有效响应之后的本地错误不得改成 unknown。只有幂等目录查询可在原截止时间内有限重试（最多两次额外尝试）；重连、模型续答和历史恢复也不得重放旧调用。

#### Scenario: Connection drops after request dispatch
- **WHEN** 调用已发送且在最终响应前断连
- **THEN** 结果标 OUTCOME_UNKNOWN/after_user_action，系统不会重连后自动调用第二次

#### Scenario: SDK handles failure per protocol era without replay
- **WHEN** 已发送 tools/call 后出现故障恢复尝试（legacy 下的 session-expired/404，或 modern 下的 401/400）
- **THEN** 受控 Server 对两时代的每种故障均观测该业务请求发送计数不超过一次；不能因 SDK 自动重试而再次执行，不能证明时停止依赖实现

#### Scenario: An idempotent catalog query is retried
- **WHEN** 目录查询遇到可重试瞬态错误
- **THEN** 至多两次额外尝试且不延长原截止；同一重试机制不得用于 tools/call

#### Scenario: Resume contains an incomplete historical transaction
- **WHEN** 恢复历史发现旧调用缺失最终结果
- **THEN** 沿用缺失结果恢复规则记录未知，不向任何新旧 Server 重放

### Requirement: Cleanup precedes lock release and transaction closure
系统 SHALL 在取消或消费者提前结束时等待有界本地请求收口并闭合全部已记录工具结果后释放 Session 锁；已完成调用保留真实结果。

#### Scenario: Consumer stops iteration during a tool batch
- **WHEN** 事件消费者在批次执行期间 return
- **THEN** 已完成结果保留，其他调用取消/拒绝并落盘闭合，清理期间新任务被 busy 拒绝

### Requirement: Audit failure cannot authorize unsent work
系统 SHALL 在启动/发送前完成必要审计，审计失败拒绝尚未开始操作；已执行结果不能因审计故障伪装成未执行，消息持久化失败停止后续工具发送。

#### Scenario: Pre-dispatch audit is unavailable
- **WHEN** 调用开始前审计存储失败
- **THEN** 发送次数为零并返回审计不可用，不能绕过门禁继续

#### Scenario: Tool message append fails after a real response
- **WHEN** 远端结果已知但工具消息追加失败
- **THEN** 系统停止后续发送及本轮推进，在进程内保留真实结果和已知 execution 事实并报告持久化失败，不重放完成操作；不得承诺未成功落盘的结果在重启后仍可知

#### Scenario: Restart follows an unpersisted known response
- **WHEN** 进程重启后持久历史仍只有 tool_use、缺少此前未成功追加的真实 tool_result
- **THEN** 按缺失结果恢复规则记录 unknown/OUTCOME_UNKNOWN，不假装恢复进程内已丢失的成功事实，也不重放调用
