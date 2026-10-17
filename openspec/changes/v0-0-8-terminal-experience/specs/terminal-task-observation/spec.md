# Terminal Task Observation

## Purpose

让终端客户端在父任务运行或空闲时都能观察后台任务和会话指标，并明确任务来源、执行终态与结果投递之间的区别，避免展示层擅自改变任务调度、审批或计费语义。

## ADDED Requirements

### Requirement: Observable background task changes
运行时 SHALL 提供可取消订阅的任务变化通知，客户端可读取允许展示的只读快照。监听器异常 MUST NOT 破坏任务执行，关闭客户端或运行时 SHALL 释放订阅。

#### Scenario: Child completes while parent idle
- **WHEN** 父任务空闲且后台子任务变为终态
- **THEN** 客户端更新任务状态，无需新的父模型请求或用户命令

#### Scenario: Failing observer
- **WHEN** 一个任务观察者抛出异常或取消订阅
- **THEN** 后台任务和其他观察者继续工作，不产生额外任务副作用

### Requirement: Task origin and delivery remain separate
任务展示 SHALL 按当前父会话和根任务过滤，显示来源分支。执行完成与结果已收集 SHALL 分别表示；异分支结果只能提示，MUST NOT 自动投递或唤醒父模型。

#### Scenario: Completed result pending collection
- **WHEN** 子任务完成但用户未显式收集
- **THEN** 展示已完成且待收集，父历史没有新增结果消息

#### Scenario: Result belongs to another branch
- **WHEN** 当前分支与任务来源分支不同
- **THEN** 显示来源与切换提示，保持既有分支收集校验

### Requirement: Composable status uses host supplied facts
状态栏 SHALL 组合宿主提供的模型、权限、阶段、Git、上下文、运行指标和任务摘要，按优先级适配窄屏。绘制状态栏 MUST NOT 自行读取文件、启动命令或发起模型请求。

#### Scenario: Slow or failed git lookup
- **WHEN** Git 分支探测耗时或失败
- **THEN** 流式回答与输入不被阻塞，Git 字段使用缓存或省略

### Requirement: Unknown usage remains unknown
上下文占用与运行累计 Token SHALL 使用各自真实统计口径；缺少子代理账本时 SHALL 省略或显示未知，MUST NOT 将任务快照相加冒充树级计费。

#### Scenario: Multi-step run with unknown child usage
- **WHEN** 主任务有累计 Token 而子任务缺可靠 usage
- **THEN** 不把累计输入当作上下文窗口占用，不伪造树级费用或 Token 总量
