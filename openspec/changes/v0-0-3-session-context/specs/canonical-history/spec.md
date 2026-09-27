# Canonical History

## Purpose

为跨运行恢复、上下文压缩和未来多协议接入定义稳定消息身份、用户交互终态以及合法历史规范，使失败和中断不会被误当成完整答复，并确保工具调用与结果在所有发送和恢复路径中保持闭合。

## ADDED Requirements

### Requirement: Stable identities and separate lifecycle
消息 SHALL 具备跨加载稳定的 ID（推荐采用自带时序单调性的 UUIDv7）；底层持久化 Envelope SHALL 显式保留可选的 `parentId: string | null` 因果关联字段以向前兼容未来历史 DAG 与分叉；会话身份、运行实例、用户交互和内部模型步骤 SHALL 可区分。正文、完成/失败/中断状态和摘要覆盖关系 SHALL 分层表达；streaming draft SHALL 不作为已完成正文重放。

#### Scenario: Load a legacy history twice
- **WHEN** 同一旧记录经过两次加载或导入
- **THEN** 映射到相同消息身份且摘要覆盖引用不会漂移

#### Scenario: Partial assistant response
- **WHEN** 模型输出部分文本后失败或取消
- **THEN** 系统记录终态，不把部分文本当作已完成 assistant 答复发送给后续请求

### Requirement: Deterministic non destructive normalization
规范化 SHALL 保留原始记录、生成独立合法请求视图及来源映射，重复规范化 SHALL 结果一致。连续 user 与可合并的纯文本 assistant SHALL 在视图中保序组合，空 assistant SHALL 从请求省略；包含工具或不可兼容 block 的消息 SHALL 不盲目拼接。

#### Scenario: User continues after model failure
- **WHEN** 历史中前一 user 没有完成答复，随后用户输入新消息
- **THEN** 两条原始消息保留，合法请求视图按原顺序表达两次输入且来源可追踪

#### Scenario: Hook receives request history
- **WHEN** Hook 改写本次请求内容
- **THEN** 原始持久历史不被共享对象引用意外改写

### Requirement: Complete tool transaction integrity
assistant 的全部 tool_use 与紧邻对应 tool_result SHALL 作为不可拆分事务，结果 SHALL 只能满足本事务调用集合。缺失结果 SHALL 恢复为 OUTCOME_UNKNOWN/after_user_action；已完成真实结果 SHALL 保留，孤儿/重复/迟到结果 SHALL 从合法视图排除并记录诊断，重复调用 ID SHALL 明确失败。任何终止 SHALL 先完成工具清理与事务闭合。

真实结果保真 SHALL 适用于原始持久历史及恢复修复，受保护投影保留原文；只有符合 context-compaction 的旧成功结果允许在请求投影中剪裁，剪裁 SHALL 不移除或重排调用/结果事务，不把失败/未知变成成功。

#### Scenario: Interrupted multi tool transaction
- **WHEN** 一组工具有真实完成结果且另一些结果缺失
- **THEN** 已完成结果保持原值，缺失项标记结果未知，不自动重试副作用

#### Scenario: Duplicate and late output
- **WHEN** 已满足的工具结果重复出现或在下一 user 后到达
- **THEN** 它不能满足其它事务，也不进入合法模型历史

#### Scenario: Iterator ends early
- **WHEN** 消费者在工具进度事件后提前结束迭代
- **THEN** 系统先取消并等待清理、闭合并落盘事务，再释放会话执行和写入权

### Requirement: Recoverable interaction boundaries
系统 SHALL 持久保存用户交互开始与终态，以区分成功完成、失败和中断；内部工具步骤 SHALL 不被当作新用户交互。旧历史缺少成功证据时 SHALL 保守恢复，不伪造完成状态。恢复修复 SHALL 可幂等重放。

#### Scenario: Crash during interaction
- **WHEN** 存在交互开始记录而没有终态记录
- **THEN** 恢复标记其未完成并保留已完成消息和真实工具结果

#### Scenario: Reset and reload
- **WHEN** SDK 清空受管会话后重新加载该会话
- **THEN** 清空前上下文不会因旧检查点重放而复活
