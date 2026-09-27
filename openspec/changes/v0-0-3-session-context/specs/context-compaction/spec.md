# Context Compaction

## Purpose

为长会话提供最终请求预算与可恢复滚动摘要，使模型仅接收有效检查点和必要近期历史，同时完整保留原始记录与当前任务边界，并在摘要、存储或预算失败时明确处理而不静默丢失任务上下文。

## ADDED Requirements

### Requirement: Final request budgeting
系统 SHALL 在请求改写完成后计入系统指令、工具定义、摘要、历史和动态内容，预留实际输出预算及安全余量。预算来源与估算 SHALL 可辨认，未知模型 SHALL 不将展示用 1M 回退视为可信控制上限；模型和上下文变更 SHALL 使过期 usage 基线失效。

#### Scenario: Hook adds large content
- **WHEN** 请求 Hook 增加大量上下文
- **THEN** 新内容参与最终预算，不能绕过超限处理

#### Scenario: Model switches to a smaller window
- **WHEN** 用户恢复会话后切换到窗口更小的模型
- **THEN** 下一请求按新窗口重新计算预算，不复用旧窗口占用判断

### Requirement: Protected complete interactions
系统 SHALL 保留当前交互、最近一次成功完成的完整用户交互及其后的失败/中断交互。压缩切分 SHALL 仅发生在完整旧交互前缀边界，工具事务不能拆分；没有成功完成交互时 SHALL 保守保护当前历史。受保护内容超预算 SHALL 明确停止且不删除消息。

保护范围外的旧失败/中断交互，在具有运行终态来源且工具事务已闭合时 SHALL 可参与二级摘要，不将失败终态改为成功。缺少终态来源或工具结果的旧交互 SHALL 不凭空视作可压缩完整轮次。一级结果剪裁 SHALL 仍仅用于成功完成旧交互。

#### Scenario: 已闭合失败轮次之后已有成功交互
- **WHEN** 旧失败轮次包含 OUTCOME_UNKNOWN 结果，其后已有成功完整交互且旧轮次位于保护范围之外
- **THEN** 二级摘要可以覆盖旧失败轮次，保留未知副作用和真实文件状态，恢复保持相同投影，不重放未知写入

#### Scenario: Single long task exceeds budget
- **WHEN** 当前任务与必保留交互本身超出可用输入预算
- **THEN** 系统报告预算不足，不通过切掉当前任务或工具结果继续执行

### Requirement: Manual compaction uses the same protection rules
CLI SHALL 提供无参数 `/compact`，仅在当前会话执行、审批、摘要、切换和清理空闲时触发。手动压缩 SHALL 与自动压缩遵守相同完整交互保护、输入/调用/耗时边界、来源验证及检查点提交规则；可在低于自动阈值时显式尝试或重试此前失败版本，但 SHALL 不新增主任务消息或执行工具。无可压缩完整前缀时 SHALL 提示且不调用模型；失败 SHALL 保留旧投影和原始历史。

#### Scenario: Manually compact below the automatic threshold
- **WHEN** 会话空闲且存在可摘要的旧完整交互，用户执行 `/compact`
- **THEN** 系统允许有界摘要，成功后提交检查点且保留受保护轮次，摘要消耗独立计入统计

#### Scenario: No eligible prefix
- **WHEN** 全部历史属于受保护范围，用户执行 `/compact`
- **THEN** 系统提示无可压缩内容，不调用摘要模型或删除消息

#### Scenario: Manual compaction fails
- **WHEN** 手动摘要校验或检查点写入失败
- **THEN** 系统报告失败，旧投影仍有效，不新增主任务或重放工具

### Requirement: Lightweight tool result pruning (Micro-compaction)
自动输入达到触发阈值时，系统 SHALL 优先尝试剪裁保护范围外、已完成旧交互中的成功工具结果；首版仅允许内置 read_file、glob、grep，写入/命令/失败/未知/未声明语义的插件结果 SHALL 不剪裁。剪裁 SHALL 仅修改请求投影，保留调用集合、结果 ID、状态、意图与来源，原始正文不变；无额外模型调用但不承诺零延迟或缓存命中。候选 SHALL 实际缩减且不超硬预算，经来源校验与持久提交后才激活；低于触发阈值时 SHALL 跳过自动摘要。

