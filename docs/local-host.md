# 本地宿主与连接模式

v0.0.9 新增能力，v0.0.10 冻结其契约（协议仍为 1.0，客户端结果类型与恢复单位为整个连接）。从仓库使用时先在根目录执行 `pnpm dev:build`；安装发布版后可直接使用 `kpbl`，或 `npx @kiturone/kapibala-cli@0.0.9`。Core、CLI、MCP 仍是三个发布包，协议与客户端通过 CLI 子路径导出。

## 使用

```sh
node packages/cli/dist/bin.js daemon start
node packages/cli/dist/bin.js daemon status
node packages/cli/dist/bin.js connect --workspace /absolute/project
node packages/cli/dist/bin.js connect --workspace /absolute/project -p "解释项目结构"
node packages/cli/dist/bin.js connect --workspace /absolute/project --resume <conversation-id>
node packages/cli/dist/bin.js daemon stop
```

完成安装后可将上述 `node packages/cli/dist/bin.js` 换为 `kpbl`。`serve --stdio` 供父进程通过 JSONL 托管，不接受普通文本输入。`--runtime-dir` 为隔离验收提供目录，不接受 TCP、HTTP 或 WebSocket 地址。

直接 `kpbl` 仍使用原有本进程 CLI。连接模式支持文本任务、`/status`（会话、运行与配额）、`/history`（列出会话）、`/close`（释放当前会话）与 `/exit`；通过 `--resume` 打开历史会话。模型、模式、技能配置等高级 Slash 操作继续通过直接 CLI 完成。Ctrl+C 取消当前任务；审批时取消同时取消运行。非 TTY 必须传入 `--prompt`，所有人工审批默认取消。一次性 `connect -p` 结束时会自动关闭本次创建的会话，连续运行不会耗尽配额。

每个会话只有一个控制连接，可以有多个观察连接。控制端断线会取消运行和该容器后台子代理，等待清理后才允许重新接管；不自动继续无人值守写操作。交互连接退出时保留 idle 会话供重连，最多 8 个打开会话；用 `/close` 或 SDK 的 `session/close` 显式回收，配额状态可在 `/status` 查看。重连不会自动重新发送任务。

## 配置与授权

宿主按每个工作区独立加载现有 settings、模型、技能和 MCP，活动会话不热更新。缺密钥或项目尚未信任时返回 `CONFIG_REQUIRED` / `TRUST_REQUIRED`，先用直接 CLI 完成配置。RPC 不提供密钥写入或项目授权功能。

MCP 在第一次受控运行时挂载，启动审批与工具审批分开。审批提示只展示可解释的目标：文件路径、绑定后的 shell 范围、`spawn_agent` / `wait_agent` / `cancel_agent` 的角色与任务摘要、`load_skill` 名称、MCP 启动服务的名称/来源/传输/目标，以及 MCP 工具的白名单定位字段（如 `path`、`query`）。Shell 审批显示执行器绑定的完整命令、工作目录和解释器，换行、制表符及终端控制字符以可见转义表示；字段超出预算或脱敏后无法完整说明执行目标时拒绝审批，不截断后放行。完整子代理 prompt、MCP 启动参数列表、env 与未列入白名单的 MCP 工具参数不会进入审批通道。含敏感词或无法安全说明的未知工具直接拒绝，不要求盲批。五种审批结果继续由 Core 的精确范围缓存裁决。

会话历史、标题与审批提示共用同一套文本出口：当前配置的模型密钥会被替换，`token=`、`password=`、`Authorization`、Bearer、常见令牌前缀与 URL userinfo 等可识别凭据模式也会被打码。无法识别的任意无标签秘密不承诺全量扫描，用户仍需避免把凭据粘贴进对话或命令。

宿主显式共享工作区写租约：一个宿主（直接 CLI、daemon 资源工厂或 stdio 父进程）持有一个 `WorkspaceLeaseCoordinator` 实例并注入其装配的每个会话与子代理；会话不再隐式共享进程级单例，缺省为独占。独立 CLI 与 daemon 的不同 conversation 不具备跨进程工作区互斥，避免同时写同一项目。相同 conversation 的现有存储锁仍生效。

