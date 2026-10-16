# Proposal: v0.0.7 会话增强与多智能体

## Why

v0.0.6 已经交付受控 MCP 生态接入并保持 Core Headless 纯净性。随着单会话任务复杂度和并发度的提升，现有系统面临两大核心瓶颈：
1. **工作区状态与进程环境隐式耦合**：Core 内部多处 fallback 到全局 `process.cwd()`，且沙箱缓存为模块级单例，导致在同一 Node.js 进程内并发执行多工作区或子代理任务时存在相互串扰的竞态隐患，也阻碍了下游 v0.1.1 桌面端主进程并发托管多窗口会话。
2. **会话单线不可实验与缺乏跨项目检索**：现有会话存储为线性追加，缺少安全探索分支（DAG 分叉）与归档机制；历史会话局限在单项目内，跨项目检索缺失。
3. **单智能体上下文易膨胀与缺乏受控后台委派**：复杂探索与长任务会向主上下文灌入海量临时信息。用户已明确要求：**子代理后台执行，父代理可以继续工作并接收完成通知**。系统需要一个恪守“委派转移工作，绝不转移特权”的受控后台多智能体运行时。

## What Changes

- **工作区上下文彻底参数化**：显式注入 `workspaceRoot`、`executionCwd` 与 `projectKey`，Core 彻底消除对 `process.cwd()` 的隐式回退；`AgentSession` 独占持有 `PathSandbox` 实例；通过工作区写租约或临时 Git Worktree 隔离写入；扩展 `scripts/check-core-boundary.ts` 架构门禁。
- **会话 Schema v2 物理与因果分离**：采用单父节点树与单文件 JSONL，引入物理前驱 `seq`/`prevRecordId` 与逻辑因果 `parentId`/`branchId`；解耦 `logRevision`、`branchLeafId` 与 `contentRevision` 三大版本维度；v1 会话只读浏览，写操作生成带有 `upgradeIdentity` 的 v2 副本，不损坏原件。
- **持久分支与上下文保护**：支持在完整交互边界持久切换分支（`branch` / `selectBranch`）；提供 `branchWithSummary` 捕获被放弃分支的排错总结作为新分支背景；支持 `forkSession` 导出独立会话。
- **跨项目全文检索与逻辑归档**：实现 `CrossProjectSessionCatalog`，结合 sidecar 增量缓存流式扫描 `~/.kapibala/sessions/*`；支持分词、引号短语、字段过滤与有界正则；实现 `archive_state` 逻辑归档，使用中拒绝。
- **后台多智能体运行时（AgentRuntime）**：子代理运行标准 `AgentSession` 复用核心循环；`spawn_agent` 提交受理回执即刻闭合工具事务，子代理后台异步运行；支持 `list_agents`、`wait_agent`、`cancel_agent` 管理工具。
- **严格权限收紧与深度熔断**：`ChildGrant` 逐轴求交（父上界 ∩ 角色预设 ∩ 显式收紧），祖先 `deny` 强制并集，`Plan` 模式绝对拒绝；角色预设绑定场景模型路由（`explore` -> fast, `planner` -> planning, `implement` -> execution, `advisor` -> planning）；深度达到 `maxSpawnDepth`（默认 3）强制剔除 `spawn_agent`。
- **可靠通知与安全调度**：子终态通过持久 Outbox 至少一次投递，父唯一写者通过 Inbox 接收并以 `deliveryId` 去重；通知作为带来源的背景消息落盘；仅在来源分支与相同 `rootTaskId` 的安全边界消费，异分支仅做提示不强制唤醒。
- **CLI 整合与宿主协调**：扩展 `/history`（`--all` / `--search` / `--tree`）、`/branch`、`/fork`、`/archive` 与 `/agents` 命令；实现可取消 FIFO 审批冒泡队列与终端折叠展示。

## Capabilities

### New Capabilities

- `workspace-context-isolation`: 显式工作区参数化、会话独占沙箱、工作区写租约与 Git Worktree 隔离驱动。
- `session-v2-dag`: Schema v2 物理与因果分离、持久分支切换与 v1 副本升级。
- `session-branch-summary`: 分支摘要上下文捕获与独立物理会话导出。
- `session-catalog-search`: 跨项目全局目录流式全文检索与逻辑归档。
- `subagent-runtime-lifecycle`: AgentRuntime 任务树、受理事务闭合、后台执行、后代等待与级联取消。
- `subagent-child-grant`: ChildGrant 权限求交、角色预设与模型路由、深度熔断与审批冒泡。
- `subagent-reliable-notification`: 耐久 Outbox/Inbox 投递、消费去重落盘与分支安全调度。
- `cli-subagent-coordination`: 四大管理工具、CLI 命令扩展、审批 FIFO 队列与终端展示。

### Modified Capabilities

无。

## Impact

- **Core `context/`**：`session-store.ts`（v2 Envelope、三大 revision、分支控制事件）、`session-manager.ts`（项目身份、v1 升级副本、归档管理）、`manager.ts`（工作区根参数化、分支投影回溯）。
- **Core `runtime/`**：新增 `AgentRuntime`、`SessionCoordinator`、`SubagentOutbox` 与 `SessionInbox`；`loop` 与 `executor` 支持事务提交确认守卫。
- **Core `capabilities/`**：`permissions.ts`（`deriveChildPolicy` 逐轴求交）、`builtin/fs.ts`（会话沙箱持有）、`shell/tool.ts`（工作区根参数化）、新增受管多智能体工具集。
- **CLI**：`active-session.ts`（后台协调与保活）、`commands/`（新增与扩展命令）、`input-coordinator.ts`（FIFO 审批队列）。
- **工程与门禁**：`scripts/check-core-boundary.ts` 静态检查禁止 Core 隐式调用 `process.cwd()`。
- **详细论证与计划**：详见 [技术设计](../../docs/superpowers/specs/2026-10-15-v0-0-7-session-multi-agent-design.md) 与 [开发计划](../../docs/superpowers/specs/2026-10-15-v0-0-7-development-plan.md)。