#### Scenario: Tool output dominates context
- **WHEN** 历史中包含数千行文件读取或命令输出且超出预算阈值
- **THEN** 系统先将受保护范围外的旧工具结果替换为占位符，成功缩减后直接继续执行，无需调用摘要模型

#### Scenario: Protected or failed tool result
- **WHEN** 当前任务结果、失败结果、结果未知或白名单外工具输出占用大量输入
- **THEN** 系统不剪裁这些结果，不能靠剪掉保护内容继续执行

### Requirement: Recoverable pruning state
受管会话 SHALL 持久记录剪裁目标身份、来源校验、策略版本及其与摘要检查点的关系；恢复 SHALL 只应用有效且未被摘要覆盖的剪裁，使用相同来源/配置/策略时重建相同投影。来源或策略无效 SHALL 诊断并退回可验证状态或原始结果再预算；reset SHALL 同时废弃旧剪裁和摘要。新增摘要 SHALL 从新增前缀的原始结果取材，不能把占位符作为完整事实。每一级提交 SHALL 独立，后续摘要失败不得回滚此前已提交剪裁。

#### Scenario: Resume after pruning without a summary
- **WHEN** 只提交了有效剪裁且未生成摘要后重启
- **THEN** 相同配置下恢复相同投影，原始工具结果仍完整存在，不重放工具

#### Scenario: Summarize previously pruned results
- **WHEN** 已剪裁的旧交互随后进入摘要覆盖范围
- **THEN** 摘要输入来自原始结果，新摘要生效后该范围旧剪裁不再重复应用

#### Scenario: Pruning storage fails
- **WHEN** 剪裁候选未能持久提交
- **THEN** 系统报告存储失败且不激活候选，不以未落盘剪裁伪装恢复能力

### Requirement: Bounded summary generation with input truncation and tracking
摘要 SHALL 包含目标、约束、决策、已完成工作、待办、来源和未知副作用，使用 summary 角色或当前会话默认路由回退。单条超长工具输出 SHALL 保留默认总上限 2000 个 Unicode code point 的首尾片段，附省略长度、来源及有界状态；完整摘要请求仍 SHALL 独立预算，按完整交互分批，不能把单条截断视为总量保证。摘要 SHALL 无工具且不递归，单次触发包含分批/重试最多 4 次模型调用且总超时 120 秒；空/非法/来源错误/截断候选 SHALL 拒绝提交，中间摘要不激活。

#### Scenario: Tool output in summary input is truncated
- **WHEN** 某条历史工具结果包含 50,000 字符的日志输出进入待摘要前缀
- **THEN** 系统保留有界首尾片段和省略标记，重新检查总预算；仍无法容纳时分批或明确失败，不保证请求必然完成

### Requirement: Observed file operations with truthful outcomes
文件详情 SHALL 从原始工具调用与真实结果确定性提取并附来源及规范化路径，区分成功读取/修改、失败与结果未知，滚动摘要 SHALL 合并旧有效文件详情。系统 SHALL 不只凭模型文本或调用意图宣称修改完成，不猜测命令/插件未提供的文件事实，不将历史文件列表当成当前磁盘状态；详情及渲染 SHALL 有界并参与预算。

#### Scenario: File edit fails or is interrupted
- **WHEN** 历史包含失败编辑及结果未知的写入调用
- **THEN** 文件详情区分失败/未知，不将其作为成功修改事实，摘要保留未知副作用

### Requirement: Summary model selection and batching
摘要 SHALL 使用 summary 角色或当前会话默认路由回退，按有界完整交互分批且不激活中间候选；单个不可拆分输入仍超摘要预算 SHALL 明确失败。

#### Scenario: Summary route missing
- **WHEN** 会话未绑定 summary 模型而需要压缩
- **THEN** 使用默认模型生成摘要并记录实际使用模型

#### Scenario: Summary input is too large
- **WHEN** 必须摘要的完整历史不能在一次摘要请求容纳
- **THEN** 仅按完整交互分批，在有界调用内未完成则失败，中间摘要不激活

