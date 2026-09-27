# Design

## Context

动机与版本范围见 proposal.md。用户确认 v0.0.3 同时交付历史会话与上下文管理；普通启动默认新建，恢复通过 `/resume` 或 `--continue`；首版不拆当前任务内部历史，完整轮次保护范围超限时停止。

已确认实现基线：以 Pi 的会话记录、上下文投影与增量滚动摘要为主体，保留保守的两级压缩，借鉴 Codex 运行中与持久化上下文一致的恢复原则。Claude Code 重建代码仅作为剪裁与熔断的局部参考，不复制 Provider 专属缓存编辑路径。任务内部压缩留到后续；用户接受本版直接重构 Core。

现状：CLI 固定绑定 cwd 下 `.kapibala/history.jsonl`；JSONL 只保存 ts/role/content；Session 每次初始化生成日志 sessionId 并加载完整消息。REPL、退出和模型切换回调都闭包引用同一个 Session。现有工具清理、消息级落盘和权限门不能在切换中退化。Core 保持 Headless、零运行时依赖；不执行 Git 暂存、提交、分支或推送。

## Goals / Non-Goals

**Goals:** 在同一工作树内发现和切换独立会话，恢复合法历史和摘要状态；列表成本不随所有会话正文总大小线性增长；切换、迁移和检查点提交失败均不丢失既有历史。

**Non-Goals:** v0.0.3 不交付历史分支树、跨项目全文检索、归档/删除菜单、远程同步、SQLite、子代理、Anthropic Provider 或任务内部压缩。独立会话不承诺磁盘体积恒定；摘要减少模型上下文，完整记录仍增长。

## Decisions

### 1. 每个会话一个版本化 JSONL，按工作树分桶

```text
~/.kapibala/sessions/<project-key>/
  <timestamp>_<conversationId>.jsonl
  <conversationId>.meta.json
  <conversationId>.lock/
```

project-key 使用规范化、真实工作树根路径的 SHA-256；非 Git 项目退回真实 cwd。Windows 只按平台路径语义规范化，POSIX 不无条件小写。Git worktree 各自归属不同桶；项目移动后首版不自动合并。头部保存 schemaVersion、conversationId、createdAt、projectRoot、initialCwd 与创建时 gitBranch。执行 cwd 使用本次 CLI cwd，不因加载历史悄悄切目录；同工作树子目录可互相恢复；恢复时若检测到当前分支与元数据中记录的 gitBranch 不一致，向宿主发出环境漂移（Branch Drift）提示。首版仅支持当前桶，跨项目 ID 明确拒绝。

选择用户级目录与 Pi 的会话分组原则，并符合设计基线的数据作用域倾向；相较继续写工作区，避免历史进入仓库。相较全局单文件，单会话的读取和写锁可独立管理；相较 SQLite，不增加运行时依赖与迁移负担。

### 2. 正文是真源，sidecar 是可重建列表缓存

meta.json 保存 id、projectRoot、gitBranch、createdAt、lastActivityAt、title、messageCount、lastModelId、schemaVersion、sourceRevision，以及 legacyImportSource 信息。默认标题从首条真实用户输入提取有界文本，控制字符转义，最长 80 个 Unicode code point；无输入显示“新会话”。`/rename` 追加 title 记录后重建缓存，用户标题优先。JSONL 不存 API key 或审批允许缓存。

正文先写成功，再以同目录临时文件 rename 更新 sidecar。列表比较 revision/大小和末次写入信息；缓存失效时流式扫描对应文件重建，分页每页 20 项，不同时加载所有正文。按真实用户输入或完成消息的 lastActivityAt 排序；仅浏览、初始化或失败打开不得变成“最近会话”。缓存写入失败诊断降级，不能否定已保存的消息。会话正文错误则明确失败，不伪装成新会话。

### 3. SessionManager 管理身份与存储，CLI 管理活动引用，Core 分层演进

Core 新增 SessionCatalog/SessionManager，提供 create/list/open/continueRecent/rename 和会话存储句柄；不负责终端菜单、密钥或 CLI Provider 构造。原 AgentSession 与 MessageStore 用法保留；SessionConfig 增加可选 conversationId 与可选状态存储能力，内部规范化记录必须具备稳定 ID。

