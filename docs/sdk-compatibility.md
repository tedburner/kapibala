# Kapibala SDK 兼容性盘点

本版（v0.0.10，稳定整合版）对已发布公共面做了 9 处改动，涉及类型/接口种类、导入、并发默认值、客户端运行时结果形状与 runner 装配，**不能合称"完全兼容"**。逐条影响与迁移方式见下表，详细迁移动作见 [v0.0.10 迁移说明](migration/v0.0.10.md)，实测证据见 [验收记录](verification/v0.0.10.md)。

| 变化 | 影响 | 迁移方式 |
|---|---|---|
| `SessionConfig` 至少提供一个根字段，`interface` 改为联合 `type` | 缺少两字段的调用、接口继承/合并用法需要调整；`rootDir`-only 保持有效 | 优先 `workspaceRoot`；兼容 `rootDir`；扩展配置改用交集或 `SessionOptions` |
| 删除 `sharedWorkspaceLeaseCoordinator` 导出 | 导入旧单例的 SDK 代码需要调整 | 显式创建 `WorkspaceLeaseCoordinator` 并注入需要共享的会话 |
| 缺省协调器改为会话独占 | 独立 SDK 会话不再暗含全局串行关系 | 同一业务宿主持有并注入共享实例，见第 5 节 |
| `LocalClient.call()` 结果具体化 | 依赖宽泛结果进行不安全索引的调用可能需收窄类型 | 使用方法结果类型；cursor 快照按分块结果处理 |
| 显式 cursor 从误重组分支改为原始续块返回 | 运行时返回形状/失败路径变化，不能仅称为类型收窄 | 读取正文用无 cursor 调用；手动分页处理 chunk/cursor |
| attach 中途取消、重组或缓冲回放失败明确拒绝并关闭整个连接 | 同一连接的其他控制会话也会断线收口；不再允许异步 `close` 后仍返回快照 | 新建连接后按需重新 attach，不重发写任务；独立控制需求使用独立连接 |
| `SpawnContext` 必须携带协调器，runner 接收第三个运行上下文；CLI runner 工厂协调器必填 | 自定义 `prepareSpawn`/runner 装配及 CLI 工厂调用需更新 | 注入父 Session 实际实例，消费 runner 上下文，不序列化该实例 |
| `LocalTransport` 增加必填 `setLimits(limits: TransportLimits): void` | 自定义传输实现需支持握手后收紧帧与发送队列预算 | 导入公开 `TransportLimits`，修改实现；缺少能力时连接失败，不静默使用默认值 |
| 清理异常改用类型化 code | 部分原先退化为 `INTERNAL_ERROR` 的清理失败会细化到既有 `SESSION_CLEANUP_FAILED` | 调用方按既有业务码处理可重试关闭，不将取消请求失败理解为任务已停止 |

0.x 编号政策不是上述差异的免责理由：本版把每一处都作为公开差异登记，删除审查不因把符号改标为"内部"而绕过。

## v0.1.0 阶段 A 增量（已随 v0.1.0 发布）

以下变更建立在已发布 v0.0.10 之上；上文的 9 项描述保留为 v0.0.10 的历史迁移记录。当前声明快照和 migration.json 已包含本阶段，旧基线仍为固定 v0.0.9 tarball，不重建或覆盖旧证据。

