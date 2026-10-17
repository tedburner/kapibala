# Terminal Command Palette

## Purpose

统一终端客户端中内置命令、用户可调用技能与 MCP 提示词的发现和选择体验，保持候选身份、来源、参数和运行权限边界一致，避免界面展示与执行裁决分离后产生误操作。

## ADDED Requirements

### Requirement: Three metadata-only candidate sources
面板 SHALL 聚合已注册内置命令、可用且允许用户调用的 Skill 与 MCP Prompt，显示名称、描述、来源和参数提示。搜索 MUST 只读元数据，不加载正文或远端模板，原始 MCP Tool 不进入菜单。

#### Scenario: Same name across sources
- **WHEN** 内置命令、Skill 或不同服务的 Prompt 名称相同
- **THEN** 稳定身份和来源仍能区分，选择不会调用另一个来源

#### Scenario: Skill metadata has no catalog identifier
- **WHEN** Host 读取仅提供名称、scope 和发现路径等现有元数据的 Skill
- **THEN** 以规范化发现身份生成不透明稳定 ID，路径不原样放入共享候选；摘要和目录代次分别用于新鲜度校验，不要求不存在的 Core catalog-id 字段

#### Scenario: Unavailable source
- **WHEN** Skill 被禁用或 Prompt 服务不可用
- **THEN** 不可调用项不作为可执行候选，故障不伪装成成功空集

### Requirement: Deterministic matching and alias deduplication
匹配 SHALL 按精确、前缀、子串、模糊四级排序，同级维持稳定基础顺序。裸 Slash SHALL 使用策划命令顺序及稳定生态来源顺序，别名默认去重但可被搜索命中。

#### Scenario: Alias search
- **WHEN** 裸 Slash 展开后用户输入 quit 的前缀
- **THEN** 默认列表未重复展示退出动作，搜索仍能通过别名定位同一规范命令

#### Scenario: Asynchronous prompt discovery
- **WHEN** 两次目录发现的返回顺序不同而元数据相同
- **THEN** 同一查询的面板排序相同

### Requirement: Complete list with three-row default window
面板 SHALL 默认显示三条候选并提示剩余数，保留完整结果集合供上下键浏览。Tab SHALL 补全当前候选，Esc SHALL 关闭且保留文本，按键按当前焦点只消费一次。

#### Scenario: More than three results
- **WHEN** 匹配候选超过三条
- **THEN** 用户可滚动选到全部结果，窗口不截断集合

### Requirement: Parameter-aware invocation
Enter SHALL 对参数完整且可用的候选执行，对缺少必填参数的候选进入参数编辑；保留已有参数而不重复拼接。Prompt 参数 MUST 继续验证必填项与未知字段，未知 Slash 不作为模型问题发送。

#### Scenario: Missing skill task
- **WHEN** 用户选择需要任务文本的 Skill 但尚未填写任务
- **THEN** 进入参数编辑，不提前调用技能或模型

#### Scenario: Prompt arguments invalid
- **WHEN** Prompt 参数缺必填字段或包含未知字段
- **THEN** 就地报告参数问题，不进行远端模板或模型调用

### Requirement: Availability follows invocation and real execution gates
候选可用性 SHALL 按当前参数和实际运行、取消、收尾、输入独占及命令互斥计算。只读子命令不能因主命令可变更而一律禁用；独占问答期间不得执行其他命令。

#### Scenario: Read-only subcommand while busy
- **WHEN** 父任务运行中查询分支列表或已归档列表且无独占问答
- **THEN** 查询仍可用，而切换分支或恢复归档保持禁用

#### Scenario: Disabled invocation selected
- **WHEN** 用户在已确定不可执行的调用上按 Enter
- **THEN** 保留输入并显示原因，不启动任务或破坏在途迭代

#### Scenario: Arguments change availability
- **WHEN** 用户由只读参数改为变更参数
- **THEN** 面板立即重算可用性，并覆盖 cancelling 和 settling 阶段

### Requirement: Execution revalidates current identity and authority
执行 SHALL 复用既有命令、Skill 和 Prompt 受控入口，重新检查候选身份、目录/连接代次、权限、模式和忙碌状态。面板可见或此前可用 MUST NOT 作为执行授权。

#### Scenario: Prompt revoked after selection
- **WHEN** 候选显示后服务重连或目录撤销，再提交执行
- **THEN** 拒绝陈旧调用或要求重新选择，不发送旧目标

#### Scenario: Selected skill source replaced
- **WHEN** 已选 Skill 的同名获胜来源被替换或撤销
- **THEN** 旧选择失效，不能仅凭显示名称沿用执行授权；同来源内容更新仍须通过当前摘要与权限校验
