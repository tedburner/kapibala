# Terminal Conversation Viewport

## Purpose

定义完整终端会话视窗的 Markdown、过程浏览、滚动跟随和资源控制，使长历史与流式生成可以同时使用，并确保性能优化不会删减回答、丢失事件或阻止用户检查历史详情。

## ADDED Requirements

### Requirement: Redrawable keyboard-operated conversation
终端 SHALL 在应用管理的视窗内显示正文、工具过程、输入和状态栏，支持流式 Markdown、键盘历史浏览与过程展开。窄屏和尺寸变化 SHALL 保持正文与必要输入可用。

#### Scenario: Streaming markdown
- **WHEN** 模型逐步生成正文、代码块或列表
- **THEN** 视图逐步呈现可读内容，完成后内容完整，不出现重复正文或泄漏控制序列

#### Scenario: Resize while inspecting process
- **WHEN** 用户展开工具详情后改变终端宽度
- **THEN** 布局重新计算，展开选择和浏览位置按稳定块身份保持

### Requirement: Explicit scroll following
用户向上浏览 SHALL 暂停自动跟随，新增内容以提示表示；回到底部后恢复跟随。历史滚动 MUST NOT 被后台任务或指标刷新强制重置。

#### Scenario: New output during history browsing
- **WHEN** 用户正在查看旧消息而新输出到达
- **THEN** 保持当前浏览锚点，显示新增内容提示而不自动跳到底部

### Requirement: Window covers actual visible lines
布局 SHALL 按换行后的实际可见行和可调整 overscan 建立窗口，不以固定消息节点数量截断可见内容。单个大消息 SHALL 按行片段展示，终端行高和布局 MUST 不进入跨端共享展示状态。

#### Scenario: Tall terminal contains more than thirty messages
- **WHEN** 高终端中同时可见的短消息超过三十条
- **THEN** 可见内容完整，活跃节点动态计算，资源压力优先减少 overscan

#### Scenario: One very large block
- **WHEN** 一条展开内容达到 1 MiB
- **THEN** 只排版/挂载必要行片段，滚动仍可检查内容，不因只有一个节点而一次渲染全文

### Requirement: Derived caches are bounded without losing source content
过程额外缓存 SHALL 以 1 MiB 为初始预算，布局缓存 SHALL 以 8 MiB 为初始预算；回收仅针对可重建派生对象。未载入详情 SHALL 明示，MUST NOT 删除 canonical、截断正文或将未完成块标为完成以满足预算。

#### Scenario: Cache eviction and revisit
- **WHEN** 不可见块的布局缓存被回收后用户再次浏览该块
- **THEN** 可从保留源重建，正文与折叠状态正确

#### Scenario: Detailed text redirection
- **WHEN** 使用 detailed 文本输出重定向超过交互缓存预算的公开过程
- **THEN** 流式输出完整，不受交互缓存回收影响

### Requirement: State ordering precedes coalesced painting
状态 SHALL 按事件顺序完整更新，订阅与绘制可合并且默认不超过每秒三十帧。终态和输入 SHALL 优先请求下一帧，不重复建立写屏调度或同步输出包裹。

#### Scenario: Unsupported synchronized output
- **WHEN** 终端不支持或不能确认同步输出能力
- **THEN** 使用普通差量刷新并保持可操作，不把该能力作为启动必要条件

#### Scenario: Completion with queued delta
- **WHEN** 一帧内出现多个增量和完成事件
- **THEN** 最终绘制对应完整有序状态，不在完成后插入旧增量

### Requirement: Performance evidence uses representative workloads
验收 SHALL 覆盖一千条消息、高终端短消息、1 MiB 单块、每秒一百次 delta 持续三十秒、交错工具和二十次尺寸变化。参考环境 SHALL 记录输入响应 p95 小于 100ms 的目标及结果，不能丢事件或删历史达标。

#### Scenario: Reproducible workload
- **WHEN** 执行合成事件与滚动压力验收
- **THEN** 记录机器、终端、延迟及缓存/挂载峰值，并验证最终投影内容完整
