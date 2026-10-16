# Tasks: v0.0.7 会话增强与多智能体

状态：所有 checkbox 为待执行的实施/验证任务。详见 [开发计划](../../docs/superpowers/specs/2026-10-15-v0-0-7-development-plan.md) 和 [技术设计](../../docs/superpowers/specs/2026-10-15-v0-0-7-session-multi-agent-design.md)。按组依赖顺序推进；每项含完成证据，功能与本组测试/注释同步交付。

## 1. 工作区身份与路径规范化（里程碑 A）

- [x] 1.1 明确 workspaceRoot、executionCwd、projectKey 与构造验证；定义 rootDir 兼容别名与冲突检测，CLI 捕获启动目录，移除 Core Session/SessionManager/ContextManager 中隐式 process.cwd() 与 '.' 兜底。
- [x] 1.2 复用 native 项目身份算法并覆盖 Windows 短路径与大小写；编写单元测试验证缺少参数报错（WORKSPACE_ROOT_REQUIRED）与真实物理路径规范化。

## 2. 会话级沙箱、写租约与架构门禁（里程碑 A）

- [x] 2.1 重构 PathSandbox 为 AgentSession 会话持有实例，废除全局模块级单例缓存；ToolContext 提供显式根与执行目录，统一文件工具与 ShellScope 身份。
- [x] 2.2 实现共享工作区写租约，覆盖文件工具、Shell 与声明写能力的外部 MCP 调用，定义取消和清理后安全释放。
- [x] 2.3 扩展 scripts/check-core-boundary.ts 门禁，静态检测并禁止 packages/core/src 内部隐式 process.cwd() 调用；编写多工作区并发隔离单测。

## 3. ChildGrant 权限求交与角色路由（里程碑 A）

- [x] 3.1 实现 deriveChildPolicy 纯函数，接收父有效策略快照与 ChildGrant，在工具、文件、执行、网络、工作区与预算上逐轴求交。
- [x] 3.2 建立角色预设（explore、planner、implement、advisor、custom）单一真源并绑定场景模型路由（fast、planning、execution），Plan 模式绝对拦截 agent:spawn。
- [x] 3.3 编写权限求交与审批隔离单元测试，断言祖先 deny 并集继承、只读角色限制及隐藏名伪造拦截。

## 4. Schema v2 日志格式与 v1 副本升级（里程碑 B）

- [x] 4.1 在 SessionStore 中实现 Schema v2 记录 Envelope，分离物理 seq/prevRecordId 与因果 parentId/branchId，支持全局控制记录（parentId 为 null）。
- [x] 4.2 调整 SessionManager 目录发现与 sidecar 增量校验，基于 prevRecordId 校验物理连续性，实现三大 revision（logRevision、branchLeafId、contentRevision）解耦。
- [x] 4.3 实现 v1 历史只读浏览与保留原文件的 v2 副本升级机制（upgradeIdentity），单测覆盖升级断言与旧格式只读保护。

## 5. 持久分支切换与投影回溯（里程碑 B）

- [x] 5.1 实现 branch 创建与 selectBranch 分支选择，耐久落盘 branch_created/branch_selected 事件并原子推进 activeLeafId。
- [x] 5.2 实现 buildSessionProjection 回溯算法，沿 parentId 链生成合法线性消息投影，校验完整交互边界与工具闭合，拒绝半事务分叉。
- [x] 5.3 编写分支切换与崩溃重放单元测试，断言多分支状态独立与坏引用拒绝。

## 6. 分支摘要与独立会话导出（里程碑 B）

- [x] 6.1 实现 branchWithSummary，记录原叶子、目标边界与共同祖先，生成并追加 branch_summary 记录作为新分支背景。
- [x] 6.2 实现 forkSession，从有效活动路径导出生成全新独立会话文件，Header 记录来源关联与 forkPointRecordId。
- [x] 6.3 编写摘要捕获与 fork 导出测试，断言失败不移动游标、独立会话状态隔离与 Token 账本不重复计费。

## 7. 后台运行时与启动事务（里程碑 C）