| 新增或变化 | 调用边界与迁移 |
|---|---|
| CLI `@kiturone/kapibala-cli/host` 独立 ESM 与声明 | Node 20+ 可装配受管会话、订阅展示与修改配置；导入无启动副作用。Renderer 继续只依赖 `/view-model`，不能把 Node 服务直接暴露为 IPC |
| 受管装配的显式 `homeDirectory` 贯通 | 用户指令、日志、审计恢复与子代理会话现在统一落在传入的 home；旧 wire 适配器这些路径按 Core 默认回退真实 home。指令读取、AgentRuntime 与子代理能力并非本次新增，变化仅在自定义 homeDir 不再被这些路径忽略。wire 1.0 DTO 形状不变；依赖旧回退行为的自定义宿主必须显式传入 home |
| `SessionManagerOptions.projectRootMode`；`resolveSessionProject(cwd, mode)` | 默认 `git` 保留原桶；`exact` 固定 native realpath 根，共享宿主使用此模式。不迁移已有会话 |
| `HistoryReadOptions`、Manager 的 `maxReadBytes` 与 Store 的可选读取参数 | 不传保持原读取行为；预算为正安全整数；打开、元数据重建、旧历史导入、v1 升级和显式重载均限额。超限使用 `HISTORY_READ_LIMIT`，不是坏尾恢复 |
| `SessionMetadata.unavailableReason` | 超限条目可保留身份并显示不可打开；调用方不能把它当作空历史，或自动新建会话替代 |
| `PresentationStore.subscribeEvents` 与公共脱敏投影 | 每个被接受事件有序交付，原 `subscribe` 的合并通知不变；原始历史不因展示打码而重写 |
| `mutateGlobalSettings` 与 CLI 全部生产配置写入口 | 锁内重读和字段修改；竞争为 `SETTINGS_BUSY`，遗留锁仅人工核验。交互/网络不在锁内，损坏配置中止保存 |

新互斥仅覆盖采用该事务的新 CLI 和后续桌面版本；旧 CLI、外部编辑器及网络文件系统不受该锁约束。不要同时用旧 CLI 修改配置。已打开会话下次 run 刷新模型配置与凭证，保留当前 Profile ID 和角色；全局默认仅影响新建/重新打开的运行时会话。

验证过程与实际限制见 [阶段 A 验收记录](verification/v0.1.0-stage-a.md)。未完成 Node 20、Windows 或桌面签名包的人工证据不能由本机检查替代。

## v0.1.0 阶段 C 增量（已随 v0.1.0 发布）

CLI `/host` 新增导出类型 `ManagedInspection`；`ManagedHostSession` 新增 `inspection()` 和 `subscribeInspection()`，供 Node 宿主只读观察已知状态、Skill/MCP 诊断与直接子任务摘要。文本与条目限额、脱敏，不启动 MCP、不收集结果；原有 wire 1.0 形状和版本不变。自定义实现该新宿主接口的适配器需补齐这两个方法；现役 Core/CLI 调用方式不变。`status().runUsage` 只在所有已完成请求明确给出 usage 时提供，未知不再借默认 metrics 零伪装为实际用量。详见[阶段 C 验收](verification/v0.1.0-stage-c.md)。

本阶段另新增声明模块 `@kiturone/kapibala-cli` 的 `ui/runtime-errors.d.ts`（`describeRuntimeError`）：宿主侧把 core 运行时固定抛出的已知错误文案（如工具等待用户操作导致的暂停）映射为面向用户的可行动提示，未知错误回退脱敏原文；纯增补，不改变既有符号、wire 形状与错误码语义。桌面端同步补齐审批可达性：审批请求到达即自动弹出审批面板，`approval.closed` 通知带 `reason`（`resolved`/`timeout`/`aborted`），审批超时自动拒绝时前端给出明确中文诊断，不再让用户面对无入口的 `PERMISSION_DENIED` 死锁。

## v0.1.0 会话管理增量（已随 v0.1.0 发布）

桌面侧栏的行内操作带出五处公共面变化：Core 的 `SessionManager` 新增 `renameSession(id, title)`、`pinSession(id, pinned)`、`deleteSession(id)`（均自行取锁并在完成后释放），`SessionMetadata` 新增 `pinned`，`SessionRecordType` 增加 `pin_state`，`SessionStore` 新增 `setPinnedState(pinned)`，CLI `/host` 的 `ManagedHostSession` 新增必填成员 `rename(title)` 与 `setPinned(pinned)`，供宿主对已打开句柄原地写入。

`deleteSession` 是不可逆的物理删除（正文 + sidecar），只拒绝本进程持句柄或其它进程持锁的会话，不提供回收站；`pinSession` 只影响 `list()` 的分组次序，不写活动时间。自定义实现 `ManagedHostSession` 的适配器必须补齐新增的两个方法，否则 TypeScript 编译失败；wire 1.0 形状与版本不变，桌面 RPC 契约属客户端内部面，不构成对外承诺。

