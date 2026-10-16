# Kapibala v0.0.7 会话增强与多智能体技术设计

状态：2026-10-15 修订后的本地规划方案，尚未实现、验收或发布。当前工作区版本为 0.0.6。

关联：[开发计划](2026-10-15-v0-0-7-development-plan.md)、[设计基线](../../design/001-agent-framework-design.md)、[路线图](../../RELEASES.md)。本文细化版本边界，不修改设计基线的章节编号与交叉引用。

**用户已确认：子代理后台执行，父代理可以继续工作并接收完成通知。** 其余组件划分、默认限额和恢复策略是据此提出的工程选型；更新文档不表示已批准实施或完成验收。

## 1. 目标、现状与版本边界

### 1.1 版本目标

1. 显式注入工作区身份与执行目录，同进程内多会话按各自边界解析路径和执行工具。
2. 支持可恢复的会话分支、分支摘要、独立会话导出、跨项目全文搜索及逻辑归档。
3. 使用同一 Agent Harness 执行后台子代理，提供权限收紧、任务查询/取消、可靠完成通知和去重账本。

Core 保持 Headless 和零外部运行时依赖。运行协调、持久收件箱与工作区契约属于 Core；终端展示与输入属于 CLI；MCP 连接实现继续留在独立适配包。

### 1.2 已核实的现状

| 现有接点 | 已有行为 | 本版调整 |
| --- | --- | --- |
| Core Session、SessionManager、ContextManager | 存在 process.cwd() 或 '.' 缺省路径 | 明确工作区根、执行目录和项目身份，缺失时在副作用前失败 |
| capabilities/tools/builtin/fs.ts | 模块级 sandboxCache 已按 rootDir 分组 | 改为会话持有实例，明确物理路径缓存生命周期 |
| context/session-store.ts | schema v1 的 parentId 是物理前驱，恢复时强校验 | 同时调整格式、完整性校验、状态投影与缓存，不能只修改追加指针 |
| context/session-manager.ts | sidecar 增量依赖 previous.revision === record.parentId | 分开物理日志 revision、分支叶子与正文 revision |
| runtime/executor/index.ts | runAll 串行执行；通用超时采用 Promise.race | 后台并发由运行时管理，启动工具自行等待清理，无需全局并行化工具 |
| CLI active-session.ts | operation 的 finally 调用 abort() | 后台任务不能长期绑定单轮操作的信号 |
| capabilities/security/permissions.ts | 模式为 Approval / Plan / Auto / FullAccess；规则使用 action 与精确 ShellScope | 不引入虚构的 ReadOnly 模式或 pattern: 'write:*' 规则 |

构造时捕获 cwd 不等于执行中改变进程 cwd；按根分组的缓存也不足以证明跨工作区越权。显式参数化以真实并发、身份及路径边界测试为依据，不保留“必然串扰”的未经验证判断。

### 1.3 交付边界

| 本版交付 | 本版不交付 |
| --- | --- |
| 显式工作区参数、native realpath、会话级沙箱与架构门禁 | OS 级任意 Shell 沙箱、远程/分布式执行 |
| Append-only 单父节点会话树、持久游标、完整交互边界分叉与摘要 | 半工具事务切分、分支合并、通用图编辑器 |
| v1 读取与保留原文件的 v2 升级副本 | 旧版本读取 v2、静默覆写旧会话 |
| 跨项目目录、有界流式全文搜索、逻辑归档 | 向量/倒排数据库、无规模约束的毫秒级性能保证 |
| spawn_agent、list_agents、wait_agent、cancel_agent、完成收件箱 | 子代理任意互发消息、已完成任务续跑、重启后自动重放执行 |
| 父子追踪、权限求交、容量/深度/期限/预算、worktree 产物保留 | 自动意图分类、自动合并代码、模型自行提升 Git 权限 |

## 2. 参考证据与设计取舍

证据来自 F:\Project\aigc 的本地源码，不表示远端最新版本。旧稿的 Pi cdaf6c227、OpenCode d21b0790a6、Codex 8c0f701167 提交均存在；本次复核采用以下本地 HEAD。

