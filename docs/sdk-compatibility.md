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

## 1. 盘点口径

- 覆盖范围：Core 根入口、MCP 根入口，以及 CLI 的 `protocol`、`client`、`view-model` 三个子路径。当前候选清单为 core 310、mcp 124、`cli/protocol` 53、`cli/view-model` 22、`cli/client` 8 个导出符号。
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

- 库入口在隔离进程检查导入副作用：`@kiturone/kapibala-cli/client`、`/protocol`、`/view-model` 导入本身不启动 CLI、不注册进程监听器、不读写终端。`protocol` 与 `view-model` 是浏览器安全子路径，构建产物不得引用 `node:` 模块（平台门禁静态扫描 bundle）。
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