## 1. 盘点口径

- 覆盖范围：Core 根入口、MCP 根入口，以及 CLI 的 `protocol`、`client`、`view-model` 及 `host` 四个子路径。当前候选清单以 `scripts/fixtures/public-api/current.json` 为准，新增 `/host` 也列入声明扫描。
- 记录内容：导出名、导出种类、参数、返回值与被引用类型；声明从独立声明产物读取，不只扫描源码 `export` 行，保留 overload、可选性、联合类型与泛型约束原文。
- 旧基线：只取自固定 v0.0.9 发布 tarball 的 `dist`（`scripts/fixtures/public-api/v0.0.9/`，含原始 package.json、tar 清单与声明），候选声明输出到临时目录后单独保存（`current.json`）。禁止用候选源码反向重建旧基线。
- fixture 内不含任何用户凭证；比较前对输出排序并规范换行。
- 差异登记：`scripts/fixtures/public-api/migration.json` 记录相对 v0.0.9 的 added / removed / changed 集合，`sdk-compatibility` 文档与本表以其为唯一真源。

命令：

```sh
pnpm check-public-api                     # 只读比较，CI 门禁
tsx scripts/check-public-api.ts --update  # 人工审阅候选差异后显式刷新基线
```

普通 CI 不写回基线；`--update` 必须在确认公共面变化已被解释、迁移文档已同步后由人工执行。

## 2. 导出差异清单

**移除（1 项）**

- `@kiturone/kapibala`：`sharedWorkspaceLeaseCoordinator`。旧代码改为显式 `new WorkspaceLeaseCoordinator()` 并按宿主注入。

**新增（23 项）**

- Core：`SessionErrorCode`、`SessionOptions`、`SubagentRunnerContext`、`createSessionError`。
- CLI `client` 子路径：`TransportLimits`。
- CLI `protocol` 子路径：`ClientResult`、`ClientSnapshot`、`InferWireSchema`、`ProtocolLimits`、`PublicHistoryBlock`、`PublicHistoryMessage`、`RESULT_SCHEMAS`、`RESULT_SELECTORS`、`RequestResults`、`SnapshotBody`、`SnapshotMetadata`、`SnapshotPage`、`WireResult`、`WireSnapshot`、`validateMethodResult`、`validateSnapshotBody`。
- 声明模块：`@kiturone/kapibala-cli` 的 `protocol/results.d.ts`、`local-host/errors.d.ts`。
- 新增均为纯增补，不改变既有符号签名语义；`SessionOptions` 是为让"扩展非根选项"有可写的接口面而拆出的类型。

**签名或形状变化（11 项）**

- Core：`SessionConfig`（interface → 交集联合 type）、`SpawnContext`（新增必填 `leaseCoordinator`）、`SubagentSessionRunner`（第三参数 `SubagentRunnerContext`）、`ToolContext`（提供只读 `leaseCoordinator` 引用）、`AgentRuntime`（runner 调用带上下文，内部引用按 agentId 只在内存持有）。
- CLI `client`：`LocalClient`（`call` 结果按方法与参数具体化）、`LocalTransport`（新增必填 `setLimits`）。
- CLI `protocol`：`WireSchema`、`REQUEST_SCHEMAS`、`EVENT_PAYLOAD_SCHEMAS`、`APPROVAL_RESPONSE_SCHEMA` 及新增的结果 Schema 面（`RESULT_SCHEMAS` / `RESULT_SELECTORS`）。

## 3. `./dist/*` 与入口可达性

CLI 包保留既有 `./dist/*` 导出模式，但不把通配模式本身当成"已枚举"：以 v0.0.9 tarball 中实际匹配的文件为有限集合，逐个比较具体导入地址、模块格式（ESM/CJS）、声明可达性与导出清单；JS、`.d.ts` 与静态资源分别比较存在性和可访问性。候选文件集合的**增加与删除都显式报告**，声明可用入口再比较签名。原始清单允许保留 `.map` 等构建资源，但不因此把它们列为推荐代码 API。