| 项目 / 快照 | 核实入口（仓库相对路径） | 取舍 |
| --- | --- | --- |
| Pi 9a3ca68bda4d | packages/coding-agent/src/core/session-manager.ts；packages/coding-agent/src/modes/interactive/components/session-selector-search.ts | 借鉴父指针、摘要和路径投影；branch() 仅改内存，不能据此承诺持久切换。搜索会流式读取正文并收集消息文本，不是只读 Header 的全文索引 |
| OpenCode 7ced591c3cc5 | packages/core/src/workspace.ts；packages/core/src/session/subagent-job.ts、subagent-completion.ts | 借鉴工作区驱动、独立 Job 生命周期和完成观察器；用小接口与 JSONL 实现，不引入 Effect 或复制数据库体系 |
| Codex bb64b894fd67 | codex-rs/core/src/agent/control/completion.rs、mailbox.rs、spawn_guard.rs；codex-rs/core/src/context/subagent_notification.rs | 借鉴暂态资源守卫、队列与结构化通知。源文件存在 best-effort 投递，本文耐久收件箱是本项目新增约束；结构化不等于不可篡改 |
| CodeWhale 1543c369919c | crates/tui/src/worker_profile.rs；crates/tui/src/tools/subagent/mod.rs；docs/SUBAGENTS.md | 借鉴统一 ChildGrant、角色预设求交、同一引擎与容量管理。其深度默认 3、硬上限 8；本方案限额属于 Kapibala 选型 |
| Claude-Code 2fa3ee47c0e7 | README.md；src/tools/AgentTool/AgentTool.tsx、forkSubagent.ts | 仓库自述为非官方 source map 还原版，仅作辅助参考。借鉴审批冒泡和保留有改动的 worktree；完整历史复制、Prompt Cache 字节对齐不进入本版 |

PiDeck 是独立仓库，本次不把 Pi 的提交号作为 PiDeck 证据。上游类名、角色或默认值不是本项目的安全证明，以权限及故障测试为准。

## 3. 工作区上下文与隔离

### 3.1 显式身份与目录

| 字段 | 契约 |
| --- | --- |
| workspaceRoot | 文件访问的物理根绝对路径，经 fs.realpathSync.native 规范化 |
| executionCwd | 默认命令目录，必须在工作区内；它本身不缩小文件权限 |
| projectKey | 复用既有规范化项目根算法，不接收模型提供的身份 |
| workspaceId | 宿主管理的运行工作区身份；worktree 与父目录拥有独立物理边界 |

Core 要求绝对路径，不读 process.cwd()，不以 '.' 兜底，也不调用 process.chdir()。CLI 在入口捕获启动目录并完成项目根发现后注入。rootDir 可作为显式兼容别名；新旧字段同时给出且不一致时失败，均缺失则抛出 code 为 WORKSPACE_ROOT_REQUIRED 的 KapibalaError。

AgentSession 持有独立 PathSandbox。ToolContext 明确提供工作区根、执行目录和沙箱；文件路径默认相对工作区根，命令默认使用执行目录。cwd 仅影响工作位置；收紧访问范围必须另行派生工作区授权。

涉及项目、执行或信任身份的真实路径比较，包括沙箱、ShellScope、引用脚本和 worktree，统一 native realpath 语义；Windows 大小写处理复用既有身份规范。不存在的目标由最近真实祖先推导，并复核链接越界。

扩展真实架构门禁入口 scripts/check-core-boundary.ts，沿用 pnpm check-architecture；不另造 check-architecture.mjs。

### 3.2 共享写入与 worktree

只读子任务可以共享父工作区。允许写入的子任务与父代理同时工作时，要求宿主提供 worktree，或通过工作区写租约串行化父子写操作。租约覆盖文件工具、Shell 与声明写能力的 MCP 调用，不能仅锁 write_file；外部工具的 readOnlyHint 不能证明无副作用。

worktree 由宿主 WorkspaceIsolation 适配器管理，Core 只消费受控接口。授权须包含创建工作树、可能创建的分支及清理；agent:spawn 不自动授予 Git 权限。使用参数数组调用 Git，不拼接 Shell 命令。

本版使用记录的提交作为基线。父目录有 staged、unstaged 或 untracked 内容时，以 WORKTREE_DIRTY_BASE 拒绝该隔离启动，不假称完整复制当前工作区；不自动 commit、stash 或复制秘密文件。宿主可显式提供已准备好的干净工作树。

派生授权绑定仓库、基线提交、父授权、任务 ID 和物理路径；模型不能靠 cwd 访问任意目录。worktree 提供文件副本隔离，不是任意命令的 OS 权限边界。

### 3.3 产物与回收

先等待工具/进程清理，再检查 tracked、staged、untracked、二进制变化及相对基线的新提交。有变化、Git 检查失败或所有权不确定时保留工作树，在结果中返回路径、分支、基线及产物清单。git diff 仅作辅助证据，不能代替备份。

