# Kapibala 本地宿主协议 1.0

协议版本 1.0 独立于产品版本：产品从 v0.0.9 升到 v0.0.10 不自动改变协议主版本。传输仍是 JSON-RPC 2.0 帧的 JSONL，承载方式为本机 stdio 管道或本机 socket（POSIX 为绝对路径 Unix socket，Windows 为 `\\.\pipe\kpbl-*` 命名管道），不提供 TCP、HTTP 或 WebSocket 监听。数据类型从 `@kiturone/kapibala-cli/protocol` 导入，Node 客户端与连接从 `/client` 导入；`protocol` 与 `view-model` 为浏览器安全子路径，产物不引用 `node:` 模块。

方法名是稳定白名单，任意 Slash 命令不会被翻译成 RPC。契约冻结在 `scripts/fixtures/protocol/v1.0/`，由 `pnpm check-protocol-contract` 只读比较；改动 wire 需人工执行 `tsx scripts/check-protocol-contract.ts --update` 并评估兼容影响。旧新产物四组合的真实进程比较见 `pnpm verify:compat`。

## 1. 握手与预算

1. 服务端接受连接后分配 `clientId`；客户端**第一条**请求必须是 `initialize`，5 秒内未完成握手即关闭连接。重复 `initialize` 直接 `UNAUTHORIZED`。
2. 服务端配置了 token 时，`initialize.params.token` 必须等长且时序安全比较通过；token 不进 argv、日志、历史或错误响应，凭证文件模式为 POSIX 0600、运行目录 0700。
3. 版本协商：`major` 必须等于 1，`minMinor ≤ 服务端 minor ≤ maxMinor`，服务端 minor 只取本机实现支持的交集。
4. 能力协商：`capabilities` 声明本次真正依赖的能力，当前集合为 `sessions`、`approval`、`cancel`。任一项不被支持都返回 `PROTOCOL_MISMATCH`，不做静默降级；未知能力拼写一律拒绝而不是忽略。
5. 服务端返回 `limits`（全部正值整数）。客户端校验任何字段都不得大于自身硬上限，随后调用 `LocalTransport.setLimits()` 在握手后同步收紧帧大小与发送队列；现存缓冲超限时传输关闭并抛错。缺少 `setLimits` 能力的自定义传输在连接期失败，不静默使用默认值。

`DEFAULT_LIMITS`（服务端下发即采用值）：

| 字段 | 值 | 含义 |
|---|---|---|
| `maxFrameBytes` | 1 MiB | 单帧上限 |
| `initializationTimeoutMs` | 5000 | 握手超时 |
| `maxInflightRequests` | 64 | 每连接在途请求 |
| `maxConnections` | 16 | 服务端连接数 |
| `maxOpenSessions` | 8 | 每宿主打开会话数 |
| `maxConcurrentRuns` | 4 | 并发运行数 |
| `maxPendingApprovals` | 128 | 每会话待审批数 |
| `maxSnapshotBytes` | 8 MiB | 每连接快照总预算 |
| `maxSendQueueBytes` | 4 MiB | 发送队列预算 |
| `maxOperationIds` | 1024 | 每会话记录的 `clientOperationId` 数 |
| `approvalTimeoutMs` | 120000 | 审批到期 |

慢连接（队列超预算）被断开，不允许静默丢事件后继续应用状态。

## 2. 方法

请求参数与成功结果都由 Schema 白名单校验；本地即可判定的非法参数不发送请求（返回 `INVALID_PARAMS`），连接仍可继续使用。

| 方法 | 参数 | 成功结果 |
|---|---|---|
| `initialize` | `ProtocolOffer`：`major`、`minMinor`、`maxMinor`、`clientName`、`capabilities`、可选 `token` | `NegotiatedProtocol & { serverInstanceId, clientId, limits }` |
| `ping` | `{}` | `{ alive: true, serverInstanceId }` |
| `session/list` | `workspaceRoot`（绝对路径）、可选 `cursor`、`limit`（1–50，默认 20） | `{ items: { conversationId, title }[], cursor: string \| null }` |
| `session/create` | `workspaceRoot`（绝对路径） | `{ sessionId, conversationId }` |
| `session/open` | `workspaceRoot`、`conversationId` | `{ sessionId, conversationId }` |
| `session/attach` | `sessionId`、`mode: 'control' \| 'observe'`、可选 `serverInstanceId` | 完整快照（`WireSnapshot`，客户端重组为 `ClientSnapshot`） |
| `session/snapshot` | `sessionId`、可选 `cursor` | 无 `cursor`：完整快照；带 `cursor`：`{ chunk, cursor }` 原始续块 |
| `session/detach` | `sessionId` | `{ detached: true }` |
| `session/close` | `SessionControl` | `{ closed: true }` |
| `run/start` | `SessionControl` + `clientOperationId`、`input` | `{ runId, accepted: true }` |
| `run/cancel` | `SessionControl` + `runId` | `{ cancellationRequested: true }` |
| `approval/request` | `ApprovalPrompt`（服务端 → 控制连接发起） | `{ choice: ApprovalChoice }` |
| `host/shutdown` | `{}` | `{ stopped: true }` |