同时，Core 内部组织结构向“六大领域分层（Domain Subsystems）”演进，避免根目录下 15+ 目录平铺膨胀：
1. `types/` 与 `errors/`：协议层与领域实体；
2. `runtime/`：执行引擎（AgentLoop 与 ToolExecutor）；
3. `context/`：会话与上下文工程（AgentSession、SessionCatalog/Manager、HistoryNormalizer、TokenEstimator、Compaction 与 Store）；
4. `capabilities/`：提示词、AGENTS.md 指令与工具基础设施（Prompt、Instructions、Security/Permissions、Tools/Shell）；
5. `models/`：模型驱动与场景路由；
6. `extensibility/`：生命周期挂载底座与审计（Hooks、Plugin、Logging）。
Core 保留既有根公开符号与基础 SDK 用法，新增接口和可选类型字段的边界见迁移说明；不提供旧内部源码深路径兼容。

重构可在本版直接执行，但先固定依赖方向：Session 协调 runtime 与 context，runtime 通过共享请求准备契约调用宿主能力，不反向依赖具体 ContextManager/Store；models 提供 Provider/Router，capabilities 与 extensibility 通过共享类型挂载，不导入 CLI。保留已有公共导出并新增必要能力，目录搬迁与业务变更分步验证，Headless、权限最终裁决和工具事务门禁全程生效。

CLI 新增 ActiveSessionController，统一拥有当前 AgentSession、会话描述、创建工厂及切换串行门。CommandContext、REPL 问答、prompt 更新、模型切换、SIGINT 和退出全部在动作开始时通过 controller 取当前 Session，清除原来的固定闭包。SDK 宿主可以直接用 Core SessionManager 创建并加载会话。

切换采用 prepare → activate：当前无 run/审批/摘要/切换且所有在途清理已收口时，先锁定目标并完成加载验证，再原子发布活动引用，等待旧 Session teardown 后释放旧写锁。目标加载失败释放目标锁，保留旧引用；不能先 destroy 旧 Session 再承诺失败可续答。活动引用发布后的旧插件清理失败报告诊断，不回滚到已销毁对象，未确认回收的资源/写锁保持受管并禁止重新打开旧会话，退出时继续收口；原会话数据不得写进目标。当前模型/权限来自宿主实时配置，持久 lastModelId 仅用于展示，首版不自动恢复旧权限模式；新 Session 不继承会话审批缓存。恢复自己视为无操作。

### 4. CLI 命令和输入协调

| 入口 | 行为 |
|---|---|
| `kpbl`、无恢复参数的 `-p` | 创建独立新会话，不加载最近历史 |
| `kpbl --continue` | 恢复当前桶最近有内容会话，无历史则新建并提示 |
| `kpbl --resume <id>` | 完整 UUID 或唯一前缀精确恢复；不存在/歧义退出且不创建新会话 |
| `/resume` | 分页显示时间、标题、ID、消息数和当前标记；选择后恢复 |
| `/resume <id>` | 与启动精确恢复相同 |
| `/history [page]` | 只读分页列表，不切换；首版不重绘全部聊天正文 |
| `/new`、受管 CLI `/clear` | 保留原会话并切换到新会话 |
| `/rename <title>` | 仅修改当前会话标题 |
| `/context` | 查看窗口来源、最终请求输入预算及占用分类、受保护范围和有效检查点 |
| `/compact` | 空闲时手动摘要可压缩的旧完整交互；不删除原始历史，不绕过保护规则 |
| `/model [id]` | 无参数选择模型，指定 ID 热切换当前模型 |
| `/model key [id]` | 通过秘密输入更新当前或指定模型密钥，不把密钥作为命令参数 |
| `/settings`、`/config` | 查看生效配置及场景路由；config 为兼容别名 |
| `/settings default <id>` | 设置默认启动模型，不隐式热切换当前模型 |
| `/settings setup` | 配置向导；兼容 `/model setup` |
| `/permissions [mode]` | 查看或切换 approval/plan/auto/full-access；兼容 `/mode`，保留 FullAccess 显式确认 |
| `/status` | 会话 ID/标题、模型、权限、累计主任务/摘要 Token、工具与检查点概况 |
| `/logs [count]`、`/instructions` | 保留现有日志及项目指令来源诊断 |
| `/help [command]` | 按会话/上下文/模型配置/权限/诊断分组展示命令，或显示指定命令用法与别名 |
| `/exit`、`/quit` | 等待中止、工具/摘要和存储清理后退出，保留裸 exit/quit 白名单 |

