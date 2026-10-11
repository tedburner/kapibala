# CLI Output Folding

## Purpose

为长工具任务提供紧凑但可检查的终端过程展示，使用户能切换当前轮次详情且保留回答、失败及审批的可见性，并在非交互环境取得完整公开过程，同时避免渲染或快捷键干扰会话清理和秘密输入。

## ADDED Requirements

### Requirement: Summary preserves actionable output
CLI 默认 SHALL 摘要展示思考状态、工具脱敏参数/状态/耗时及技能名称，完整流式显示全部回答文本。错误、取消、预算异常和审批 MUST 显式可见。折叠 MUST NOT 改变 Core 事件、模型请求、消息落盘或事务闭合。

#### Scenario: Intermediate answer before tool use
- **WHEN** 模型先输出文本再调用工具
- **THEN** 文本完整可见，不能因它不是最后一条 assistant 消息而被折叠

### Requirement: Bounded current-run details
CLI SHALL 保存按块/调用身份关联的当前轮次过程详情，默认最多 1 MiB UTF-8；超限 SHALL 标记缓存截断并保留摘要，原历史不受影响。切换 SHALL 展示已有缓存并影响后续渲染，不重执行工具或声称可删除任意终端滚动历史。

#### Scenario: Cache reaches limit
- **WHEN** 当前轮次工具输出超过 UI 缓存上限
- **THEN** 缓存有界并显示截断标记，Core 历史与模型内容保持原规则

### Requirement: Safe repaint fallback
只有可靠锚点及有界当前过程区域 SHALL 原地重绘；resize SHALL 重算宽度/行数。锚点因外部输出或审批失效时 MUST 追加有标签详情快照并重建，不覆盖答案、审批、提示符和上一轮内容。收起不得追溯删除已滚入历史的详情。

#### Scenario: Approval interrupts process view
- **WHEN** 用户审批输出打断当前过程区域
- **THEN** 不沿旧锚点擦写审批，后续展开采用安全追加或重新建立区域

### Requirement: One input owner
Ctrl+O SHALL 由同一输入协调器路由并在无菜单/密钥/审批独占的真实 TTY 生效，不新建 stdin/readline 消费者。秘密输入期间 MUST 不查看缓冲或切换视图；Ctrl+C/EOF SHALL 保留取消和等待回收语义。收尾 SHALL 幂等并解绑监听/timer。

#### Scenario: Toggle during secret entry
- **WHEN** 密钥输入期间按 Ctrl+O
- **THEN** 不读取或回显秘密，不触发详情重绘

### Requirement: Explicit non-TTY full details
CLI SHALL 为 REPL/one-shot 提供 --output-detail summary|detailed，默认 summary。非 TTY MUST 无 ANSI、光标回写和动态计时；detailed SHALL 输出完整协议公开思考、工具输入/结果及回答，不受 UI 缓存上限截断。所有模式继续脱敏/过滤控制序列；未提供思考或私密不透明状态不伪造/输出。

#### Scenario: Detailed output through pipe
- **WHEN** one-shot 输出重定向且选择 detailed
- **THEN** 全部公开过程按清楚边界输出，无 ANSI 或 1 MiB UI 缓存截断，debug 仍独立 stderr

#### Scenario: Invalid detail option
- **WHEN** --output-detail 使用不支持的值
- **THEN** 显示用法并在模型运行前退出