只自动回收本运行时创建、登记物理身份仍匹配、确认无变化且不再使用的工作树。清理前复核目标位于注册容器内；失败记录待清理状态，不无条件执行 --force 或 branch -D。有产物的目录由宿主另行显式处理，不自动合并父工作区。

## 4. 会话树、持久游标与兼容

### 4.1 v2：物理顺序与因果分离

新写文件采用 schema v2，保持单文件 JSONL、单写者、串行追加和 fsync；会话结构为单父节点树，不提供分支合并。

| 字段 | 含义与验证 |
| --- | --- |
| schemaVersion | 新文件为 2，不把分支记录混入 v1 |
| recordId | 文件内唯一记录 ID |
| seq / prevRecordId | 连续物理序号及物理前驱，供完整性与 sidecar 增量校验 |
| parentId | 分支记录的上下文父节点，必须更早存在；全局控制记录为 null |
| branchId | 分支记录归属；全局控制记录通过 payload 指定目标 |
| type / timestamp / payload | 类型与来源引用均须校验 |

分支记录包括 message、run 生命周期、message_state、history_repair、reset、checkpoint、context_pruned、compaction_state 和 branch_summary。全局控制记录包括 header、分支创建/选择、title、标签、archive_state、usage 及任务/收件箱事实；控制记录不推进上下文叶子。

branch_created 保存 branchId 与 baseRecordId，branch_selected 保存选中分支。重放维护各分支叶子和选中分支，追加分支记录只推进对应叶子，不能从物理末记录推断上下文。

创建/选择分支、正文追加和写后缓存通知进入同一队列；落盘成功才改变对外状态。SessionLock 覆盖整个写者生命周期，子代理不能另开父文件写者。写入失败毒化队列，不能跳过失败继续追加。

### 4.2 操作边界与投影

branch(targetRecordId) 创建并选中新分支；目标限已闭合完整交互的 run_finished（completed / failed / interrupted）或新会话初始根。selectBranch(branchId) 切换已有分支。树可浏览全部节点，但不能从半工具事务或交互中间继续执行。

纯浏览不写盘，正式创建/选择必须持久化。父会话忙碌时拒绝分支变更；后台只读任务可继续，但通知绑定来源分支。共享写任务持有租约时须先结束或取消，再切分支。

buildSessionProjection 先校验物理链与引用，再沿选中叶子的 parentId 回溯。重复 ID、缺失父节点、前向引用、自环、错误分支基点及不完整工具事务均拒绝，不能静默返回截短历史。

投影顺序为：恢复原始消息和修复覆盖；恢复路径内 run 终态/reset；应用已验证的 checkpoint 与剪裁状态构造模型视图。只允许路径祖先状态生效，禁止全文件最后一次 reset 或其它分支摘要污染当前历史。切分支同步重建内存 history、ContextManager 和内容 revision。

logRevision 对应物理末记录，branchLeafId 对应分支叶子，contentRevision 仅随正文/投影相关记录推进。sidecar 增量比较 prevRecordId，不再比较 parentId；缓存丢失或版本不符从正文重建。

### 4.3 摘要与独立导出

branchWithSummary 记录原叶子、目标边界和共同祖先，明确离开路径的摘要范围，不能把不同分支按数组连续切片。摘要作为新分支 branch_summary 追加，带来源范围与生成身份；它是未经授权的历史背景，不是当前指令或权限来源。生成失败/取消不移动游标，用户可另选不带摘要创建分支；生成 usage 正常计账。

forkSession 从空闲且有效的选中路径导出新 conversationId，Header 记录 parentSessionId、forkPointRecordId。复制必需状态并映射分支和记录引用，不复制审批缓存、待执行任务、未消费通知或活跃成员关系；历史 usage 标为导入来源，不重复计入新执行费用。完整临时文件 fsync、独占安装并同步目录后才可见，失败不改源。

分支与 fork 只改变会话上下文，不回滚工作区。后续执行提示模型重新读取受影响文件。

### 4.4 v1 升级副本

v0.0.7 支持只读浏览 v1。首次续答或使用 v2 写能力时，取得源锁、验证完整快照后生成新 v2 会话副本：新 conversationId，Header 持有来源路径、源会话和内容摘要组成的 upgradeIdentity，原 v1 保留不改。

正文消息 ID 保持稳定，Envelope/状态引用显式映射，checkpoint 重新校验。非法中部记录拒绝升级；尾部残片隔离到副本流程，不修改原件。独占临时文件 fsync 后复核源未变化，再独占安装并同步目录。

