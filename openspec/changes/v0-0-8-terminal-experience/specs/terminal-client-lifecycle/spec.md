# Terminal Client Lifecycle

## Purpose

定义统一 kpbl 终端客户端的交互模式选择、终端资源所有权及退出边界，确保交互界面演进后单次问答、管道输出、取消清理和既有会话历史仍具备可验证的兼容行为。

## ADDED Requirements

### Requirement: Explicit UI mode selection
客户端 SHALL 支持 auto、tui、text 三种 UI 策略，默认 auto；非法或相互冲突的模式输入 MUST 在创建会话、加载项目副作用或发送模型请求前报错。单次问答和非交互环境 SHALL 使用文本通道。

#### Scenario: Interactive auto launch
- **WHEN** 用户未指定模式，输入与输出均为 TTY 且终端能力可用
- **THEN** 客户端启动完整终端视图，继续使用 kpbl，且不新增发布包

#### Scenario: Noninteractive or one-shot launch
- **WHEN** 用户执行单次问答、重定向或显式 text 模式
- **THEN** 使用文本输出，不进入备用屏，公开正文和错误完整可见

#### Scenario: Explicit interactive text mode
- **WHEN** stdin/stdout 均为 TTY 而用户显式指定 text 模式
- **THEN** 使用文本交互通道，不初始化 TUI 渲染器，不要求用户切换可执行文件或安装新包

#### Scenario: Invalid explicit mode
- **WHEN** 用户指定非法 UI 值或在非交互/单次模式中显式请求 tui
- **THEN** 启动失败且没有新建会话或模型请求

#### Scenario: Auto initialization fallback
- **WHEN** auto 模式的交互渲染器在接受用户任务前初始化失败
- **THEN** 已取得的终端资源被恢复、诊断可见，并可使用文本通道；显式 tui 则报告失败

### Requirement: Single terminal resource owner
客户端 MUST 使原始输入、raw mode 和实际写屏分别只有一个所有者。输入实现交接 SHALL 先完整解除旧读取器与监听再启用新实现，失败 SHALL 恢复本实例改变的模式。

#### Scenario: Startup input handover
- **WHEN** 首次向导或 MCP 启动确认后进入完整终端视图
- **THEN** 启动期输入读取器已关闭且监听已解绑，单个字符只被一个输入链消费

#### Scenario: Session factory requests input after handover
- **WHEN** 输入交接后切换会话、创建会话或重连 MCP，需要授权或输入
- **THEN** factory 使用当前有效宿主输入端口，不调用已关闭的启动读取器，也不为此重新启用第二个输入读者

#### Scenario: Plain informational command
- **WHEN** 用户请求 help 或 version
- **THEN** 不初始化交互渲染器、终端模式或按键监听

### Requirement: Cancellation waits for actual settlement
用户取消运行 SHALL 请求中止并等待在途工具、完整历史事务和存储清理。运行结果事件 MUST NOT 作为解除执行门的依据；只有实际操作完成后才允许新的变更调用。

#### Scenario: Run result precedes cleanup
- **WHEN** 已收到运行结果但存储或控制器仍在清理
- **THEN** 界面显示收尾状态，执行门仍关闭，直到操作真正结束

#### Scenario: Cancel remains interactive
- **WHEN** 用户按 Ctrl+C 或收到外部 SIGINT 取消当前运行
- **THEN** 界面保持备用屏与输入能力，显示取消/收尾阶段；清理后可继续对话

#### Scenario: Failure after reported result
- **WHEN** 运行结果后发生落盘或清理异常
- **THEN** 界面报告失败，不能提示全部成功保存或提前接受变更

### Requirement: Graceful and fatal exits remain distinct
正常关闭 SHALL 停止新任务、取消并等待受管资源、停止绘制后恢复模式。致命异常 SHALL 尽力同步恢复终端并保留非零退出，MUST NOT 吞掉异常后继续运行；不可捕获终止不承诺执行清理。

#### Scenario: Graceful exit
- **WHEN** 用户明确退出或收到可处理的终止请求
- **THEN** 等待受管资源关闭后恢复进入前的终端状态，显示简短恢复会话入口，不打印整段历史

#### Scenario: Fatal exception
- **WHEN** 发生未捕获致命错误
- **THEN** 同步恢复操作幂等且尽力执行，进程非零退出，不宣称异步历史已保存完成

### Requirement: Existing runtime and publication compatibility
交付 SHALL 保持 Node >=20 的运行兼容、现有三个发布包及 Core 零外部运行时依赖。升级终端依赖 MUST 有安装产物和目标平台证据，不得以删除兼容声明代替验证。

#### Scenario: Packed client installation
- **WHEN** 从最终 tarball 在隔离目录安装并启动
- **THEN** 文本和交互入口可解析实际依赖，Core 不加载任何终端依赖