### Requirement: Checkpoint commit and raw history retention
摘要检查点 SHALL 记录稳定身份、覆盖范围、来源验证、前一检查点关联与生成信息，只有候选校验及持久提交完成后才激活。压缩 SHALL 不删除原始消息。恢复 SHALL 验证检查点与保留尾部的一致性，并忽略未提交候选。

#### Scenario: Checkpoint storage fails
- **WHEN** 摘要已生成但检查点提交失败
- **THEN** 原历史和原活动投影保持有效，压缩成功次数不增加

#### Scenario: Resume a compacted session
- **WHEN** 用户恢复包含完整有效检查点的会话
- **THEN** 模型上下文由该检查点及必要尾部重建，原始历史仍可保留供后续浏览

### Requirement: Compaction circuit breaker and safe overflow handling
系统 SHALL 按一次自动摘要操作维护连续失败计数，分批/重试模型调用不各算一次；生成/校验/无进展失败增加一次，摘要成功提交清零，取消和无可压缩前缀不计失败。三次失败 SHALL 仅暂停自动摘要；相同失败 fingerprint SHALL 不每步重试。新输入允许未熔断时尝试但不清零，模型/预算/摘要策略配置实质变化 SHALL 开启新周期；失败状态 SHALL 可恢复，重启不得绕过保护。手动重试失败不解除熔断，成功提交才恢复。存储失败 SHALL 单独报告，不假称预算错误。摘要失败保留最近已提交投影，任务继续或停止 SHALL 由最终硬预算决定。仅明确上下文拒绝且无输出/工具副作用时允许最多一次压缩后重发，其它错误不触发，不重放工具。

#### Scenario: Circuit breaker trips after repeated failures
- **WHEN** 会话因不可拆分超大消息导致连续 3 次压缩均未产生有效缩减
- **THEN** 系统停止第 4 次自动摘要操作，仍按最终预算决定继续或停止，不把操作次数等同模型调用次数

#### Scenario: Breaker is open but the request fits
- **WHEN** 自动摘要已熔断而最近有效投影仍在硬预算内
- **THEN** 系统可以继续任务并提示熔断，不虚构预算超限错误

#### Scenario: Restart and manual retry
- **WHEN** 用户恢复已熔断会话后显式执行 /compact
- **THEN** 自动熔断仍存在，手动可有界重试，仅成功持久提交摘要后解除

#### Scenario: Repeated compaction failure without progress
- **WHEN** 同一历史版本的摘要生成失败后进入下一内部步骤
- **THEN** 系统不重复同一次无进展摘要，继续或停止由预算决定

#### Scenario: Unrelated HTTP error
- **WHEN** Provider 返回普通 400 或鉴权错误
- **THEN** 系统报告原错误，不据 HTTP 状态自动压缩重发

### Requirement: Stable prefix, summary anchor and KV cache affinity
未变化的系统提示词、工具声明及已确认摘要 SHALL 确定性序列化；摘要 SHALL 作为标明来源的用户背景片段固定放在近期保留交互之前，不升级为系统权限。精确时间 SHALL 移到后部，真实指令更新按原边界生效。系统 SHALL 仅保证未变前缀字节稳定，不宣称通用剪裁或固定锚点保证 Provider 缓存命中；实际缓存效果 SHALL 通过可用 usage 实测并区分未知。

#### Scenario: Repeated request without configuration change
- **WHEN** 同一会话的指令、工具和检查点未变
- **THEN** 未变化的稳定前缀与摘要锚点字节相同，新增内容追加在动态位置；是否真实命中由实际 usage 判定

#### Scenario: Summary mentions permission
- **WHEN** 摘要声称此前某操作获得批准
- **THEN** 执行仍按当前会话权限和审批门裁决，不从摘要恢复批准缓存

### Requirement: Honest store capability fallback
无存储的 SDK SHALL 明确标记内存摘要/剪裁状态；只有旧消息存储接口时 SHALL 禁用持久摘要和剪裁并诊断，不宣称恢复能力，不静默修改持久历史为摘要或占位符。

#### Scenario: Legacy custom store
- **WHEN** SDK Store 只能保存和加载消息
- **THEN** 系统诊断其能力边界且保持原有消息操作，不伪造恢复检查点
