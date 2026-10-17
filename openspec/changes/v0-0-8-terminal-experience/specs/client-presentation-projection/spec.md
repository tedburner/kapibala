# Client Presentation Projection

## Purpose

提供终端与未来图形客户端可共用的展示文档与状态转换契约，使实时公开内容、完成消息、历史恢复和用户折叠选择一致，并避免将协议私有状态或终端布局耦合进共享展示逻辑。

## ADDED Requirements

### Requirement: Framework independent presentation entry
CLI 包 SHALL 导出可在浏览器构建的独立展示子路径及类型声明。该入口 MUST 不依赖 Node、React、DOM、ANSI 或 Core 运行时，导入时不启动客户端、读取文件或注册进程监听。

#### Scenario: Browser import
- **WHEN** 浏览器目标项目导入独立展示入口
- **THEN** 仅得到纯展示类型与逻辑，不加载终端依赖、Core/MCP 或 CLI 启动代码

#### Scenario: Different renderers share semantic state
- **WHEN** 不同客户端向展示模型输入相同的公开展示事件与用户语义动作
- **THEN** 得到一致的文档与折叠/任务展示状态；列宽、终端行高、快捷键及 GUI 布局由各端适配，不进入共享状态

### Requirement: Public display data projection
展示数据 SHALL 只包含允许公开的正文、思考、受控工具详情、通知和指标，不携带签名、隐藏思考载荷或加密协议状态。投影 MUST NOT 修改 canonical 消息或改变模型历史。

#### Scenario: Restored private protocol state
- **WHEN** 历史消息包含公开思考及协议私有数据
- **THEN** 仅公开部分进入展示文档；私有状态不出现在序列化视图、展开详情或浏览器入口消费者中

### Requirement: Stable identity and stale update isolation
展示 SHALL 按会话、分支和视图代次隔离增量，块身份在流式完成对齐时保持可追踪。旧代次的迟到事件和异步命令结果 MUST NOT 更新当前视图；正文相同不能作为合并不同块的依据。

#### Scenario: Late event after branch reload
- **WHEN** 切换分支后旧视图的延迟事件到达
- **THEN** 当前文档不变，旧事件不改写新分支或输入状态

#### Scenario: Duplicate text in separate messages
- **WHEN** 两条不同消息正文相同
- **THEN** 它们仍具有独立展示身份、顺序和折叠选择

### Requirement: Stream and canonical content reconcile once
实时增量 SHALL 在暂存内容上展示，完成事件 SHALL 与 canonical 内容对齐而非重复追加。工具按调用身份对齐，完成顺序可与开始顺序不同。

#### Scenario: Completed assistant replaces provisional content
- **WHEN** 文本增量展示后收到完整 assistant 消息
- **THEN** 正文只出现一次，并保留能够映射的用户折叠选择

#### Scenario: Parallel tools finish in reverse order
- **WHEN** 两个工具逆序完成并产生 canonical 结果
- **THEN** 每项调用准确对应自身结果、耗时和错误状态，没有串用或重复块

#### Scenario: Batched deltas meet completion
- **WHEN** 尚有待发布增量时收到完成、错误或视图切换事件
- **THEN** 按原事件顺序处理边界，旧 delta 不在终态或新视图之后补入

### Requirement: Original branch history is authoritative
恢复和切换 SHALL 使用当前分支的原始合法历史重建文档，不以模型压缩投影代替用户历史，不重放工具。未持久化的中断片段 SHALL 明确表示为临时内容，重启后不伪造恢复。

#### Scenario: Compacted historical session
- **WHEN** 恢复曾压缩模型上下文的会话
- **THEN** 用户历史仍来自原始消息，而非只有摘要；工具不重新执行

### Requirement: Thinking visibility honors user overrides
公开思考 SHALL 在生成时默认展开，块完成后默认折叠；用户的显式选择 SHALL 优先于默认规则。缺少结束事件的块 MUST 在运行收尾停止等待并标明完成或中断事实。

#### Scenario: Manually expanded completed block
- **WHEN** 用户展开已完成思考块，随后发生增量或其他状态刷新
- **THEN** 该块保持用户选择，不被默认折叠策略反复关闭

#### Scenario: Interrupted thinking lacks stop
- **WHEN** 流中断且思考块没有结束事件
- **THEN** 展示停止旋转等待并标为中断，不合成模型未提供的内容或 canonical 历史

### Requirement: Execution result and settlement are distinct display facts
展示 SHALL 分别保存运行结果和 running/cancelling/settling/idle 阶段。收到结果不得自动解除忙碌状态；宿主确认实际清理完成后才恢复 idle。

#### Scenario: Result followed by persistence error
- **WHEN** 已展示完成结果后清理或落盘失败
- **THEN** 最终展示包含失败诊断，不保留全部成功保存的承诺