`/model set-default <id>` 兼容映射到 `/settings default <id>`。`/model setup` 与 `/settings setup` 共用向导服务，默认模型入口共用写入服务；API Key 继续使用既有厂商分组解析/更新规则。默认模型写入读取 `loadGlobalSettingsForWrite()`，仅按需要补充所选 profile，不将合并后的内置目录整份写入用户文件；保存成功后再刷新内存配置，写入失败不改变默认值。v0.0.2 的 `/settings default` 当前使用 `loadSettings()` 合并配置写回，作为本次命令整理明确修复项。

CLI 增加统一命令目录，每项声明主名称、别名、子命令/参数用法、分组、描述、处理器、输入需求和状态约束，供注册与帮助共用；名称冲突在注册时拒绝。兼容别名解析到同一处理器与校验规则，不复制业务逻辑。此目录只属于 CLI，Core 不引入命令解析、终端组件或 ANSI。v0.0.8 的模糊命令面板/Tab 补全仍按后续规划交付。

参数采用命令级规则：无参数命令拒绝多余参数，ID/页码/count 校验数量及取值，标题和帮助保留原始尾部文本/参数语义；首版 `/compact` 不接自定义摘要指令。命令名和主/别名匹配不区分大小写，ID/标题按各自规则处理；未知 Slash、错误子命令或参数只输出错误与用法，不发给模型，不追加 user 消息。裸词仅保留 exit/quit，避免将普通自然语言变成命令。

命令目录区分只读和变更状态：`/help`、`/status`、`/context`、`/history`、`/logs`、`/instructions` 及无参数 `/settings`、`/permissions` 可读取一致快照；执行中不刷新指令或触发 Provider 调用。会话切换/改标题、切模型/密钥/默认配置/向导、切权限及手动压缩须持有同一空闲门；run、审批、菜单、摘要、切换或在途清理期间拒绝新的变更命令，提示先取消并等待清理后重试，不隐式排队或中断。退出走既有取消并等待收口流程；Ctrl+C 在菜单中只取消菜单，在任务中中止当前任务且等待闭合。只读命令可否收到输入由 REPL 输入协调器决定，不新增 stdin 消费者。

`--continue` 与 `--resume` 互斥。非 TTY `/resume` 无参数只输出列表与使用指引，不创建第二个 readline 等待输入；指定 ID 正常支持脚本。TTY 菜单复用同一个 REPL 输入协调器，不能直接调用独立 select 抢占 stdin；Esc/Ctrl+C 取消只关闭菜单，清除待输入状态，不向模型发送选择字符。

模型选择、向导与秘密输入也接入相同协调器；非 TTY `/model` 输出当前模型及可用 ID，不打开选择器，`/model <id>` 正常支持。向导、密钥输入和 FullAccess 确认在宿主不能提供相应交互时明确提示所需输入方式，不能挂起、读取审批答案作为密钥或自动批准。所有帮助仅展示本版真实可用能力；不预先注册 fork/archive/skills/mcp 等占位命令。`/permissions plan` 仍仅切换现有只读权限态，不新增完整规划工作流。

恢复显示会话 ID/标题、记录数量及最近真实用户/最终答复的有界预览。完整历史浏览与搜索暂不交付。SDK `reset()` 保持旧清空语义，受管 JSONL 必须写 reset 边界使恢复不能复活旧上下文；CLI 的 `/clear` 使用新会话语义。未使用受管会话的 SDK 继续按原 Store.clear 行为运行。

### 5. 单写者与写入恢复

每个受管会话持有独占 lock 目录，owner 记录随机 nonce、pid 与创建时间；目标已被占用时只允许只读列出，续答失败并保留当前会话。不能仅凭 TTL 或 PID 回收锁：需要确认原进程死亡并对 owner 身份与目录操作作竞态复核。无法确认、PID 复用疑似或元数据损坏时保守拒绝。锁自 open 到清理完成持有，工具/摘要仍在清理时不能释放。单写者实现使用 Node 原生文件系统，覆盖 Windows/POSIX 真进程竞争与异常退出测试。