## 协议、预算与恢复

协议是 JSON-RPC 2.0，版本 1.0 独立于产品版本；本版冻结该契约，方法、事件、结果 Schema 与错误分类的完整参考见 [本地宿主协议 1.0](local-protocol.md)。socket/pipe 使用私有凭证握手，token 不在 argv、日志或历史中。协议数据类型从 `@kiturone/kapibala-cli/protocol` 导入；Node 客户端和本地 socket 连接从 `@kiturone/kapibala-cli/client` 导入，导入本身不启动 CLI。

初始化时客户端在 `capabilities` 中声明本次依赖的能力；v1 支持 `sessions`、`approval`、`cancel`，任一能力不被支持都返回 `PROTOCOL_MISMATCH`，不做静默降级。服务端返回的 `limits` 必须为全部正值整数，且关键预算不得放大客户端自身的硬上限。

单帧 1MiB，初始化 5 秒，最多 16 连接、每连接 64 个在途请求、8 个打开会话、4 个活动运行，每会话最多 128 个待审批。审批 120 秒到期。每连接快照总预算 8MiB；发送队列 4MiB。慢连接被断开，不能静默丢事件后继续应用。

快照按同一修订的 64Ki UTF-16 码元块传送，客户端完整收集后再应用后续事件；大消息不会被静默截断。快照包含已完成历史、活动尾部、运行状态与待审批摘要，按编码字节整体计量，没有按消息条数的分页参数。每连接快照总预算 8MiB，超限明确 `RESOURCE_LIMIT`。活动尾部独立有界，超限取消运行并要求重同步。本版不提供跨连接事件重放；游标过期或实例代际不符返回 `RESYNC_REQUIRED`，需重新 attach 获取完整快照。历史仍以 canonical store 为真源，不保留跨连接重放所需的事件环。SDK 侧读取正文使用无 cursor 的 `session/attach` / `session/snapshot`（返回完整重组结果），手动分页才处理 `{ chunk, cursor }` 原始续块。

恢复单位是整个连接：已附着会话出现真正的序号缺口，或 attach 的重组与缓冲回放失败，`LocalClient` 会取消并关闭传输、拒绝全部 pending、撤销在途审批回调，该连接上其它会话同时失效。上层需新建连接、重新握手后再按需 attach，不自动重发写任务；需要独立控制面的场景使用独立连接。

会话清理未收敛时返回 `SESSION_CLEANUP_FAILED` 并保留存储锁，可重试关闭；`run/cancel` 只表示取消意图已传达，终态以 `run_settled` 为准。
每会话最多记录 1024 个已接收 `clientOperationId`，存活期间不淘汰；同 ID/同参数复用结果，不同参数拒绝。满后拒绝新操作；关闭重新打开会生成新 streamEpoch，旧代际请求无效。客户端超时不能证明服务端没有执行，禁止盲目重试写任务。

daemon 运行目录默认是本机临时目录下的用户私有短路径，子进程 stderr 写入同目录的 0600 私有日志；`daemon status` 返回日志路径，并区分无实例、锁残留、元数据损坏、不可达与运行中。启动锁或元数据残留且无法完成实例握手时，启动会安全失败，不根据 PID 自动杀进程或删除 socket。需要检查目录和实际进程后手动处置陈旧文件；不要在活跃实例上删除运行目录。关闭清理失败不会报告干净停止。运行时或会话清理失败时保留存储锁；会话资源释放可重试，清理完成后才允许其它写者重新打开。运行迭代结束但 Core 仍忙时会报告失败并拒绝新运行，不以 settled 事件代表存储锁已释放。

已验证范围与仍未取得的平台门禁见 [验收记录](verification/v0.0.10.md)，协议细节见 [本地宿主协议 1.0](local-protocol.md)，公开差异见 [SDK 兼容性说明](sdk-compatibility.md)。
