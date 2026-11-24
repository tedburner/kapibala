# AGENTS.md — `@kiturone/kapibala` (Core) 约束

- **历史必须闭合**：assistant 的 `tool_use` 一旦进入历史，对应 `tool_result` 必须紧跟其后（设计文档 §4.3 / §4.4）。loop 内任何 `break` / `throw` 必须发生在该不变量满足之后。
- 落盘是**消息级**：user / assistant / tool_result 三类消息都要经 `MessageStore.append` 落盘。
- **会话控制记录要三处同步、两处重建**：新增全局控制记录类型（如 `archive_state` / `pin_state` / `watch_state`）时，必须同时改 `SessionRecordType` 联合、`SessionStore` 内的类型集合与 `isGlobalControlRecordType`，并在**两份**元数据重建实现里处理——`SessionManager.buildMetadata` 与 `CrossProjectSessionCatalog` 的内联扫描。漏掉任一份，sidecar 重建会静默丢失该状态（`archived`、`pinned` 各踩中过一次）。控制记录不推进上下文叶子，也不改变正文活动时间。
- **工作区身份必须显式传入**：`AgentSession` 构造必须给出绝对 `workspaceRoot`，兼容仅提供绝对 `rootDir` 的旧输入；两者至少有一项（都缺失抛 `WORKSPACE_ROOT_REQUIRED`），同时提供但物理身份冲突时拒绝。`packages/core/src` 严禁读取 `process.cwd()`（架构门禁拦截）；沙箱与写租约（`WorkspaceLeaseCoordinator`）按会话持有，不做全局单例。
- 消费者提前结束事件迭代时，必须取消并等待在途工具清理、闭合并落盘工具事务后再释放 Session 锁；已完成的工具保留真实结果。
- **Core 必须保持 Headless**：`packages/core/src` 不得依赖 CLI、直接读写终端或包含 ANSI/UI 渲染；所有宿主通过 `AgentSession` / `SessionEvent` 复用同一 Agent Harness。`pnpm check-architecture` 已并入 lint，新增宿主能力不得绕过该门禁。
- v0.0.3 已定义**失败轮次、连续同角色消息与完整工具事务**的 canonical 规范化规则；原历史独立于模型投影，恢复缺失结果记录为 OUTCOME_UNKNOWN，不重放工具。该合法序列已由 v0.0.4 的原生 Anthropic / OpenAI Responses Provider 与 Chat 兼容层共同消费，新协议接入继续遵循。