每会话串行追加，提交失败的记录不得继续追加以掩盖错误。完整末行缺换行时补分隔；尾部不完整 JSON 保留为诊断残片并恢复到最后完整边界，再允许追加；中部损坏和重复 ID 是显式恢复错误。消息按既有消息级语义追加；每轮完整事务后 flush，检查点与迁移提交要求 fsync 后再激活。普通写入返回不宣传为掉电原子事务，多个消息不依靠一次 append 获得跨记录原子性。

### 6. 消息记录、生命周期与合法投影

记录 envelope 为 version/type/recordId/timestamp/parentId/payload，类型包括 header、message、run_started、run_finished、message_state、history_repair、usage、checkpoint、context_pruned、compaction_state、title、reset、legacy_import。conversationId 为持久会话身份；runtime sessionId 为进程实例；runId 为一次用户交互；工具调用 ID 与审计 operationId 沿用现有含义，日志追加 conversationId 关联。usage 记录按 model attempt ID 去重，保存主任务与摘要实际消耗，即使摘要最终未提交也可恢复统计；缺失的 usage 明确为未知。剪裁/熔断状态与 usage 不充当用户消息，不更新内容活动时间或消息成功状态。

新消息推荐采用自带时序单调递增的 UUIDv7（或兼容的单调 UUID 生成器）；旧消息 ID 从来源记录内容、原始记录位置和导入身份确定性生成。底层 Envelope 显式保留可选的 `parentId: string | null` 字段（指向因果前驱记录 ID），首版线性运行赋值为前一条记录 ID，为后续版本平滑升级到 DAG 历史树与回溯分叉提供前向兼容，避免二次破坏性数据迁移。streaming draft 不逐 delta 写入 canonical 正文；失败/中断步骤保存终态，不把部分 assistant 文本当作已完成回答。正文状态和 checkpoint 覆盖关系分开，不用 compressed 替代完成状态。

HistoryNormalizer 是纯函数，返回合法视图、来源 ID 与诊断：连续 user 和纯文本 assistant 在视图中稳定组合，空 assistant 省略；assistant 工具集合及紧邻结果不可拆分。缺失结果补 OUTCOME_UNKNOWN/after_user_action，已完成结果保真；孤儿、重复和迟到结果不参与请求；重复调用 ID 明确失败。恢复修复使用稳定 ID 并追加 history_repair 记录，显式引用原 assistant 与缺失调用，在视图中紧随原工具集合插入；不能把修复当作日志尾部普通 tool 消息，否则会再次被迟到规则排除。重复加载按修复身份去重，已有 checkpoint 涉及被修复范围时重新验证来源。Provider 仅映射协议角色和支持的 blocks，assembleToolResults 暂保兼容并由 Core 验证约束。

InteractionIndex 根据 run_started/finished 识别用户交互，与内部 turn/step 分离；旧记录只做保守线性边界推断，只有非空最终 assistant、没有 tool_use 且此前事务完整时才推断 completed，并标记 inferred 来源；没有成功证据不伪造 completed。getHistory 仍提供原始历史，新增上下文快照 API 显式提供投影；请求准备深拷贝/只读隔离，不允许 Hook 意外改原数组。

### 7. 最终请求预算与通用请求准备入口

普通 model:before Hook 完成后，通过通用 prepareRequest 异步事件入口进行投影验证与预算，Loop 只转发语义事件并接收最终请求，不承载压缩策略。Hook 添加的不可追踪内容标记为本次受保护内容，不静默覆盖。直接消费 Loop 的 SDK 仍可不启用上下文管理；启用受管 AgentSession 时预算不能被插件绕过。

预算 B = 窗口 C - 输出预留 R - 安全余量 S；缺省 R=min(4096,floor(C*0.125))，S=max(128,ceil(C*0.05))，自动阈值 floor(B*0.85)，目标 floor(B*0.65)；配置必须保证 0 < 目标 < 阈值 < B，输出预留传给实际 maxTokens 并受 Provider 能力约束。系统、工具 schema、摘要、消息和最终动态内容全部计入。缺省未知窗口采用保守 32K 控制预算，现有 1M 展示回退不再充当可信上限，展示明确 estimated。

TokenEstimator 可注入；默认按 Unicode 类别估算中文/英文/代码并计入 schema 与封装开销，用真实 prompt usage 校正，仍标为估算。模型、指令、工具、Hook 请求或检查点 fingerprint 改变时旧 usage 失效。输出预算不可被认为只影响统计而不约束请求。