同一来源快照重复打开定位已安装副本；目录从 v2 Header 重建升级别名，sidecar 不承担唯一映射职责。安装中断不发布半文件。旧版本继续写原 v1 导致摘要变化时返回 LEGACY_SOURCE_DIVERGED，不自动合并或创建重复副本。

v2 不支持旧版本续写。旧 SDK MessageStore 仍可用于单会话；缺少版本化耐久状态能力时，分支与可靠后台委派返回明确不支持错误。迁移文档列出新身份、列表去重及降级限制。

## 5. 跨项目全文检索与归档

### 5.1 目录与全文搜索分层

CrossProjectSessionCatalog 负责全局发现；SessionManager 管理项目内句柄、锁与身份。默认排除归档和内部子会话，--all 扩展项目范围，--agents 显式包含子会话。读取其它项目历史不获得执行信任，也不改变当前执行根。

普通列表读取有效 sidecar 和有字节上限的 Header。元数据保存身份、标题、Git 分支、选中分支、归档状态、活动时间、日志 revision 等，通过 size/mtime/revision 校验。缺失时流式重建并显示进度，不能只读前两行推断后续标题/reset/归档事实。

全文搜索先用项目/分支/状态过滤缩小范围，再流式读取全部分支的完整 user/assistant 可见文本与分支摘要；返回 conversationId、branchId、recordId、片段及可续答边界。默认不搜索原始工具输出、私有 reasoning、协议私有字段或凭据。“全文”限定在上述文本范围，不得退化成标题/摘要搜索。

查询支持空格 AND、引号短语、project:/branch:/tag: 过滤；标签由耐久控制记录维护。re: 是独立正则模式，不承诺额外前缀或模糊语法；中文使用字面匹配，不依赖额外分词库。

限制单行大小、查询长度、并发文件数和结果数。取消后关闭句柄；正则在可终止 worker 执行，限制消息大小和执行期限，不在主事件循环跑不受控 RegExp。按完整有界消息匹配或保留跨块边界，避免读取块切断短语。

文件损坏、超限、扫描中变化或达到总期限时返回 partial 及跳过原因，不能伪装为完整无结果。本版不要求持久全文索引；后续是否新增由基准决定，缓存始终可从正文重建。

### 5.2 逻辑归档

archive_state { archived: boolean } 为会话级耐久控制记录，sidecar 只是缓存。归档不移动正文文件，默认历史和续答候选排除归档；恢复追加反向状态。删除缓存或重启不得撤销归档。

归档要求会话锁，且没有前台运行、未清理子任务或未消费通知；否则 SESSION_IN_USE，由用户先处理/取消。归档不隐式杀任务或销毁 worktree。跨项目发现是只读能力，跨项目归档/恢复由宿主显式选择并复核目标。

## 6. 后台运行时与权限

### 6.1 组件责任

| 组件（拟新增或调整） | 负责 | 不负责 |
| --- | --- | --- |
| AgentRuntime | 任务树、暂态资源守卫、容量、期限、子 Session 生命周期 | 终端输入、另写模型/工具循环 |
| SessionCoordinator | 父写者、run 互斥、收件箱消费与唤醒 | 绕过 Store 写文件 |
| SubagentOutbox / SessionInbox | 耐久终态、投递重试、来源与去重 | 把子结果升级成系统权限 |
| WorkspaceIsolation | 宿主工作树准备、身份复核、保留与清理 | 模型任意创建可执行目录 |
| Host Adapter | 绑定/凭据、MCP 租约、审批队列、展示 | 改变 Core 历史闭合规则 |

每个子代理运行标准 AgentSession，复用 Loop、Executor、Hooks、审计、压缩和协议投影；独立 Store、history、工具注册表、取消控制器与统计。后台任务属于运行时内任务树，不属于启动工具 Promise、单轮生成器或可卸载插件。

持久来源包含 agentId、rootTaskId、parentAgentId、parentSessionId、originBranchId、originRunId、spawnToolCallId、generation、depth、工作区、有效授权摘要及实际模型。rootTaskId 在根用户任务及后续通知轮次保持稳定，新独立用户任务创建新 ID，旧活跃任务保留旧归属。

### 6.2 角色、上下文与模型

| 角色 | 权限上界预设 | 首选场景 |
| --- | --- | --- |
| explore | 受控读取；不提供通用 Shell 或有写副作用的外部工具 | fast |
| planner | 受控读取与分析；不提供通用 Shell | planning |
| implement | 申请父级可委派写权限，需写租约或 worktree | execution |
| advisor | 仅任务文本推理，工具集合为空 | planning |
| custom | 必须显式工具白名单，再与父级/能力边界求交 | 继承父绑定 |