本版不做整体 barrel 重构，也不新增 npm 包；发布仍是 `@kiturone/kapibala`、`@kiturone/kapibala-cli`、`@kiturone/kapibala-mcp` 三个包。

## 4. 导入副作用与可执行入口

- 库入口在隔离进程检查导入副作用：`@kiturone/kapibala-cli/client`、`/protocol`、`/view-model`、`/host` 导入本身不启动 CLI、不注册进程监听器、不读写终端。`protocol` 与 `view-model` 是浏览器安全子路径，构建产物不得引用 `node:` 模块（平台门禁静态扫描 bundle）。
- 可执行入口 `kpbl`（`dist/bin.js`）单独验证路径、`--version` 与 `--help` 输出，不在检查主进程 import bin，因此不对库入口强加"无启动副作用"的等价要求。
- ESM `import` 与 CJS `require` 两条解析路径都从隔离安装目录验证，Core 运行时依赖数必须为 0。

## 5. 并发与租约语义

不兼容点集中在并发默认值：会话缺省持有独占 `WorkspaceLeaseCoordinator`，共享只发生在显式注入同一实例时。

| 所有者 | 创建位置与存续期 | 共享范围 |
|---|---|---|
| 独立 SDK Session | 构造会话时；随会话持有 | 缺省仅自身 |
| 直接 CLI 宿主 | 创建运行时及会话工厂之前 | 本宿主创建的根会话、切换会话与所有后代 |
| daemon 资源工厂 | `createResourceFactory()` 调用内 | 该工厂装配的 Session 与子代理 |
| SDK 自建宿主 | 由调用者显式创建和管理 | 调用者指定的相关会话 |

自定义 runner 通过第三个参数取得父协调器：`SubagentSessionRunner(record, signal, context)` 的 `context.leaseCoordinator` 必须注入子会话。旧二参数回调在 TypeScript 结构上仍可能兼容，但忽略第三参数不会自动共享租约——库无法证明任意自定义回调内部遵守约定，因此提供可编译示例 [examples/shared-lease.ts](../examples/shared-lease.ts)，并以缺失 `SpawnContext`/CLI 工厂参数的编译失败用例、绕过类型时的零副作用 `CONFIG_INVALID` 拒绝测试收口。

## 6. 示例与类型检查

`examples/**/*` 已进入 `pnpm typecheck`（`tsconfig.check.json`）覆盖范围，本版示例覆盖四类装配：最小会话 [minimal.ts](../examples/minimal.ts)、共享租约 [shared-lease.ts](../examples/shared-lease.ts)、受控取消 [controlled-cancel.ts](../examples/controlled-cancel.ts)、本地客户端 [local-client.ts](../examples/local-client.ts)。示例演示公共面用法，不构成"已用真实模型验收"的证据；安装产物层面的入口执行由 `pnpm verify:platform` 与 `pnpm verify:compat` 承担。

## 7. 本版不承诺

- 不承诺任意历史 0.x 版本间的运行时兼容；比较基线固定为 v0.0.9 发布 tarball。
- 不承诺未登记的隐式行为不变（例如审批展示字段、日志文案、错误 message 原文）。错误对外只保证稳定 code 与安全文案。
- 不提供跨连接事件重放，不提供 TCP/HTTP/WebSocket 监听；`--runtime-dir` 只接受本机 socket/pipe 目录。
- 未取得的平台与长时验收项在 [验收记录](verification/v0.0.10.md) 中保持 pending，不因本文档存在而视为通过。

桌面阶段 B 为 CLI `/host` 增补 `ManagedHostSession.configuration()` 的只读当前选择（Profile ID、角色和权限模式），以及 `resolveBaseURL`、`API_KEY_ENV_NONE` 的共享设置出口。端点环境覆盖与免鉴权标识继续使用 CLI 的唯一实现；不导出原始 Session、Provider 或凭证值。该变化不改变 wire 1.0。