保护当前交互、最近一轮成功完成交互及其后的失败/中断交互；其前连续完整交互可进入摘要。没有已完成交互时保护全部当前历史。超限错误只有在 Provider 明确归类为 context overflow 且无 delta/工具副作用时最多重发一次模型请求；普通 400、鉴权、网络异常、已产生部分输出都不触发该路径。

### 8. 分层压缩流水线、检查点提交与恢复

**三层数据与主体流程。** 原始历史为事实真源；有效摘要与剪裁记录组成可恢复的上下文状态；最终请求为状态投影加本次指令、工具与 Hook 动态内容。只缩减投影，不以占位符或摘要替换原始消息。Pi 的投影与滚动摘要是主线；相较直接清空窗口，能保留目标、约束与来源；相较任务内部切分，本版采用完整交互边界，单次超长任务可能明确停止。

先检查系统/工具/不可追踪动态内容与保护轮次构成的不可压缩部分；其本身超过硬预算 B 时直接停止，不浪费摘要调用。自动请求输入达到触发阈值 T 时执行第一级，再按剩余预算决定第二级；目标 G 为缩减目标，不是无限重试的理由。未达到 T 不自动压缩；手动摘要不受自动触发阈值限制。

无可压缩旧前缀时不调用摘要且不计失败，输入在 B内继续，超 B停止；不能为了达到目标 G剪裁保护范围或构造虚假的空摘要。

**Level 1：保守旧工具结果剪裁。** 仅选择保护范围之外、位于已完成旧交互且成功的工具结果。首版白名单为内置 read_file、glob、grep；run_command、写入工具、失败/结果未知及未声明剪裁语义的插件结果不参与。保留调用集合与结果 ID、成功状态、路径/调用意图及来源消息 ID，只将大段结果正文投影成有界说明。多工具事务结构不拆分。该步骤无额外模型调用，仍有本地扫描、估算、存储开销，信息省略与缓存变化需如实展示。

剪裁候选记录 context_pruned：id、baseCheckpointId、previousPruningId、policyVersion、目标 messageId/toolCallId、来源 digest、占位描述及时间。校验原始结果存在、状态/保护范围合法、候选实际缩减且最终输入不超过 B 后，追加并 fsync，再激活；候选仍超硬预算则不提交，尝试第二级。若剪裁后低于 T，跳过自动摘要；仍达到 T 但在 B 内可先提交剪裁再摘要。剪裁写失败保持原投影并报告存储错误，不以未落盘候选继续执行。

**Level 2：Pi 式增量滚动摘要。** 自动剪裁后仍达到 T，或用户空闲时执行 /compact，使用旧有效摘要加新增可压缩完整前缀。新增交互从原始历史取材，不能把剪裁占位符当作完整事实。SummaryService 使用 router.resolve('summary')，未绑定时回退当前会话默认路由；/settings default 不隐式切换当前路由。请求无工具、绕过主 Loop/压缩 Hook，单次触发包含全部分批/重试至多 4 次模型调用且总超时 120 秒；中间摘要不激活，单个不可拆分输入仍超摘要预算时失败。

保护范围之外、有运行终态来源且工具事务闭合的失败/中断旧交互也可纳入二级摘要，不能因旧失败永久阻断其后的完整前缀；失败和未知仍按真实结果记录，不改成成功。无终态证据或仍缺工具结果时保守停止切分。Level 1 继续仅剪裁成功完成旧交互中的白名单成功结果。

摘要序列化对单条历史工具结果保留默认上限 2000 个 Unicode code point 的首尾片段（各半），另附省略长度、来源 ID及有界状态信息。此限制只是输入防御：系统提示、旧摘要、调用入参、所有片段与输出预留仍须按摘要模型独立预算；累计超限按完整交互分批，不能承诺单条截断后请求一定成功。输出空、非法、来源错误、产生工具或 finish 状态截断的候选拒绝提交。

摘要字段为 schemaVersion、goal、constraints、decisions、completedWork、pendingWork、references、unknownEffects。文件操作由原始调用及真实结果确定性提取到 checkpoint.details，作为唯一结构化文件记录；区分成功 readFiles/modifiedFiles、失败 failedFileOperations 与结果未知 unknownFileOperations，附来源 ID和规范化路径，滚动时与旧 details 合并。渲染时提供 <read-files>/<modified-files> 等有界片段，列表增长也参与预算，不能无界注入。列表表示已观察到的历史操作，run_command/插件未提供文件事实时不猜测，不保证恢复后的当前磁盘状态。