角色定义为单一真源，驱动目录和执行检查；任何额外白名单始终求交，不因角色更严格而忽略调用方收紧请求。

默认新上下文：角色提示、任务、宿主验证的工作区指令及受限目录，不复制父全部历史或私有 reasoning。任务与结果不携带权限；Skills 按子工作区身份重新建立信任，allowed-tools 不得超过继承边界。

宿主优先使用已配置场景绑定；未配置首选场景则继承父轮 Profile/Provider 快照，回执显示 routeFallback: inherit。此业务角色默认解析不改变既有显式场景选择的严格语义。显式 modelOverride 无效、缺密钥或未获宿主允许，在受理与网络前失败，不静默换模型。

CLI 密钥读取继续使用 resolveApiKeyDetailed，写入继续使用 loadGlobalSettingsForWrite 和 updateProfileApiKey；Core 不自行读配置/猜厂商。本版不调整内置模型清单。

### 6.3 有效 ChildGrant

deriveChildPolicy 必须接收父级有效模式、规则、能力上界、工具/技能集合、工作区、剩余深度和可委派模型范围。无状态 PermissionPolicy 对象本身不能表达这些输入。

父上界、角色预设与显式请求逐轴求交：工具、文件、执行、网络、外部调用、工作区、深度及预算。祖先 deny 取并集，ask 不因子 allow 消失；白名单省略表示继承角色集合，空数组表示无工具，未知/不可委派工具名报错。

沿用 PermissionRule.action 和精确 ShellScope。Plan 继续拒绝 agent:spawn，不为委派绕过模式硬限制；只读角色不等于 Plan 模式。FullAccess 不能绕过祖先 deny、角色或工作区/深度边界。

启动固定授权上界，之后父级权限/信任撤销可即时收紧，后续扩大权限不自动扩大已有子授权。目录过滤与最终执行检查一致，防止伪造隐藏工具名、Skills 再注册或 MCP 更新恢复被剥离能力。

子审批缓存独立，不复制父/兄弟批准。审批请求带任务、父会话、工作区、有效授权摘要及精确执行身份；“批准 spawn”不能代替实际工具审批。输入、连接代次或有效授权变化后重新检查。

### 6.4 Skills / MCP 资源

Core 不反向依赖 MCP 包，宿主注入受限工具代理。共享连接必须引用计数，销毁子会话不能关闭父连接；仅同一工作区/服务端真实身份可复用启动授权，worktree 不自动继承父 Stdio 服务授权。

server identity、generation、catalog epoch、工具摘要及 source 撤销仍执行发送前复核；父撤销/断连后子级不能凭旧代理继续调用。readOnlyHint 不证明外部无副作用，只读角色仅接收宿主已约束的只读外部能力。

### 6.5 工具契约

| 工具 | 输入/输出 | 边界 |
| --- | --- | --- |
| spawn_agent | description、prompt、role 必填；可收紧 allowedTools、cwd、isolation、modelOverride、limits；回执含 agentId、受理状态、来源、实际授权与模型 | agent:spawn；managesTimeout: true；受理不是完成，Git 授权独立 |
| list_agents | 当前可访问任务树状态、来源、模型、耗时和终态摘要 | 不能猜 ID 读取其它树，展示 waiting_approval |
| wait_agent | agentIds、timeoutMs；返回变化或快照 | 默认 30 秒、最大 60 秒，可取消；等待超时不终结子任务，不占启动槽 |
| cancel_agent | agentId，返回取消/清理状态 | 只取消有权访问的后代，不取消父或其它树；终态幂等 |

四个模型侧工具均声明现有 agent:spawn capability，经正常 PermissionPolicy 和成员关系/硬边界校验；本版不另设绕过权限门的管理工具特例，Plan 不向模型暴露这些工具。深度/启动容量限制仅阻止新 spawn，不阻止已有成员的查询/等待/取消。CLI 的显式用户管理命令通过宿主 API 校验身份并记录审计，尤其允许用户在模式切换后取消已有任务。管理权限不从普通文件权限推断。

深度上限不仅隐藏 spawn，也在执行边界拒绝伪造调用。cancel_agent 与 spawn_agent 一样自行管理超时并等待清理，不能被通用工具超时提前结束。本版没有 send_message / resume_agent；新任务使用新执行身份。

### 6.6 限额与账本

下表为本方案提出的宿主可配置默认，模型只能请求更小值：

