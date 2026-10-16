# Design: v0.0.7 会话增强与多智能体

## Context

在 v0.0.6 交付之后，Core 保持了良好的 Headless 架构。然而 Core 内部的 `AgentSession`、`SessionManager` 和 `ContextManager` 依然通过 `?? process.cwd()` 隐式回退到进程当前目录，且文件沙箱在模块层按 `rootDir` 缓存单例；同时，会话持久化格式（schema v1）以物理顺序强制校验 `parentId`，无法安全进行树形分叉。
针对复杂业务探索，用户已明确要求：**子代理后台执行，父代理可以继续工作并接收完成通知**。
本设计在不破坏既有六大领域分层、严格历史闭合和 Headless 约束的前提下，确立具体技术方案。完整技术论证与平台证据引用自 [docs/superpowers/specs/2026-10-15-v0-0-7-session-multi-agent-design.md](../../docs/superpowers/specs/2026-10-15-v0-0-7-session-multi-agent-design.md)。

## Goals / Non-Goals

**Goals:**
- **显式工作区参数化**：消除 Core 内所有隐式 `process.cwd()`，支持单进程内多工作区并发隔离；支持工作区写租约与 Git Worktree 隔离。
- **Schema v2 因果与物理分离**：以单文件 JSONL 实现单父节点因果树，分离 `logRevision`、`branchLeafId` 和 `contentRevision`；v1 会话只读浏览，写时生成 v2 副本，不改原件。
- **持久分支与上下文保护**：仅在已闭合完整交互边界切换分支；`branchWithSummary` 捕获废弃分支总结；`forkSession` 导出独立会话。
- **跨项目全文检索与逻辑归档**：`CrossProjectSessionCatalog` 结合 sidecar 增量流式扫描全文，支持分词、引号短语与有界正则；`archive_state` 逻辑归档，使用中拒绝。
- **受控后台多智能体运行时（AgentRuntime）**：子代理运行标准 `AgentSession` 复用核心循环；启动回执即时闭合父工具事务；四大工具受控管理；深度熔断与权限收紧；至少一次 Outbox/Inbox 可靠通知。

**Non-Goals:**
- 不引入 OS 级任意 Shell 沙箱或跨网络远程/分布式 Agent。
- 不引入图形化 DAG 树渲染或会话图编辑器（留待 v0.0.8 TUI 与 v0.1.1 桌面端）。
- 不引入向量数据库或 Embedding 检索模型，保持纯轻量分词与正则。
- 不引入半工具事务切分或自动代码合并，代码审核裁决权由父代理保留。

## Decisions

### 1. 显式工作区身份与实例沙箱（vs 全局进程状态与单例沙箱）
- **决定**：`SessionConfig`、`SessionManager`、`ContextManager` 强制要求传入 `workspaceRoot` 与 `executionCwd`（经 `fs.realpathSync.native` 规范化），缺失直接抛错 `WORKSPACE_ROOT_REQUIRED`，禁止 `process.chdir()`。每个会话独占持有 `PathSandbox` 实例。
- **理由**：Node.js 单线程事件循环中，并发异步会话如果依赖全局 `process.cwd()` 必然引发竞态与跨目录越权。
- **替代方案弃用**：模块级单例缓存 Map 在会话销毁时难以清理，且无法应对同路径不同会话生命周期的隔离需求。

### 2. Schema v2 物理序号与因果指针分离（vs 直接篡改 v1 parentId）
- **决定**：新写文件采用 `schemaVersion: 2`。记录包含物理前驱 `seq`/`prevRecordId` 与逻辑因果 `parentId`/`branchId`。全局控制记录（如分支切换、归档标记）`parentId` 设为 null，不推进上下文叶子。
- **理由**：v1 校验强依赖 `parentId === previous.recordId`，直接改变指针会导致旧读取器崩溃或将分叉当成文件损坏。物理序列与因果树分离后，单写者校验和分支跳转两全其美。
- **替代方案弃用**：多文件分支目录（如 Git 结构）会大幅增加文件句柄和崩溃恢复复杂度；保持单文件 JSONL 配合因果指针是工程上最简且抗崩溃的方案。

### 3. v1 会话只读浏览与副本升级（vs 原地就地修改 v1）
- **决定**：系统支持直接读取并浏览 v1 会话。但一旦在该会话上发起新的写操作或分支，系统会在取得源锁后创建带有 `upgradeIdentity` 的全新 v2 会话副本，原 v1 文件永久保留不变。
- **理由**：保证旧版本客户端向后兼容，绝对杜绝升级过程截断或损坏用户珍贵的历史会话。

### 4. 子代理后台执行与受理回执闭合（vs 同步阻塞或悬挂 Promise）
- **决定**：`spawn_agent` 执行时，完成参数与容量校验后，向父会话持久化受理回执，立刻返回 `agentId` 闭合该轮工具事务。子代理在 `AgentRuntime` 内作为独立受管任务在后台推进。
- **理由**：符合用户明确要求；同时满足“历史必须闭合”不变量，父代理可以立即继续与用户交互，而无需将整轮对话阻塞在长耗时的子任务上。

### 5. 权限逐轴求交与绝对深度熔断（vs 权限放大或任意委派）
- **决定**：`deriveChildPolicy` 接收父有效快照、角色预设与显式收紧请求，在工具、文件、执行、网络、工作区与预算上逐轴求交。父 `deny` 强制继承。深度追踪 `depth`（根为 0），当 `depth >= maxSpawnDepth`（默认 3）时，工具池彻底剥离 `spawn_agent`。
- **理由**：恪守“Delegation moves work, never authority”原则，在注册表层根绝代理递归死循环。

### 6. 耐久 Outbox/Inbox 投递与分支安全调度（vs 纯内存 EventBus 或跨分支强插）
- **决定**：子代理终态持久化写入 Outbox，父协调器在来源分支的空闲边界（或同 `rootTaskId` 任务边界）通过 Inbox 接收并落盘。
- **理由**：内存事件总线在进程退出时丢失未消费结果；跨分支强插会破坏用户当前正在进行的其它分支思路。

## Risks / Trade-offs

- **[并发写入竞争]** → 父子任务同时需要写工作区时，要求宿主提供 Git Worktree 或通过工作区写租约排队串行化。
- **[脏工作区无法隔离]** → 若父工作区存在未提交内容，启动 Worktree 隔离直接以 `WORKTREE_DIRTY_BASE` 拒绝，绝不擅自 commit/stash 用户代码。
- **[子代理失控消耗 Token]** → 为子代理施加每子任务最大步数（默认 15）与 Token 预算硬熔断；所有子代理消耗记入统一账本并入父会话。
- **[长时间运行后代任务退出孤儿残留]** → 级联取消与退出清理机制：父会话或宿主退出时，向所有活动子树发送广播，并在 Windows/POSIX 下调用进程树回收守卫。

## Migration Plan

1. **工作区参数迁移**：CLI 入口完成项目根发现并显式传入；SDK 废弃无参构造，提供清晰的 `WORKSPACE_ROOT_REQUIRED` 诊断。
2. **会话数据迁移**：旧 v1 会话完整保留，无缝支持只读查看；用户在旧会话发起续答或分支时，系统自动无感生成 v2 升级副本。
3. **回滚策略**：若新版出现严重缺陷，用户切回 v0.0.6 仍可正常读取所有旧 v1 会话，v2 会话在旧版中明确标为未知版本拒绝，不发生静默数据覆写。