**提交与恢复一致性。** checkpoint 保存 id、previousCheckpointId、sourceRevision/sourceDigest、覆盖结束 ID、firstKeptMessageId、summary、details、模型、策略版本、时间和 usage。来源校验使用消息/修复内容版本，与标题、usage、剪裁和熔断记录的追加版本区分，避免自追加使候选失效。每级遵循生成 → 验证来源/合法投影/保护边界/有效缩减 → 持久提交 → 激活 → 完成事件。输入低于 T 可以提交；受保护部分已高于 T但在 B内时，允许有实际缩减且不超 B的摘要提交，并抑制同版本反复压缩。摘要失败保留最近已提交投影，包括此前成功提交的剪裁，不回滚已持久化阶段；最终仍超 B才停止。

恢复顺序为读取原始记录 → 幂等修复未闭合事务 → 验证有效摘要链 → 验证适用剪裁链 → 重建投影 → 按当前模型重新预算。只应用与有效检查点及未覆盖尾部匹配的剪裁；新摘要覆盖的旧剪裁不重复应用。无效状态诊断降级到最近可验证状态或原始历史，重新预算，不能假称完整恢复。reset 同时废弃此前摘要、剪裁与熔断状态。有效来源、模型/指令与策略相同时，恢复前后请求投影一致；配置变化则明确重新预算。提交前取消不激活，提交后取消保留提交并等待清理。

**失败抑制、熔断与任务预算。** 同一请求内容 fingerprint 的失败不每个内部步骤自动重试；fingerprint 包含来源范围、检查点、模型、预算、指令/工具/动态请求及摘要策略，不包含标题或 usage。consecutiveFailures 按一次自动摘要操作计数，分批/重试调用不各算一次；生成/校验/无进展失败增加一次，成功持久提交摘要清零，取消/无可压缩前缀不计失败。存储故障进入存储错误流程，不能被熔断掩盖。

达到 3 次后仅暂停自动摘要，Level 1 仍可在安全范围内运行；是否停止主任务始终由最近有效投影的最终预算决定。新用户输入改变 fingerprint 可以在未熔断时尝试，但不清零连续计数；模型、预算、摘要策略配置实质改变开启新计数周期。compaction_state 持久记录配置周期、失败 fingerprint 与连续计数，恢复不因重启绕过熔断；状态写失败明确报告且不继续无保护地自动重试。手动 /compact 可显式重试，失败不解除熔断，成功提交才恢复自动摘要。明确 context overflow 且无输出/工具副作用时最多一次压缩后重发；其它错误不触发，不重放工具。

无 Store 的 SDK 可使用内存摘要与剪裁，事件标记 persistence=memory；仅旧 MessageStore 的 SDK 缺少状态能力时禁用持久摘要/剪裁并诊断，不假称恢复支持。手动 /compact 有可压缩前缀时直接尝试摘要，即使低于 T；无前缀提示且零模型调用，不新增任务或工具，失败诊断后返回，取消等待摘要/存储清理再释放空闲门。

### 9. 缓存亲和性与可观测性

未变化的系统提示词、工具声明及有效检查点摘要保持序列化确定性；summary 固定作为标明来源的用户背景片段注入在系统提示词之后、近期保留消息之前，不能升级为系统权限；动态时间移到后部，项目指令按 run 边界刷新。自动验收仅保证未变前缀字节稳定，不能保证 Provider 缓存命中；通用剪裁改变旧内容可能破坏该位置之后的缓存，本版不复制 Claude 的 API 专属 cache_edits。实际缓存 usage、输入缩减、摘要费用和耗时独立实测。

新增 session_resumed、session_switched、compaction_start/finish/failed、context_budget_exceeded；覆盖范围、检查点次数、时间和 Token 来源由 Core 提供，不携带 ANSI。摘要 usage 单独计数并计入总消耗，不计入主任务 TTFT/工具 step；恢复统计只累加已记录 usage，旧记录未知不补零冒充精确。取消事件迭代必须中止并等待摘要/工具清理；检查点已提交时保留，未提交时丢弃候选，然后才能释放写锁。

