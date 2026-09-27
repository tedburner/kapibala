# Context Observability

## Purpose

为 CLI 和其它宿主提供真实、可追踪的会话恢复、压缩和预算语义事件，使用户能理解正在续答哪个会话、摘要覆盖哪些消息以及 Token 消耗的来源，并确保取消或重启不会产生虚假完成统计。

## ADDED Requirements

### Requirement: Host independent session and context events
Core SHALL 输出恢复、切换、压缩开始/完成/失败与预算超限的语义事件，不含 ANSI 或终端组件。事件 SHALL 关联持久会话及运行身份，检查点完成包含覆盖范围、前后 Token 估算来源、模型、时间、耗时和 persistence。

压缩事件 SHALL 区分剪裁/摘要及自动阈值/手动/溢出原因，仅在相应阶段持久提交并激活后报告完成；剪裁数量与估算缩减 SHALL 不计作成功摘要次数。CLI SHALL 展示有效剪裁及自动摘要熔断状态，实际缓存 usage 缺失时保持未知，不以固定锚点推断命中。

#### Scenario: SDK observes compaction
- **WHEN** SDK 消费压缩事件
- **THEN** 获得可展示的真实语义信息且不需要解析 CLI 文本

#### Scenario: Pruning succeeds but summary fails
- **WHEN** 剪裁已经提交且后续摘要失败
- **THEN** 系统分别报告阶段结果，保留已提交剪裁，摘要成功次数不增加且实际摘要消耗仍计入

### Requirement: Accurate accounting and restore status
成功次数 SHALL 仅在检查点激活后增加；摘要 usage SHALL 单独归属并计入总消耗，不混入主任务 TTFT 或工具步骤。恢复 SHALL 重建已有真实统计，旧记录缺失 usage SHALL 标记未知而非假称精确为零。CLI SHALL 展示当前会话 ID/标题及恢复记录的有界预览。

#### Scenario: Summary costs tokens but fails
- **WHEN** 摘要已消耗 Token 但最终未提交
- **THEN** 消耗被计入摘要统计，成功压缩次数保持不变

#### Scenario: Resume legacy messages
- **WHEN** 恢复没有 usage 信息的旧历史
- **THEN** 系统可以显示消息数量，但将历史 Token 消耗标明未知

### Requirement: Separate status overview and context budget detail
CLI `/status` SHALL 展示当前会话、模型、权限、主任务/摘要 Token 与工具/检查点概况；`/context` SHALL 展示窗口及来源、输出预留、安全余量、输入预算/阈值/目标、输入占用分类、保护范围和有效检查点。在 TTY 交互终端中，`/context` SHALL 以字符比例图（Visualized Gauge，如多色彩占比条）直观呈现系统指令、工具定义、活动摘要、保留轮次和剩余可用 Headroom 的构成；非 TTY 模式输出等价纯文本且不包含 ANSI。两者 SHALL 区分估算、实际 usage、未知和过期快照，关联展示对应模型/请求版本；查询 SHALL 不执行请求 Hook、调用 Provider 或改变历史。

#### Scenario: Inspect context with visual gauge in TTY
- **WHEN** 用户在 TTY 终端执行 `/context`
- **THEN** 系统输出包含字符比例条的水位图与各部分 Token 占用的分类明细

#### Scenario: Inspect context before the next request
- **WHEN** 用户切换模型后执行 `/context`，下一请求的动态 Hook 尚未执行
- **THEN** 系统标明已有快照的版本/过期情况及估算来源，不声称它是下一请求的精确占用

#### Scenario: Read status in a pipe
- **WHEN** 非 TTY 查看 `/status` 或 `/context`
- **THEN** 系统输出同一数据来源的纯文本，不调用模型或更改消息

### Requirement: Cancellation waits for cleanup
消费者提前结束事件迭代或用户取消时，系统 SHALL 中止并等待摘要/工具清理与必要存储收口，再释放执行/写入权；已提交检查点 SHALL 保留，未提交候选 SHALL 不计为成功。

#### Scenario: Stop after compaction start
- **WHEN** 消费者收到 compaction_start 后结束迭代
- **THEN** 系统取消并等待摘要终止，未提交摘要不会替换活动上下文

#### Scenario: Stop after durable commit
- **WHEN** 检查点已经提交但消费者尚未收到完成事件时结束迭代
- **THEN** 恢复后仍识别已提交检查点，不重复计数或丢失状态