| 约束 | 默认 |
| --- | --- |
| 子深度 | 根 0，最大 3；配置硬上限 5；深度 3 不可再 spawn |
| 每树活动子任务 | 4，含预留、受理、执行、审批等待、waiting_children、清理中 |
| 每运行时活动子任务 | 8，覆盖所有根；根用户会话不占子槽 |
| 每树累计受理任务 | 16，失败/取消不退累计额度，通知轮次不重置 |
| 每子模型步骤 | 15，摘要/收口实际请求也须预留和计账 |
| 每子墙钟期限 | 5 分钟，含审批、模型、重试、工具、后代等待和收口；清理额外计时，不能假报终结 |

容量原子预留，超额立即 AGENT_CAPACITY_EXCEEDED；不做持槽等待的隐式启动队列，避免祖先等待子级、子级等待槽位的死锁。完成清理才退活动槽；换分支、取消、重启不重置已受理累计数，fork 不恢复旧任务的派生资格。

Token 限额按根共享账本和子限额检查，请求前预留输入估算及输出上限，真实 usage 到达后结算，并发不能重复花同一余额。后代、摘要、重试及通知轮次归入对应 rootTaskId。未知 usage 保持 unknown 和保守预留，不能当零；缺可靠 tokenizer/usage 时不宣称精确硬 Token 上限，步数/期限仍有效。

按 conversationId、runId、attemptId 和使用类别去重，实际请求所属会话保存事实，祖先聚合唯一请求，不能先将孙级加到子总额再整体加到根。展示 ownUsage、descendantUsage、summaryUsage 与各自 coverage；修改既有 totalTokens 口径须迁移说明，分支切换不抹除已发生费用。

## 7. 受理事务、通知与取消

### 7.1 启动事务

状态为 preparing → accepted → running → completed / failed / cancelled / interrupted；有未结束后代时，子代理自身主轮正常结束后进入 waiting_children，后代结果齐备时返回 running 执行收口。取消先进入 cancelling，清理后才终态。审批是运行中的等待标志。

waiting_children 仍占活动槽并计入原始期限，不能释放槽或提前向父代理发最终完成通知。子会话协调器自动收集同 rootTaskId 的后代通知并在剩余预算内收口，这是子任务运行契约，不受 SDK 根会话默认不自动唤醒的选项影响。只有后代终结并完成清理、收口完成后才写子终态；若期限/步骤不足，取消并等待剩余后代清理，返回受控的限额失败及已完成部分，不免费增加模型步骤。自身运行失败/被取消时直接级联取消后代再终结，不留下不可管理的孙任务。

| 阶段 | 动作与耐久事实 | 失败边界 |
| --- | --- | --- |
| 准备 | 验证参数/绑定/权限/工作区/容量；parentSessionId + spawnToolCallId 为幂等键，登记启动意图和暂态资源 | 未受理不执行子模型/副作用，回收后返回工具失败 |
| 受理 | 子 Header 与准备事实落盘；父按原规则提交 assistant 和全部对应 tool_result，回执带 agentId | 父存储失败不激活，同批其它已完成工具保留真实结果 |
| 激活 | 父事务提交确认后，运行时记录 accepted 并启动标准子 Session | 不能用 tool.execute 已返回推测落盘，崩溃按 §7.5 对账 |
| 执行 | 父可继续后续步骤，子独立保存消息/结果/usage | 子失败不补第二个启动 tool_result |
| 完成 | 清理后持久终态/outbox，再投递父收件箱 | 父不可用保留通知，不伪造成功 |

需扩展 Session 内部 transaction-committed 回调与待提交资源守卫，不能直接在工具中 fork 一个 Promise。父 canonical 工具事务闭合前不能插入通知消息。

消费者提前结束或启动超时发生在受理提交前，取消并等待暂态资源清理，闭合父调用后才释放锁；提交后成功移交后台任务归运行时，存活不依赖原工具栈。启动结果只描述当时受理事实。

### 7.2 Outbox / Inbox

eventId 从 agentId + generation + terminalRevision 派生，通知带父会话、来源分支/轮次/工具调用、终态、摘要、产物和账本引用。子终态与 outbox 同队列耐久提交，或从终态重建 outbox，不允许仅内存通知。

至少一次投递：父唯一写者追加 inbox_received 后才 ACK，子可追加 outbox 已确认状态。ACK 前崩溃允许重投，父按 eventId 去重；父文件被其它进程锁定时重试，不建立第二写者。

消费时通知作为带 source: subagent、eventId、来源的普通背景消息，经 MessageStore.append 保存；不能以 system 权限注入。来源字段由宿主提供，模型伪造文本不获得权限；投影为 user 只为协议兼容，UI 显示真实来源。