压缩事件区分 kind=prune/summary、reason=threshold/manual/overflow、持久或内存模式及真正完成的阶段；剪裁数量/节省估算与摘要成功次数分开，失败摘要 usage仍计入。/context 另展示有效剪裁数量、熔断状态及来源；观察本身不改变状态或执行模型。

`/status` 保留概况职责；`/context` 从当前有效投影和预算快照展示窗口 C、输出 R、安全余量 S、输入预算 B、触发阈值/目标，以及系统指令、工具 schema、摘要、保留消息和已知动态内容的估算，并在终端以字符比例条（Visualized Gauge，如 `[████████░░░░░░░░] 52%`）直观呈现各分项占用与剩余 Headroom。快照明确关联模型/请求版本、estimated/实际 usage 来源、保护范围及有效检查点；未执行下一次 Hook 时不声称展示值是下一请求精确值，不为了查看状态执行 Hook 或调用模型。恢复旧记录的未知消耗保持未知；TTY 与非 TTY 使用同一数据来源，非 TTY 输出不含 ANSI。

### 10. 测试矩阵与交付证据

下表为待实施验收，不表示已有测试通过。先用脚本 Provider、可注入 TokenEstimator/时钟、故障 Store 做确定性自动测试；磁盘/锁/异常退出使用临时目录及真实子进程，在 Windows/POSIX 验收。

| 测试组 | 场景 | 必须观察的结果 |
|---|---|---|
| 历史与保护范围 | 连续 user、失败尾部、空 assistant、多工具、无成功历史 | 原记录不变、规范化幂等、工具闭合、保护范围原文保留 |
| 最终预算 | T/G/B 边界、中文/代码/schema、Hook 增量、模型变小 | 最终请求参与控制、输出预留生效、保护内容超限零摘要调用 |
| 剪裁选择 | 大型读取/搜索输出、命令/写入/失败/未知结果 | 仅合法白名单与范围被剪裁，不调用模型、不改工具事务 |
| 剪裁提交与恢复 | 写失败、仅剪裁重启、无效来源/版本、摘要覆盖、reset | 未提交不激活，相同配置恢复一致，无效状态诊断降级 |
| 原始取材 | 已剪裁结果后续摘要 | 输入来自原始结果，不能把占位符当作完整事实 |
| 摘要输入 | 超长输出末尾错误、多条累计超限、旧摘要过大、超大不可拆分交互 | 有界首尾/状态/省略信息，总预算与分批生效，无法容纳明确失败 |
| 文件与候选校验 | 成功/失败/未知写入，空/非法/截断/来源错误摘要 | 文件事实区分结果，不猜测当前状态，无效候选不提交 |
| 阶段故障 | 剪裁已提交后摘要失败、fsync 失败、提交前后崩溃 | 保留最近有效提交，失败阶段不计成功，重启不重复使用量 |
| 熔断与抑制 | 同 fingerprint、新输入、三次操作失败、配置变化、恢复及手动重试 | 不反复调用，熔断独立于硬预算，计数/重置可恢复且一致 |
| 取消与并发 | 超时、迭代 return、清理中切换/锁争用 | 未提交丢弃、已提交保留、等待收口再释放锁 |
| 副作用与 overflow | Provider 明确拒绝、普通错误、已流式输出、恢复 | 仅允许明确无副作用的一次请求重发，工具执行次数不增加 |
| 命令与统计 | 手动低于 T、无前缀、busy、TTY/管道、失败摘要消耗 | 无前缀零调用、查询无副作用、剪裁/摘要统计分开、未知不补零 |
| 稳定前缀与退化 | 重复请求、指令更新、通用剪裁、旧 SDK Store | 未变字节稳定、真实变化失效、无状态能力不伪装恢复 |

真实模型质量另做三组对比：多轮文件阅读/修改，大量命令与测试输出，连续多次摘要后重启续答。记录约束、决策、待办、关键验证结论和未知副作用保留，重复读取/工作次数、任务完成、输入 Token、摘要费用/耗时及可用缓存 usage。摘要措辞和缓存命中不作为假 Provider 自动测试的保证，压缩率不能单独代表任务质量。

落地顺序：Core 依赖与合法历史 → 独立会话存储/恢复 → 最终预算 → 剪裁状态/恢复 → 摘要检查点 → 熔断状态 → 命令与展示 → 自动及真实模型验收。完整 pnpm verify 与跨平台恢复门禁通过后再标记实现完成。

