# Terminal Input Coordination

## Purpose

定义终端客户端编辑、菜单、秘密输入和审批共享输入链的行为，以及用户按键与粘贴的完整性边界，防止输入串流、意外提交和后台输出破坏独占问答。

## ADDED Requirements

### Requirement: Modal focus and draft preservation
终端 SHALL 区分编辑、命令面板、消息浏览、菜单、普通问答、审批和秘密输入焦点。独占问答期间 MUST NOT 分派聊天或其他命令；结束后 SHALL 恢复原草稿，不混入问答答案。

#### Scenario: Modal cancellation
- **WHEN** 用户在菜单或审批中按 Esc、Ctrl+C 或触发 EOF
- **THEN** 当前问答安全取消，答案不进入聊天草稿，原草稿可恢复

#### Scenario: Detail shortcut during modal input
- **WHEN** 用户在秘密或审批输入期间按 Ctrl+O
- **THEN** 不展开过程、不回显秘密、不将控制字节放入下一输入流程

### Requirement: Complete key and paste handling
输入链 SHALL 将支持终端的完整组合键只分派一次，正确处理分片与独立 Escape。粘贴内容 MUST 作为编辑文本而非快捷键执行，缓冲 SHALL 有界且可取消。

#### Scenario: Fragmented key sequence
- **WHEN** 一个支持的 CSI-u 或功能键序列跨多个输入块到达
- **THEN** 被解释为同一次组合键，不提前关闭面板或插入残缺序列

#### Scenario: Bracketed multiline paste
- **WHEN** 用户粘贴含换行、Slash 命令文字或审批数字的内容
- **THEN** 内容进入当前编辑区域，不自动发送聊天、执行命令或批准工具

#### Scenario: Incomplete input on close
- **WHEN** 存在未完成转义或粘贴输入时关闭客户端
- **THEN** 释放缓冲和等待资源，不将残留输入转发到下一流程

### Requirement: Secret input isolation
秘密值 MUST 仅留在宿主短生命周期输入对象内，不进入共享状态、输入历史、日志、屏幕快照或后台通知；取消后不得继续保留为草稿。

#### Scenario: Key update while background tasks change
- **WHEN** 用户录入密钥时后台任务状态发生变化
- **THEN** 秘密不回显、不进入可重建展示状态，后台更新不改变秘密输入消费者

### Requirement: Approval preserves complete target and authority
审批 SHALL 显示可检查的完整执行目标并转义控制字符，返回既有批准/拒绝结果。界面 MUST NOT 修改执行参数或绕过 Core 权限规则，非交互、关闭和取消 SHALL 安全拒绝或取消。

#### Scenario: Long command approval
- **WHEN** 审批目标超过单屏高度或宽度
- **THEN** 用户能够滚动检查完整命令、解释器和工作目录，再明确选择审批结果

#### Scenario: Approval interruption
- **WHEN** 审批请求取消、会话关闭或输入不可用
- **THEN** 工具不因默认选择或残留输入被批准

### Requirement: Single rendering output path
交互会话期间的命令结果、运行诊断和后台通知 SHALL 经宿主输出通道交给终端渲染器。文本模式 SHALL 保留 stdout/stderr 区别，MUST NOT 用全局 console 劫持掩盖未迁移入口。

#### Scenario: Read-only command while streaming
- **WHEN** 模型流式输出中用户执行只读诊断命令
- **THEN** 结果以受管展示内容出现，不直接破坏消息视窗、输入框或在途事件消费

### Requirement: Keyboard navigation remains available without mouse
客户端 SHALL 提供键盘命令补全、历史滚动、过程块焦点及展开/收起。单个键按当前焦点消费一次，MUST NOT 同时提交输入与操作过程块。

#### Scenario: Process block activation
- **WHEN** 用户在消息浏览焦点选择过程块并按 Enter 或 Space
- **THEN** 切换该块展开状态，不发送新任务；Esc 返回编辑器

#### Scenario: Command completion
- **WHEN** 输入框中的命令面板处于激活状态并按 Tab
- **THEN** 补全当前候选，不同时跳转消息浏览焦点