消费消息带 deliveryId，消息与 inbox_consumed 在同队列提交。恢复先查消息的 deliveryId，若消息已写而确认未写则补确认，不重复注入；未写消息不能先确认，不绕过 poisoned writer。模型推理失败不撤销已入父历史的通知。

### 7.3 分支与安全调度

| 父状态 | 处理 |
| --- | --- |
| 模型流/工具事务中 | 排队，仅将与当前 run 相同 rootTaskId 的通知在事务后或下次请求准备前消费；旧任务通知等独立通知轮，不改已发送请求 |
| 空闲且来源分支选中 | CLI 默认合并待处理通知并发起普通通知轮次；用户输入优先，不覆盖用户任务 |
| 其它分支选中 | 提示来源分支有结果；不切游标、不注入当前分支、不跨分支自动唤醒 |
| 会话未打开/宿主退出 | 保留待处理，不自动启动进程或调用模型 |
| SDK 未显式启用唤醒 | 只发收件箱事件，宿主显式消费；默认不自动调用模型 |

通知轮次沿用来源 rootTaskId 和剩余预算，每批必须有新的未消费 eventId，不因“还有任务运行”空转。一轮只处理一个 rootTaskId 的通知组；即使在同一分支，新用户任务也不即时消费旧任务的通知，旧通知等父空闲后独立调度。无法自动消费时保留待处理，提供 /agents collect <id>。

fork 不转移通知；结果只投来源父会话。归档原则上由使用中检查阻止，外部变化导致已归档时保留通知但不自动恢复。产物路径需再验证，不能直接打开子结果提供的任意路径。

### 7.4 取消与关闭

| 触发 | 行为 |
| --- | --- |
| 父轮正常结束 | 后台继续，解除单轮信号，不能被 finally 的 abort 误杀 |
| Ctrl+C / 当前 run 显式 abort | 取消当前 run 及本轮 originRunId 派生子树；较早轮次后台继续，除非显式取消该树 |
| cancel_agent | 取消目标及后代，等待审批/模型/工具/进程清理；已完成结果不改写 |
| 切会话或 /new | 同运行时保留旧会话/后台句柄，结果仍回原会话，提示后台数量 |
| reset / /clear | 有活动子任务或未消费通知则拒绝，先取消并收集/确认结果 |
| Runtime.close / 宿主退出 | 停受理、取消全部，等待工具事务/outbox/存储收口后释放锁与连接租约 |

Session run 空闲不等于 Runtime 空闲。waiting_children 期间不允许子会话被外部 reset、分支或归档操作改写归属。destroy、Manager release 和插件 teardown 服从运行时清理顺序，不能切会话时直接销毁后台资源。

oneshot 主轮结束后按剩余任务期限有界等待子任务与通知；超时取消并等待清理，返回未完成状态，不静默遗留进程。非 TTY 审批拒绝，需要用户动作时停止自动重试。

复用 Shell/MCP 的 Windows taskkill 与 POSIX 进程组清理并验证退出；未确认清理时保留诊断和清理失败状态，不宣称 100% 回收。工具管理自身超时，不能仅 Promise.race 后放任继续执行。

### 7.5 崩溃恢复

后台指同一运行时内执行，不是守护服务。正常关闭写取消终态；崩溃后的 preparing/accepted/running 与父回执对账，保留真实结果、缺失工具结果按 OUTCOME_UNKNOWN 修复，不自动重放模型/工具。

未激活受理恢复为 interrupted / never_started，已运行但终态未知恢复为 interrupted 并标明副作用未知。只补发可验证终态/outbox，不补成成功或确定失败。遗留 worktree 保留检查，不凭旧 PID 杀进程或删目录。可恢复历史/状态/通知，不承诺崩溃后任意脱离宿主命令自动回收，平台验收单列限制。

## 8. CLI 与宿主交互

| 入口 | 行为 |
| --- | --- |
| /history [--all] [--search <query>] [--tree] [--agents] | 区分目录与正文扫描，显示进度/partial/项目；树中完整边界才可分叉 |
| /branch [recordId] / /branch switch <branchId> | 创建/选择分支，持久成功再更新展示 |
| /fork [title] | 导出独立会话，不回滚文件或转移后台 |
| /archive <id> / /archive list / /archive restore <id> | 逻辑归档/恢复，使用中拒绝 |
| /agents / /agents show <id> | 状态、模型、来源、预算 coverage、审批与保留产物 |
| /agents cancel <id> / /agents collect <id> | 取消子树/收集来源分支结果；未选中来源时提示先切分支 |

