# CLI Command Contract

## Purpose

为 Kapibala CLI 统一常用 Slash 命令、兼容别名、参数帮助和执行状态边界，使用户能按熟悉的命令管理会话、上下文、模型与权限，并保证命令错误、菜单输入和配置失败不会混入模型历史或破坏会话状态。

## ADDED Requirements

### Requirement: Canonical command names and compatible aliases
CLI SHALL 提供 /new、/resume [id]、/history [page]、/rename <title>、/context、/compact、/model [id]、/model key [id]、/settings、/settings default <id>、/settings setup、/permissions [mode]、/status、/logs [count]、/instructions、/help [command] 和 /exit。CLI SHALL 将 /clear 映射到 /new、/mode 映射到 /permissions、/config 映射到 /settings、/quit 映射到 /exit、/model setup 映射到 /settings setup、/model set-default <id> 映射到 /settings default <id>；主入口与兼容入口 SHALL 具有相同校验和副作用。/permissions SHALL 保留 approval/plan/auto/full-access 四态及 FullAccess 显式确认，plan SHALL 仅表示既有只读权限态。

#### Scenario: Existing mode command continues working
- **WHEN** 用户通过 /mode 或 /permissions 切换同一权限态
- **THEN** 两个入口使用相同权限规则及确认约束，不创建不同的权限配置

#### Scenario: Clear retains the previous conversation
- **WHEN** 用户在受管 CLI 执行 /clear
- **THEN** 行为与 /new 一致，旧会话仍可恢复，SDK reset 的清空语义不变

### Requirement: Consistent command discovery and help
CLI SHALL 从统一命令定义提供注册与分组帮助；每个可用命令 SHALL 有参数用法、描述、兼容别名和执行状态约束，命令名称冲突 SHALL 拒绝注册。/help [command] SHALL 支持查看主命令或别名的用法。未交付的未来能力 SHALL 不注册为可执行占位命令或出现在可用命令帮助中。

#### Scenario: Help matches dispatch
- **WHEN** 用户查看 /help 或 /help mode
- **THEN** 总览只包含实际注册能力，别名帮助指向对应主命令及相同参数规则

#### Scenario: Future capability is unavailable
- **WHEN** 当前版本尚未交付会话分叉、归档、Skills 或 MCP 命令
- **THEN** 帮助不假称这些命令可用，输入对应未知 Slash 按命令错误处理

### Requirement: Invalid commands never become model messages
CLI SHALL 校验参数数量、子命令及取值；无参数命令 SHALL 拒绝多余参数，历史页码 SHALL 为正整数，logs count SHALL 保持 1–100 边界，ID SHALL 按恢复契约校验，标题 SHALL 保留原始尾部文本并按历史标题安全规则存储和展示。未知 Slash、错误参数和错误子命令 SHALL 输出诊断与用法，不调用模型、不追加用户消息、不改变业务状态。命令名称匹配 SHALL 不区分大小写；裸词 SHALL 仅保留单独 exit/quit 白名单。

#### Scenario: Invalid count or extra argument
- **WHEN** 用户输入 /logs 0 或 /compact unexpected
- **THEN** 系统报告用法错误，不调用模型或开始压缩

#### Scenario: Title contains spaces
- **WHEN** 用户输入 /rename 修复 登录 问题
- **THEN** 系统将完整标题尾部按安全规则保存，不仅使用第一个词

#### Scenario: Ordinary language is preserved
- **WHEN** 用户输入普通自然语言，且不是单独 exit 或 quit
- **THEN** 不因含有命令名称而被误识别为裸命令

### Requirement: Mutating commands require an idle session
会话新建/恢复/改标题、模型热切换/密钥/默认配置/向导、权限切换和手动压缩 SHALL 仅在 run、审批、菜单、摘要、切换及在途清理均空闲时开始；执行状态校验与变更 SHALL 串行，执行中请求 SHALL 明确拒绝并提示等待清理后重试，不隐式排队或取消任务。只读 /help、/status、/context、/history、/logs、/instructions 和无参数 /settings、/permissions SHALL 使用一致快照，不改变历史或触发模型。退出 SHALL 中止并等待工具、摘要和存储收口后完成。

#### Scenario: Tool cleanup has not completed
- **WHEN** 当前任务已收到取消但工具清理仍在进行，用户请求 /new、/model <id>、/permissions auto 或 /compact
- **THEN** 系统拒绝变更，当前会话与配置保持有效，不提前释放锁

#### Scenario: Status query is read only
- **WHEN** 输入协调器在任务执行期间接受 /status
- **THEN** 系统读取已发布的快照，不更改正在执行的任务或开启额外输入消费者

### Requirement: Shared input and non interactive behavior
会话/模型菜单、配置向导、审批、秘密输入和权限确认 SHALL 共享宿主输入协调，输入 SHALL 不串入其它流程或模型消息。菜单取消 SHALL 只关闭菜单；任务中止 SHALL 等待事务闭合。非 TTY 无参数 /resume SHALL 展示历史列表与指定 ID 用法；无参数 /model SHALL 展示当前模型及可用 ID，不能挂起打开选择器。宿主不能提供向导、秘密输入或 FullAccess 确认时 SHALL 明确报告交互不可用，不自动批准或把密钥放入命令参数。

#### Scenario: Cancel a model menu
- **WHEN** 用户用 Esc 或 Ctrl+C 取消模型选择
- **THEN** 当前模型不变，菜单字符不发送给模型或后续审批流程

#### Scenario: Choose a model in a pipe
- **WHEN** 非 TTY 执行无参数 /model
- **THEN** 系统输出模型信息与用法并返回，不创建阻塞选择器

#### Scenario: Secret input is unavailable
- **WHEN** 宿主无法提供秘密输入而用户请求更新 API Key
- **THEN** 系统报告可用配置方式，不读取其它交互答案作为密钥或回显密钥

### Requirement: Configuration changes commit before memory activation
/settings default <id> 及兼容入口 SHALL 仅修改默认启动模型，不隐式切换当前模型。配置写入 SHALL 从未合并内置目录的全局用户配置开始，保留已有用户字段，仅按需要补充所选 profile；未启用的其它内置模型 SHALL 不被物化。持久化失败 SHALL 不更新内存默认值。密钥读写 SHALL 沿用既有厂商分组、同组单份密钥与未知端点隔离规则，命令帮助和输出 SHALL 不泄露密钥。

#### Scenario: Change the default model
- **WHEN** 用户成功执行 /settings default <id> 或 /model set-default <id>
- **THEN** 下次默认启动模型更新，当前模型不被隐式热切换，其它未启用内置 profile 不写入用户文件

#### Scenario: Configuration write fails
- **WHEN** 默认模型配置持久化失败
- **THEN** 系统报告失败，磁盘和内存不被假称已更新，当前模型保持不变