`SessionControl = { sessionId, streamEpoch, controlEpoch }`。写类方法（`session/close`、`run/start`、`run/cancel`）只有当前控制连接可调用：观察或未 attach 的连接返回 `CONTROL_REQUIRED`，代际过期返回 `STALE_CONTROL`。宿主进入停机流程后除 `ping`、`host/shutdown` 外一律 `SHUTTING_DOWN`。

`session/list` 的标题来自首条用户消息，与历史、审批提示共用同一套凭据替换与单行化规则（打码后截断到 200 字符），不承诺识别任意无标签秘密。

## 3. 事件

事件以 notification `session/event` 单入口下发，`params` 为 `WireEvent`：`serverInstanceId`、`sessionId`、`streamEpoch`、`seq`、可选 `runId`、`type`、`payload`。`seq` 只在同一 instance/session/streamEpoch 内比较，不是跨进程全局时钟。payload 按类型逐项白名单校验，未知或私有事件不得推进客户端游标。

| `type` | `payload` |
|---|---|
| `text_delta` | `{ text }` |
| `thinking_delta` | `{ text, blockId? }` |
| `tool_start` | `{ toolId, toolName, target }` |
| `tool_progress` | `{ toolId, toolName, elapsedMs, outputBytes }` |
| `tool_finish` | `{ toolId, result, isError, truncated }` |
| `run_started` | `{ clientOperationId }` |
| `run_settled` | `{ outcome: 'completed' \| 'failed' \| 'cancelled' }` |
| `approval_closed` | `{ approvalId }` |
| `diagnostic` | `{ code, message }` |

## 4. 快照与游标

快照描述同一修订：已完成历史（`PublicHistoryMessage`，只保留展示投影字段）、活动尾部（同水位 `WireEvent`）、运行状态与待审批摘要，另含身份与配额字段 `openSessions` / `maxOpenSessions`。观察连接的 `controlEpoch` 为空，空流 `seq` 为零。

- 正文按编码字节整体计量，64 KiB UTF-16 码元分块；没有按消息条数的分页参数。跨块边界的高代理项在字节计量时正确回填，因此重组结果与单次编码一致。
- 无 `cursor` 调用（`session/attach` 或不带 cursor 的 `session/snapshot`）由 `LocalClient` 自动取完所有续块、校验 `SnapshotBody`、核对每条 `live` 事件的三元身份，再在一个同步段发布缺口回放并安装游标。任何失败都不安装半份状态。
- 显式 `cursor` 调用只返回原始 `{ chunk, cursor }` 续块，不做重组，也不关闭连接；读取正文请用无 cursor 的调用，手动分页才处理 chunk/cursor。
- 每连接快照总预算 8 MiB，超限 `RESOURCE_LIMIT`。活动尾部独立有界，超限取消运行并要求重同步。
- 完整正文按固定消息结构校验，不套用单帧的 JSON 节点数上限；每条活动事件仍独立通过 wire 校验，访问器、稀疏数组与额外字段继续拒绝。
- 本版不提供跨连接事件重放。游标过期、实例代际不符或 `serverInstanceId` 不匹配返回 `RESYNC_REQUIRED`，需要重新 attach 获取完整快照。canonical store 仍是历史真源。

## 5. 失败恢复单位

恢复单位是**整个连接**：已附着会话出现真正的序号缺口，或 attach 的重组/缓冲回放失败，`LocalClient` 会取消并关闭传输、拒绝全部 pending 请求、撤销在途审批回调，此后该客户端上所有调用都失败。

- 上层必须新建连接、重新 `initialize`，再为需要的会话显式 `attach`；不在已关闭连接上重试，不自动重发 `run/start`。同一连接上的其他控制会话也会因断线清理而失效，需要独立控制面的场景请使用独立连接。
- 重复 `seq` 仍被忽略；旧 instance/stream 的迟到事件不当作新流缺口。
- `async close()` 之后不会再返回快照；attach 失败路径不会让会话被本次连接占住。
- 客户端超时不能证明服务端没有执行，禁止盲目重试写任务。

## 6. 幂等与代际

`run/cancel` 仅对校验时仍匹配 `active.id` 的运行幂等。已完成、已取消结束、未知或属于旧运行的 ID 均返回 `RUN_NOT_FOUND`，即使会话仍记录该操作 ID 或仍需清理也不例外；它们不能取消新的 active run 或解除清理围栏。控制权与 epoch 先于 runId 校验。

每个会话最多记录 1024 个已接收 `clientOperationId`，存活期间不淘汰；同 ID 同参数复用既有结果（同一 `runId`，不产生新事件），同 ID 不同参数返回 `OPERATION_CONFLICT`，满额后拒绝新操作。关闭并重新打开会话会生成新的 `streamEpoch`，旧代际请求无效。`run/cancel` 只表示取消意图已传达，`cancellationRequested: true` 不代表进程或外部副作用已停止；终态以 `run_settled` 为准。