后台事件通过独立宿主总线携带 conversationId、agentId、runId、branchId，不依赖已结束的父 run 迭代器。CLI 紧凑展示，Ctrl+O 复用详情开关，不承诺撤回已写终端内容；非 TTY 不输出 ANSI 状态行。

审批使用有界可取消 FIFO，串行交给单消费者 CliInputCoordinator，不并发 approve()。队列项带来源、精确目标、期限和信号；等待仍计任务期限，取消不会把下一项批准交给上一项。秘密输入时缓冲后台展示。

状态展示自身/后代消耗与未知 coverage，累计 Token 不冒充当前窗口占用。跨项目打开由宿主复核路径存在与信任，Header 不授予执行权限。

## 9. 验收矩阵

以下为待实现门槛，不表示测试已存在或通过。

| 维度 | 必须证明 |
| --- | --- |
| 工作区 | 两工作区并发同名读写/不同 cwd；8.3、大小写、junction/符号链接越界、脚本身份漂移、沙箱销毁隔离 |
| v2/迁移 | v1 浏览与副本、源不变、安装故障、来源变化、缓存重建；物理断链/错误引用/重复 ID 拒绝，旧读者拒绝 v2 |
| 分支/压缩 | 切换后无新消息立即重启仍正确；各分支 reset/checkpoint/剪裁/repair 不串用，拒绝半事务分叉 |
| 摘要/fork | 来源范围、失败不移游标、导出映射、无审批/任务/通知复制及不重复计费 |
| 搜索/归档 | 正文末尾独有词、中文/跨块短语、病态正则终止、取消关闭句柄、partial、删缓存后归档仍在 |
| 权限 | Plan 拒绝 spawn；祖先 deny/ask、空白名单、隐藏名、Skills/MCP 更新、撤销、Shell 和 worktree 无扩权 |
| 启动闭合 | 准备失败/受理前取消/父写失败/回执后崩溃/同批部分成功；未提交不启动、父历史闭合 |
| 生命周期 | 父正常返回子继续、子 waiting_children 等待孙任务后再终结、等待到期级联取消、Ctrl+C 精确子树、切会话保留归属、close 清理后放锁、oneshot 收口 |
| 可靠通知 | 终态/outbox、收件/ACK、消息/确认各崩溃窗口，重投只产生一份消费消息、不补第二个 spawn 结果 |
| 调度 | 父忙、用户输入竞争、空闲唤醒、异分支、SDK 默认不唤醒、多 rootTaskId 不混账、无事件不空转 |
| 限额/账本 | 抢最后槽、宽度/深度/累计、审批到期、并发预留、孙级去重、未知 usage 不计零 |
| 宿主/MCP | FIFO 取消关联、秘密输入、连接引用计数、撤销和无状态 SDK 降级 |
| 写入/worktree | 写租约覆盖 Shell/MCP，脏基线拒绝、untracked/二进制/新提交保留、检查失败不强删 |
| 平台资源 | Windows/POSIX 多层进程取消、工具落盘、MCP/锁释放顺序；崩溃限制与跳过平台如实标明 |

性能分别记录冷目录、热缓存、元数据重建、正文扫描的文件数/字节数、峰值内存、首批结果和取消耗时；固定规模后确定阈值，不凭数十个小文件承诺全库毫秒级。

## 10. 风险与停止条件

顺序为工作区/权限底座 → v2 分支与恢复 → 后台运行时/可靠通知 → 搜索归档/宿主整合，详细任务见开发计划。

出现任一问题停止后续依赖任务并修正契约：

1. 子任务通过角色、Shell、MCP、再注册或派生工作区扩大祖先权限。
2. 受理未提交就开始子副作用，或可观察历史工具事务未闭合。
3. 状态/通知/压缩进入错误分支，重启丢失已确认游标或归档。
4. 重投产生重复模型背景/费用，恢复自动重放副作用。
5. 有改动工作树被自动删，或未确认清理就释放资源与写锁。
6. Headless/零依赖退化，验证入口与 pnpm verify 的 typecheck → test → lint 不同源。

## 11. 结论与后续衔接

启动回执先闭合工具事务，子任务在运行时独立执行，结果通过耐久收件箱在正确分支的安全边界消费。角色提供预设，统一边界授权；完成事实、费用事实与产物分别可追踪。

当前只更新本设计与关联开发计划，仍为规划稿，尚无 v0.0.7 OpenSpec change。正式实施前将范围转成 proposal/specs/tasks，并以批准后的契约与验收矩阵执行。本次不修改版本、实现代码或发布状态，不包含 Git 提交/推送或付费 API 验证。