- [x] 7.1 实现 AgentRuntime 任务树调度器，管理子代理状态机（preparing → accepted → running → waiting_children → completed）。
- [x] 7.2 实现 spawn_agent 工具执行与受理落盘，回填 agentId 即刻闭合父工具事务，父代理继续工作。
- [x] 7.3 实现 waiting_children 状态等待机制，子主轮结束时有未结束后代继续占槽并有界等待收口，编写启动事务闭合测试。

## 8. 可靠通知投递与收件箱（里程碑 C）

- [x] 8.1 实现 SubagentOutbox，子终态耐久保存 eventId 与执行结果，支持至少一次投递与重试。
- [x] 8.2 实现 SessionInbox 与父协调器消费逻辑，以 deliveryId 去重并作为带来源背景消息持久化入父历史。
- [x] 8.3 编写投递与崩溃重投测试，断言不重复注入消息、不追加第二个启动结果。

## 9. 任务协调、唤醒与安全调度（里程碑 C）

- [x] 9.1 实现 SessionCoordinator，管理父会话与后台任务并发互斥；当前 run 只消费同 rootTaskId 通知，旧通知待空闲独立调度。
- [x] 9.2 实现分支安全调度：仅在来源分支空闲时消费通知，异分支提供挂起提示而不自动切换或强插。
- [x] 9.3 编写调度竞争与分支隔离测试，验证用户输入优先与异分支不乱插。

## 10. 限额管理、Token 账本与审批冒泡（里程碑 C）

- [x] 10.1 实现原子容量槽位预留（活动槽 4、运行时 8、累计 16、步数 15、墙钟 5 分钟），超额立即拒绝。
- [x] 10.2 实现 Token 账本去重聚合，区分 ownUsage、descendantUsage 与 summaryUsage，汇总入父会话。
- [x] 10.3 实现 FIFO 可取消审批队列，子代理危险工具审批冒泡至父终端；深度达到上限强制剔除 spawn_agent。
- [x] 10.4 编写并发抢槽、深度熔断、账本去重与审批冒泡测试。

## 11. Worktree 物理隔离适配器（里程碑 C）

- [x] 11.1 实现 WorkspaceIsolation 适配器，支持 Git 独立工作树派生与独立 workspaceRoot 绑定。
- [x] 11.2 实现脏基线检测（父工作区有改动拒绝 WORKTREE_DIRTY_BASE），严禁未经授权自动 commit/stash。
- [x] 11.3 实现产物安全回收：检查 tracked/untracked/commit，有改动保留目录并报告 diff，无改动安全回收。
- [x] 11.4 编写 Worktree 派生、脏工作区阻断与产物保留测试。

## 12. 跨项目全文检索与逻辑归档（里程碑 D）

- [x] 12.1 实现 CrossProjectSessionCatalog，流式扫描 ~/.kapibala/sessions 全局目录与增量 sidecar 校验。
- [x] 12.2 实现有界全文搜索，支持分词、引号短语、字段限定与有界正则 worker 执行，返回结果与可续答边界。
- [x] 12.3 实现 archive_state 逻辑归档与恢复控制记录，活动中会话拒绝归档。
- [x] 12.4 编写跨项目扫描、中文短语检索、病态正则超时与归档隔离测试。

## 13. CLI 交互整合与命令扩展（里程碑 D）

- [x] 13.1 注册四大管理工具（spawn_agent、list_agents、wait_agent、cancel_agent）并声明 agent:spawn。
- [x] 13.2 扩展 CLI 命令：/history（--all / --search / --tree）、/branch、/fork、/archive 与 /agents。
- [x] 13.3 适配终端子代理紧凑状态行与 Ctrl+O 展开详情，秘密输入期间缓冲后台输出。
- [x] 13.4 编写 CLI 命令与输入协调测试。

## 14. 全量验证与发布准备（里程碑 D）

- [x] 14.1 运行真实多层进程回收测试（Windows taskkill 与 POSIX SIGKILL 进程组），证明无孤儿进程残留。
- [x] 14.2 运行 pnpm verify 与 pnpm dev:build 全量类型检查、测试与架构门禁。
- [x] 14.3 完成迁移文档 docs/migration/v0.0.7.md 与验收记录 docs/verification/v0.0.7.md。