## Risks / Trade-offs

- 完整记录随长会话增长 → 列表使用 sidecar；选中会话流式解析，模型使用检查点投影；磁盘回收与历史分页增强后续单独设计。
- 时间、模型或 Hook 内容变化导致估算漂移 → fingerprint 校正、有安全余量与明确超限拒绝；不承诺估算绝对准确。
- 恢复旧工具结果不等于恢复进程或文件 → 不重放工具；新输入要求模型按当前实际状态继续。
- 切换遗留固定 Session 闭包 → 所有入口改为活动 controller，测试“切换后模型更改/退出/中止”确实作用于目标。
- sidecar 与正文不一致 → JSONL 真源、revision 检查与可重建缓存。
- 全局目录不等于同用户安全隔离 → 用户级权限，正文不输出到日志，列表标题有界且控制字符安全。
- 默认新建与 `/clear` 语义改变 → 迁移说明、启动恢复提示和命令帮助；版本只在验收完成时升级。

## Migration Plan

1. 发现本次 cwd 及工作树根的旧 `.kapibala/history.jsonl`，按真实路径去重；不递归扫描整个仓库，其他子目录在用户从该 cwd 启动时再导入。
2. 读取来源快照并验证完整记录，按来源路径+内容 SHA-256 生成导入身份；锁定来源迁移入口，检测源文件仍在变化时延期，不读写同时运行的旧客户端历史。
3. 在目标目录写临时完整会话，保留原始信息与恢复诊断，fsync 后以无覆盖方式安装；再生成缓存与导入标记。新文件先含 legacy_import 身份，若标记写入失败可扫描目标头部找到已导入文件，重复启动不新增副本。
4. 导入旧文件整体作为一个会话，标题“旧历史导入”；普通启动仍新建，提示通过 `/resume` 找到导入会话；`--continue` 按有内容活动时间选择。源文件保留；若后续旧版本追加形成新 digest，再导入独立快照并标明来源，不能修改已导入记录。
5. 首次运行不改 package 版本；完成实现、文档和 Windows/POSIX 验收后统一升至 0.0.3。
6. 回退 v0.0.2 仍可读原文件；v0.0.3 新会话不自动写回旧单文件，不宣称旧客户端兼容新版 checkpoint。迁移失败报告且不删除来源，显式恢复失败不转为空会话。

## Reference Evidence

- Pi `packages/coding-agent/src/core/session-manager.ts`：会话头、独立文件、UUIDv7 会话 ID、随机短条目 ID、id/parentId、open/continueRecent、投影；本版暂不引入消息树但预留因果 parentId。
- Pi `packages/coding-agent/src/core/compaction/utils.ts`：文件操作提取（`<read-files>`/`<modified-files>`）、工具结果序列化截断（2000 字符防御）。
- Pi `packages/coding-agent/src/core/slash-commands.ts`：集中命令目录与 `/new`、`/resume`、`/compact`、`/model`、`/settings`；Pi `/name`、`/session` 本版采用 Codex/Claude 常用的 `/rename`、`/status` 命名。
- Codex `codex-rs/tui/src/slash_command.rs`：命令名称、说明、参数支持及执行中可用性集中定义，参考 `/permissions`、`/rename`、`/new` 和 `/resume`。
- Claude Code 还原仓库 `src/commands/{clear,config,context,compact,resume,permissions}/index.ts`：命令元数据、别名与非交互边界；仅参考本地可见定义，不推断所有还原命令均完整可用。
- Claude Code 还原仓库 `src/services/compact/microCompact.ts` 与 `autoCompact.ts`：轻量级工具结果修剪（Micro-compact）、连续失败熔断器（`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`）。
- Codex `codex-rs/rollout/src/recorder.rs`、`core/src/session/rollout_reconstruction.rs`：单写者、flush 与检查点回放；本版不引入数据库或远端 compact。
- Claude Code 还原仓库 `src/utils/sessionStorage.ts`：轻量历史发现、消息链、摘要边界；`reactiveCompact.ts` 本地为空实现，不能据此证明完整溢出恢复。
- Grok Bot 还原仓库 `source/host/extensions/session/session-conversation-state.ts`、`source/packages/agent-summarization/pipeline.ts`：模型状态与展示记录分离、摘要流水线（`SummarizationEnrichments`）；本版不复制其 SQLite/blob 架构。
