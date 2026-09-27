# Session History

## Purpose

为 Kapibala 提供可独立保存、发现和恢复的历史会话，使用户可以新建任务并保留原对话，按项目查看历史并选择续答，同时保证加载、切换、迁移和写入失败不会混合或丢失不同会话的数据。

## ADDED Requirements

### Requirement: Independent project sessions
系统 SHALL 为每个持久会话提供稳定身份、格式版本及独立记录，默认存于用户级按规范化工作树根分组的目录；非 Git 目录按真实 cwd 分组。会话元数据中 SHALL 记录会话创建与最后活动时的 `gitBranch`。同工作树子目录 SHALL 可发现相同历史，恢复 SHALL 不隐式改变本次执行 cwd；当恢复的会话创建于不同分支时，CLI SHALL 给出环境分支漂移提示。

#### Scenario: Different tasks in one project
- **WHEN** 用户在同一工作树分别启动两次普通 `kpbl`
- **THEN** 两次启动拥有不同会话 ID 和独立历史，前一会话保持可恢复

#### Scenario: Resume on a different git branch
- **WHEN** 用户在分支 `main` 恢复此前在分支 `feat/login` 创建的会话
- **THEN** 系统成功恢复会话，并向用户提示该会话源自分支 `feat/login` 的环境漂移信息

#### Scenario: Resume from a subdirectory
- **WHEN** 用户在同工作树子目录恢复根目录创建的会话
- **THEN** 系统允许恢复，并继续使用本次执行 cwd

### Requirement: Explicit continuation and new session behavior
CLI SHALL 默认新建会话；`--continue` SHALL 恢复当前项目最近有内容的会话，无历史时新建并提示；`--resume <id>` SHALL 支持完整 ID 或唯一前缀，不存在、歧义或与 continue 同时指定时 SHALL 明确失败，不生成替代空会话。受管 CLI `/new` 和 `/clear` SHALL 保留旧会话并新建，SDK reset SHALL 保留既有清空语义。

#### Scenario: One shot defaults to isolation
- **WHEN** 用户未指定恢复参数执行两次单次问答
- **THEN** 后一次问答不自动接收前一次任务的消息

#### Scenario: Explicit resume fails
- **WHEN** 恢复 ID 不存在或前缀匹配多个会话
- **THEN** CLI 报告错误且不创建新会话或修改既有消息

#### Scenario: Clear preserves managed CLI history
- **WHEN** 用户在受管 CLI 会话执行 `/clear`
- **THEN** 系统切换到新会话，旧会话仍可通过 `/resume` 续答

### Requirement: History listing and resume interaction
CLI SHALL 提供 `/history [page]`、`/resume`、`/resume <id>` 和 `/rename <title>`。历史列表 SHALL 按内容活动时间排序、分页展示标题/时间/ID/消息数/当前标记；浏览不得更新内容活动时间。TTY 选择 SHALL 支持取消并共享输入协调，非 TTY 无参数 resume SHALL 只输出列表与用法，不等待交互输入。

#### Scenario: Cancel selection
- **WHEN** 用户取消 `/resume` 菜单
- **THEN** 活动会话不变，菜单输入不进入模型消息

#### Scenario: Read history in a pipe
- **WHEN** 非 TTY 执行无参数 `/resume`
- **THEN** 系统输出有界历史列表和指定 ID 的指引，不挂起等待输入

#### Scenario: Rename is durable
- **WHEN** 用户修改标题后重启并查看历史
- **THEN** 用户标题仍存在且优先于自动标题，终端控制字符不改变显示布局

### Requirement: Bounded discovery and coherent metadata
历史发现 SHALL 使用可重建元数据，正常列表 SHALL 不逐个读取所有会话正文；元数据过期、缺失或损坏 SHALL 按正文重建。正文成功写入但缓存失败 SHALL 不丢弃已保存消息；显式打开损坏正文 SHALL 报错，不视为空会话。

#### Scenario: Many large histories
- **WHEN** 项目存在大量大正文且元数据有效
- **THEN** 列表只读取发现所需元数据，完整正文仅在选中会话时加载

#### Scenario: Metadata write failure
- **WHEN** 消息已保存但对应元数据更新失败
- **THEN** 消息仍可恢复，后续发现诊断并重建缓存

### Requirement: Safe active session switching
切换 SHALL 仅在 run、审批、摘要与切换均空闲时进行，加载目标失败 SHALL 保留当前活动会话。成功切换后问答、模型切换、状态、中止及退出 SHALL 使用目标会话；恢复 SHALL 使用本次宿主配置，清空旧会话审批缓存且不重放工具操作。

#### Scenario: Target fails to load
- **WHEN** 用户恢复损坏或无法锁定的目标
- **THEN** 原会话仍可续答，原存储不被绑定到目标身份

#### Scenario: Model change after resume
- **WHEN** 用户成功恢复历史后执行 `/model` 并提问
- **THEN** 模型变更作用于恢复后的活动会话且新消息仅写入该会话

#### Scenario: Busy session
- **WHEN** 当前工具清理或摘要仍在进行时请求切换
- **THEN** 系统拒绝切换且继续等待原操作清理，不提前释放历史写锁

### Requirement: Consistent restored context state
恢复 SHALL 校验有效摘要、适用剪裁与失败状态，按本次模型重新预算；reset SHALL 同时废弃旧摘要、剪裁和熔断状态。相同来源/配置/策略下恢复投影 SHALL 与最近有效提交一致，状态无效 SHALL 诊断并退回可验证状态，不重放工具。

#### Scenario: Resume a session with pruning and summary
- **WHEN** 用户恢复同时包含有效摘要与剪裁记录的会话
- **THEN** 系统按有效覆盖关系重建投影，已摘要范围不重复剪裁，工具不再次执行

### Requirement: Legacy history import
系统 SHALL 将被发现的旧 cwd/工作树根 history.jsonl 整体导入为独立会话，保留源文件与来源信息，不猜测旧任务边界。相同来源快照 SHALL 只导入一次；安装后标记失败的恢复 SHALL 不生成重复副本。迁移发现源正在变化 SHALL 延期并诊断。

#### Scenario: Repeated startup after import
- **WHEN** 同一旧文件快照多次被发现
- **THEN** 只存在一个对应导入会话且原文件保持不变

#### Scenario: Crash before import marker
- **WHEN** 目标导入记录已完整安装而标记尚未写入时进程退出
- **THEN** 下一次启动识别已安装记录并完成缓存，不重复导入

### Requirement: Single writer and recoverable append
受管会话 SHALL 同时只允许一个进程写入，锁 SHALL 持有到在途工具/摘要和存储清理结束。存活或无法确认死亡的 owner SHALL 不被仅按年龄或 PID 强制抢占。尾部残片 SHALL 在安全恢复后允许追加，中部损坏 SHALL 明确失败。提交检查点/迁移 SHALL 在持久化完成后对外宣告成功。

#### Scenario: Two processes resume one session
- **WHEN** 两个进程尝试续答同一会话
- **THEN** 最多一个取得写入权，另一个明确失败而不交错消息

#### Scenario: Partial tail
- **WHEN** 会话末尾存在半截记录后恢复并追加消息
- **THEN** 系统保留损坏诊断并保证新消息为独立可解析记录

#### Scenario: Corruption in the middle
- **WHEN** 正文中部出现损坏或重复消息身份
- **THEN** 系统报告恢复错误而不静默拼接为合法完整会话