## 7. 审批

审批是服务端向**控制连接**发起的反向请求，`ApprovalPrompt` 携带 `approvalId`、`runId`、`toolName`、`target`、`sessionAllowed` 与 `expiresAt`。客户端可订阅 `approval/request`（`LocalClientOptions.approval`），缺省为 `cancel`：不能从模型输出自动推导允许。

- 五种选择与 Core 语义一致：`allow_once`、`allow_session`、`deny_once`、`deny_session`、`cancel`；客户端不能通过批准回复改写执行参数，执行身份由服务端保留。
- 展示只包含可解释目标：文件路径、绑定后的完整 shell 命令与工作目录/解释器、子代理角色与任务摘要、技能名、MCP 服务名称/来源/传输/目标，以及 MCP 工具白名单定位字段。含控制字符以可见转义表示；超出预算或脱敏后无法完整说明执行目标时拒绝审批，不截断后放行。
- 同一 `approvalId` 重复请求拒绝；每会话待审批超过协商预算返回 `RESOURCE_LIMIT`；到期或 `approval_closed` 会中止对应回调 signal 并按取消处理。观察连接可展示摘要但不能代替控制者回复。

## 8. 错误分类

`error.data.code` 是稳定业务分类，完整集合见 `WIRE_ERROR_CODES`：

| code | 含义与调用方动作 |
|---|---|
| `PROTOCOL_MISMATCH` | 版本或能力不被支持；调整 offer，不做降级重试 |
| `UNAUTHORIZED` | 缺少/错误凭证，或握手前调用其他方法 |
| `SESSION_BUSY` | 会话已被占用、正在恢复或锁持有者已变化；可稍后重试 |
| `CONTROL_REQUIRED` / `STALE_CONTROL` | 非控制连接调用写方法 / 代际过期；重新 attach 获取新代际 |
| `APPROVAL_EXPIRED` | 审批已过 `expiresAt` |
| `RESYNC_REQUIRED` | 游标、实例或活动尾部失效；重新 attach 取完整快照 |
| `RESOURCE_LIMIT` | 命中连接、在途、快照或审批预算 |
| `SHUTTING_DOWN` | 宿主停机中 |
| `TRUST_REQUIRED` / `CONFIG_REQUIRED` | 项目未信任或缺模型密钥，先用直接 CLI 完成配置 |
| `SESSION_NOT_FOUND` / `RUN_NOT_FOUND` | 标识不存在或前缀不唯一 |
| `OPERATION_CONFLICT` | 同 `clientOperationId` 携带不同参数 |
| `MCP_CONFIG_INVALID` | MCP 配置非法 |
| `WORKSPACE_ROOT_REQUIRED` | 未显式提供绝对工作区根 |
| `SESSION_CLEANUP_FAILED` | 会话仍在清理，可重试关闭；不代表任务已停止 |
| `INVALID_PARAMS` / `INVALID_REQUEST` / `METHOD_NOT_FOUND` / `PARSE_ERROR` / `INTERNAL_ERROR` | JSON-RPC 层错误，`INTERNAL_ERROR` 只用于未知内部异常 |

响应错误只暴露分类，不回显原始输入、凭证或堆栈。Core 的稳定 code 按固定映射收敛（如 `SESSION_LOCKED` → `SESSION_BUSY`、`CONFIG_INVALID` → `INVALID_PARAMS`），历史遗留的 message 前缀仅作为保守兜底，主路径不得依赖。

## 9. 生命周期与文件状态

`session/close` 在清理未收敛时返回 `SESSION_CLEANUP_FAILED` 并保留存储锁，清理完成后才允许其它写者重新打开；关闭清理失败不会报告"干净停止"。daemon 运行目录默认是本机临时目录下的用户私有短路径，`daemon.json` 与子进程 stderr 日志为 0600、目录 0700；`daemon status` 返回日志路径并区分无实例、锁残留、元数据损坏、不可达与运行中。启动时若锁或元数据残留且无法完成实例握手则安全失败，不根据 PID 自动杀进程或删除 socket；活跃实例上不要删除运行目录。

交互式连接退出保留 idle 会话供重连（上限 `maxOpenSessions`），用 `/close` 或 `session/close` 显式回收；一次性 `connect -p` 结束会自动回收本次创建的会话。控制连接断线会取消运行与该容器后台子代理，等待清理完成后才允许重新接管。

## 10. 相关门禁

```sh
pnpm check-protocol-contract   # wire 契约冻结比较（只读）
pnpm verify:compat             # v0.0.9 tarball 与候选构建的 4 组合 × 2 传输真实进程比较
pnpm verify:platform           # 当前 OS 真实进程：stdio、daemon 鉴权、进程树取消、MCP 生命周期、三包隔离安装
pnpm verify:soak               # 分档长时资源验收（PR 10 / nightly 100 / release 1000 且 ≥30 分钟）
```

已验证范围与仍未取得的平台门禁见 [验收记录](verification/v0.0.10.md)。
