# v0.0.9 Local Client Contract Implementation Plan

> **For agentic workers:** 使用 executing-plans 按任务顺序实施；用户未要求多代理实施，默认由当前会话逐项执行。每项实现和验证均以复选框跟踪。

**Goal:** 在现有 CLI 包内交付可靠的本地运行、事件、审批、取消和重连闭环。

**Architecture:** 保留 Core/CLI/MCP 三个发布包。CLI 内 protocol 定义纯 wire 边界，local-host 装配现有 Core，transport 提供 stdio/socket，client 关联请求并驱动既有 view-model。

**Tech Stack:** TypeScript、Node >=20、pnpm、Vitest、tsup、原生 node:net/stream/crypto；Core 零外部运行依赖。

**Spec:** [技术方案](../../design/002-v0.0.9-local-client-contract.md)；[OpenSpec](../../../openspec/changes/v0-0-9-local-client-contract/proposal.md)。

## Global Constraints

- 不新增 npm 包；协议版本 1.0 独立于工作区版本 0.0.8，不提前升级产品版本。
- protocol 无 Node/UI/Core 运行依赖；client 为无启动副作用的 Node 子路径；Core 不依赖 CLI。
- workspaceRoot 显式绝对路径、native realpath 身份；每会话独立配置/Provider/技能/MCP，宿主级租约显式注入。
- canonical tool_use/tool_result 闭合和落盘先于终态、锁释放；不自动重放工具或断线写任务。
- 所有新增导出和重要方法带中文 JSDoc；不自动 git add/commit/push，不修改设计基线章节。
- 数据上限、审批 120 秒与初始化 5 秒等数值以技术方案 §6/9 为准，集中定义并公布。
- fake Provider 用于确定性测试；真实 Windows/Linux/macOS 证据分别记录，不能互相代替。

## Review Focus

- 管道中断时仍有模型/工具在途：任务 7/9 验证清理收敛，不提前发终态。
- 同一路径的符号链接/Windows 短名：任务 4 验证归为同一工作区身份。
- 回复丢失后重复提交：任务 8/12 验证去重与重启后不自动重发。
- 多审批交错与慢连接：任务 6/10 验证准确关联，写背压不阻断读循环。
- 构建清理互相覆盖及独立安装：任务 3/14 验证全部子路径同时保留和无启动副作用。

## 文件与公共边界

新模块均位于 packages/cli/src，不建立新的工作区包。protocol/{types,schema,validate,version,errors,index}.ts 定义 wire 契约；transport/{jsonl,stdio,socket}.ts 负责字节流；local-host/{resources,registry,approval,run,events,server,daemon}.ts 分别持有单一生命周期职责；client/{local-client,index}.ts 为 Node 客户端。CLI connect 入口放 local-host/connect.ts，由既有 index.ts 的早期参数分流接入。实际发现同责既有模块时复用，不复制安全/设置逻辑。

P0 约定：WireRequest/Response/Notification 和 WireEvent 均是 JSON 安全判别联合；ValidationResult<T> 为 `{ok:true,value:T}|{ok:false,error:WireError}`。ProtocolOffer/NegotiatedProtocol 含 major/minor 能力与 limits。SessionRef 含 sessionId，SessionControl 另含 controlEpoch；RunRef 含 runId，RunInput 含 clientOperationId/input。Snapshot 含 instance/epoch/高水位与分页历史，Cursor 携带快照 revision。所有业务 DTO 在 protocol/types.ts 声明并被 schema 覆盖，禁止用 Record<string,unknown> 替代关键方法的参数定义。

宿主接口在 local-host/types.ts 声明：SessionResources 持有现有 AgentSession、ManagedSession、MCP 清理句柄和配置快照；HostContext 持有服务实例身份、预算、注册表、宿主级协调器与资源工厂；ConnectionContext 持有已验证客户端身份、发送函数和断开信号。LocalTransport 暴露消息异步迭代、send(message):Promise<void>、close():Promise<void>，在 transport/types.ts 声明，仅承担可靠有序传输，不授予工具权限。

---
### Task 1: 协议契约与错误目录

**Files:** packages/cli/创建 src/protocol/{types,schema,errors,index}.ts；测试 protocol.test.ts。

**Interfaces:** 定义上述所有业务 DTO、方法白名单和 JSON Schema；导出 PROTOCOL_VERSION、DEFAULT_LIMITS；技术方案 §4/6 的错误与全部数值集中定义。

- [x] Step 1：在 `packages/cli/tests/protocol.test.ts` 写行为测试，断言：序列化每个方法与事件后可还原；batch/undefined/循环对象不能成为合法 wire；DEFAULT_LIMITS.maxFrameBytes === 1048576；旧 instance/epoch 可判别。
- [x] Step 2：运行 `pnpm exec vitest run packages/cli/tests/protocol.test.ts`，确认因本项功能缺失而失败，排除环境/导入路径错误。
- [x] Step 3：实现上述文件与接口，保持中文 JSDoc、宿主资源边界和技术方案规定值；不扩大当前任务范围。
- [x] Step 4：重跑本项测试，期望全部通过；运行 `pnpm typecheck` 检查新接口及既有调用者。
- [x] Step 5：检查 diff 与测试证据，对应 OpenSpec task 仅在实现和证据完成后勾选；保留工作区供审核，不自动提交。

### Task 2: 边界校验与版本协商

**Files:** packages/cli/创建 src/protocol/{validate,version}.ts；扩展 protocol.test.ts。

**Interfaces:** validateRequest(value:unknown):ValidationResult<WireRequest>；validateResponse(value:unknown):ValidationResult<WireResponse>；negotiateProtocol(offer:ProtocolOffer):ValidationResult<NegotiatedProtocol>。服务端仅在认证成功后公布业务能力。

- [x] Step 1：在 `packages/cli/tests/protocol.test.ts` 写行为测试，断言：major 不匹配返回 PROTOCOL_MISMATCH；minor 无交集失败；字段错误、batch 与错误 choice 拒绝；合法可选字段缺省可用；未知事件不推进 applied seq。
- [x] Step 2：运行 `pnpm exec vitest run packages/cli/tests/protocol.test.ts`，确认因本项功能缺失而失败，排除环境/导入路径错误。
- [x] Step 3：实现上述文件与接口，保持中文 JSDoc、宿主资源边界和技术方案规定值；不扩大当前任务范围。
- [x] Step 4：重跑本项测试，期望全部通过；运行 `pnpm typecheck` 检查新接口及既有调用者。
- [x] Step 5：检查 diff 与测试证据，对应 OpenSpec task 仅在实现和证据完成后勾选；保留工作区供审核，不自动提交。

### Task 3: 子路径构建与依赖门禁

**Files:** packages/cli/修改 package.json、tsup.config.ts；创建 tsup.protocol.config.ts、tsconfig.protocol.json、scripts/check-local-boundary.ts；测试 protocol-boundary.test.ts。client 入口实现前仅预留构建设计，不导出不存在的文件。

**Interfaces:** protocol 参考 tsup.view-model.config.ts 独立 browser 构建；check-local-boundary 检查 protocol 的传递导入无 Node/Core/UI 与启动副作用；接入现有 lint/typecheck。

- [x] Step 1：在 `packages/cli/tests/protocol-boundary.test.ts` 写行为测试，断言：node:fs 违规 fixture 被门禁拒绝；先主构建后子构建不删除 view-model/protocol；构建声明不引用 Node 类型；打包后 protocol 可独立导入。
- [x] Step 2：运行 `pnpm exec vitest run packages/cli/tests/protocol-boundary.test.ts`，确认因本项功能缺失而失败，排除环境/导入路径错误。
- [x] Step 3：实现上述文件与接口，保持中文 JSDoc、宿主资源边界和技术方案规定值；不扩大当前任务范围。
- [x] Step 4：重跑本项测试，期望全部通过；运行 `pnpm typecheck` 检查新接口及既有调用者。
- [x] Step 5：检查 diff 与测试证据，对应 OpenSpec task 仅在实现和证据完成后勾选；保留工作区供审核，不自动提交。

### Task 4: 独立资源装配

**Files:** packages/cli/创建 src/local-host/{types,resources}.ts；参考现有 index.ts、settings.ts、session-startup.ts 与 MCP 接线；测试 local-host-resources.test.ts。

**Interfaces:** createSessionResources(workspaceRoot:string, conversationId:string|undefined, signal:AbortSignal):Promise<SessionResources>；工厂由 HostContext 注入宿主独立 WorkspaceLeaseCoordinator；返回资源须提供 dispose():Promise<void>。

- [x] Step 1：在 `packages/cli/tests/local-host-resources.test.ts` 写行为测试，断言：两个工作区配置不串扰、同工作区会话不共享 MCP；缺信任返回 TRUST_REQUIRED 且不读取 stdin；符号链接/Windows 短名归一；初始化中途失败回收已创建资源。
- [x] Step 2：运行 `pnpm exec vitest run packages/cli/tests/local-host-resources.test.ts`，确认因本项功能缺失而失败，排除环境/导入路径错误。
- [x] Step 3：实现上述文件与接口，保持中文 JSDoc、宿主资源边界和技术方案规定值；不扩大当前任务范围。
- [x] Step 4：重跑本项测试，期望全部通过；运行 `pnpm typecheck` 检查新接口及既有调用者。
- [x] Step 5：检查 diff 与测试证据，对应 OpenSpec task 仅在实现和证据完成后勾选；保留工作区供审核，不自动提交。

### Task 5: Registry 与控制权

**Files:** packages/cli/创建 src/local-host/registry.ts；测试 local-host-session.test.ts。

**Interfaces:** SessionRegistry.open(workspaceRoot:string,conversationId?:string):Promise<SessionRef>；attach(ref:SessionRef,clientId:string,mode:"control"|"observe"):Promise<Snapshot>；close(control:SessionControl):Promise<void>。HostContext 将 controlEpoch 注入后续变更请求。

- [x] Step 1：在 `packages/cli/tests/local-host-session.test.ts` 写行为测试，断言：同会话单控制者、旧 epoch 变更拒绝、观察者无运行权；8 个打开会话上限；busy close 失败；已有存储锁不偷取；关闭一个会话不影响其他容器。
- [x] Step 2：运行 `pnpm exec vitest run packages/cli/tests/local-host-session.test.ts`，确认因本项功能缺失而失败，排除环境/导入路径错误。
- [x] Step 3：实现上述文件与接口，保持中文 JSDoc、宿主资源边界和技术方案规定值；不扩大当前任务范围。
- [x] Step 4：重跑本项测试，期望全部通过；运行 `pnpm typecheck` 检查新接口及既有调用者。
- [x] Step 5：检查 diff 与测试证据，对应 OpenSpec task 仅在实现和证据完成后勾选；保留工作区供审核，不自动提交。

### Task 6: 审批桥

**Files:** packages/cli/创建 src/local-host/approval.ts；测试 local-host-approval.test.ts。

**Interfaces:** RpcApprovalChannel implements Core ApprovalChannel；构造接收控制连接与 SessionControl，requestApproval 复用原有签名；dispose():void 撤销全部 pending。approval/request 为服务端请求，响应仅为对应 choice。

- [x] Step 1：在 `packages/cli/tests/local-host-approval.test.ts` 写行为测试，断言：五种 choice 原样保留；allow_session 受 sessionAllowed 限制；120 秒超时、断线、AbortSignal 清为 cancel；错 ID/epoch/客户端/重复回复拒绝；脱敏不足拒绝；两个并发审批回复逆序仍正确关联。
- [x] Step 2：运行 `pnpm exec vitest run packages/cli/tests/local-host-approval.test.ts`，确认因本项功能缺失而失败，排除环境/导入路径错误。
- [x] Step 3：实现上述文件与接口，保持中文 JSDoc、宿主资源边界和技术方案规定值；不扩大当前任务范围。
- [x] Step 4：重跑本项测试，期望全部通过；运行 `pnpm typecheck` 检查新接口及既有调用者。
- [x] Step 5：检查 diff 与测试证据，对应 OpenSpec task 仅在实现和证据完成后勾选；保留工作区供审核，不自动提交。

### Task 7: 运行、取消与服务端调度

**Files:** packages/cli/创建 src/local-host/{run,server}.ts；测试 local-host-run.test.ts。

**Interfaces:** LocalHostServer.handle(request:WireRequest,connection:ConnectionContext):Promise<WireResponse>；startRun(control:SessionControl,input:RunInput):Promise<RunRef>；cancelRun(control:SessionControl,run:RunRef):Promise<void>。所有数据请求经版本/认证/归属门。

- [x] Step 1：在 `packages/cli/tests/local-host-run.test.ts` 写行为测试，断言：run/start 接收后流事件继续；取消确认早于但不冒充终态；控制端断线取消并清理后才重新授予控制；工具刚完成保留真实结果；存储失败不能报完成或提前释放锁。
- [x] Step 2：运行 `pnpm exec vitest run packages/cli/tests/local-host-run.test.ts`，确认因本项功能缺失而失败，排除环境/导入路径错误。
- [x] Step 3：实现上述文件与接口，保持中文 JSDoc、宿主资源边界和技术方案规定值；不扩大当前任务范围。
- [x] Step 4：重跑本项测试，期望全部通过；运行 `pnpm typecheck` 检查新接口及既有调用者。
- [x] Step 5：检查 diff 与测试证据，对应 OpenSpec task 仅在实现和证据完成后勾选；保留工作区供审核，不自动提交。

### Task 8: 事件、快照与重放

**Files:** packages/cli/创建 src/local-host/events.ts；复用现有 host/history-projection.ts 的白名单思路；测试 local-host-events.test.ts。

**Interfaces:** SessionEventFeed.publish(event:WireEvent):void；snapshot(ref:SessionRef,cursor?:Cursor):Promise<Snapshot>；attach(ref:SessionRef,afterSeq?:number):Promise<Snapshot>，与 Registry 协同在同一会话队列设置订阅水位。实现最多 1024 个操作 ID 的去重缓存，会话存活期间不淘汰，满后拒绝新 ID。

- [x] Step 1：在 `packages/cli/tests/local-host-events.test.ts` 写行为测试，断言：快照 N 后事件连续；重复输入 ID 返回原 runId、参数冲突拒绝；4096 条/8MiB 任一上限淘汰触发 RESYNC_REQUIRED；私有块与植入凭证不进重放；大历史分页游标失效明确失败。
- [x] Step 2：运行 `pnpm exec vitest run packages/cli/tests/local-host-events.test.ts`，确认因本项功能缺失而失败，排除环境/导入路径错误。
- [x] Step 3：实现上述文件与接口，保持中文 JSDoc、宿主资源边界和技术方案规定值；不扩大当前任务范围。
- [x] Step 4：重跑本项测试，期望全部通过；运行 `pnpm typecheck` 检查新接口及既有调用者。
- [x] Step 5：检查 diff 与测试证据，对应 OpenSpec task 仅在实现和证据完成后勾选；保留工作区供审核，不自动提交。

### Task 9: JSONL 与 stdio

**Files:** packages/cli/创建 src/transport/{types,jsonl,stdio}.ts；接入 serve --stdio 的早期参数分流；测试 local-transport.test.ts。

**Interfaces:** JsonlDecoder.push(chunk:Uint8Array):WireMessage[]；end():void；createStdioTransport(input:Readable,output:Writable):LocalTransport。Node 类型仅出现在 transport/client/host。

- [x] Step 1：在 `packages/cli/tests/local-transport.test.ts` 写行为测试，断言：中文拆包、粘包、CRLF、U+2028/U+2029 完整；超过 1MiB 拒绝且内存有界；EOF 半帧拒绝；父管道 EOF 清理在途；stdout 无日志，stderr 脱敏。
- [x] Step 2：运行 `pnpm exec vitest run packages/cli/tests/local-transport.test.ts`，确认因本项功能缺失而失败，排除环境/导入路径错误。
- [x] Step 3：实现上述文件与接口，保持中文 JSDoc、宿主资源边界和技术方案规定值；不扩大当前任务范围。
- [x] Step 4：重跑本项测试，期望全部通过；运行 `pnpm typecheck` 检查新接口及既有调用者。
- [x] Step 5：检查 diff 与测试证据，对应 OpenSpec task 仅在实现和证据完成后勾选；保留工作区供审核，不自动提交。

### Task 10: 本地 socket 与连接预算

**Files:** packages/cli/创建 src/transport/socket.ts 与 local-host/auth.ts；测试 local-socket.test.ts。

**Interfaces:** listenLocalHost(context:HostContext):Promise<LocalListener>；connectLocal(endpoint:LocalEndpoint,signal?:AbortSignal):Promise<LocalTransport>。LocalEndpoint 限 unix/pipe 判别联合；LocalListener 提供 close():Promise<void>。

- [x] Step 1：在 `packages/cli/tests/local-socket.test.ts` 写行为测试，断言：未认证、5 秒超时拒绝；16 连接/64 请求/4MiB 发送队列边界；write(false) 时仍处理 cancel 和审批；拒绝 TCP；目录/token 权限正确；token 不进 argv/日志/快照。
- [x] Step 2：运行 `pnpm exec vitest run packages/cli/tests/local-socket.test.ts`，确认因本项功能缺失而失败，排除环境/导入路径错误。
- [x] Step 3：实现上述文件与接口，保持中文 JSDoc、宿主资源边界和技术方案规定值；不扩大当前任务范围。
- [x] Step 4：重跑本项测试，期望全部通过；运行 `pnpm typecheck` 检查新接口及既有调用者。
- [x] Step 5：检查 diff 与测试证据，对应 OpenSpec task 仅在实现和证据完成后勾选；保留工作区供审核，不自动提交。

### Task 11: Daemon 实例管理

**Files:** packages/cli/创建 src/local-host/daemon.ts，修改 CLI 参数与帮助分流；测试 local-daemon.test.ts。

**Interfaces:** startDaemon():Promise<DaemonStatus>；getDaemonStatus():Promise<DaemonStatus>；stopDaemon():Promise<void>。DaemonStatus 含健康、版本、实例身份，不含凭证；启动仅使用 process.execPath 和参数数组。

- [x] Step 1：在 `packages/cli/tests/local-daemon.test.ts` 写行为测试，断言：同时 start 仅一个健康实例；PID 复用不误杀；陈旧 socket 只有取得启动锁才能清理；握手成功才报 start 成功；shutdown 超时明确失败，正常停止无受管工具残留。
- [x] Step 2：运行 `pnpm exec vitest run packages/cli/tests/local-daemon.test.ts`，确认因本项功能缺失而失败，排除环境/导入路径错误。
- [x] Step 3：实现上述文件与接口，保持中文 JSDoc、宿主资源边界和技术方案规定值；不扩大当前任务范围。
- [x] Step 4：重跑本项测试，期望全部通过；运行 `pnpm typecheck` 检查新接口及既有调用者。
- [x] Step 5：检查 diff 与测试证据，对应 OpenSpec task 仅在实现和证据完成后勾选；保留工作区供审核，不自动提交。

### Task 12: Node 客户端

**Files:** packages/cli/创建 src/client/{local-client,index}.ts；补齐 client 子路径和 Node 构建；测试 local-client.test.ts。

**Interfaces:** LocalClient.connect(transport:LocalTransport,offer:ProtocolOffer):Promise<LocalClient>；request(request:WireRequest):Promise<WireResponse>；events():AsyncIterable<WireEvent>；close():Promise<void>。审批请求交给上层显式回调，不自动批准。

- [x] Step 1：在 `packages/cli/tests/local-client.test.ts` 写行为测试，断言：响应乱序正确关联；未知 ID 不错误 settle；断线 pending 全失败并清定时器；重复/缺号事件处理符合协议；服务重启仅重新 attach，不重发 run/start；取消不等待普通 RPC 超时。
- [x] Step 2：运行 `pnpm exec vitest run packages/cli/tests/local-client.test.ts`，确认因本项功能缺失而失败，排除环境/导入路径错误。
- [x] Step 3：实现上述文件与接口，保持中文 JSDoc、宿主资源边界和技术方案规定值；不扩大当前任务范围。
- [x] Step 4：重跑本项测试，期望全部通过；运行 `pnpm typecheck` 检查新接口及既有调用者。
- [x] Step 5：检查 diff 与测试证据，对应 OpenSpec task 仅在实现和证据完成后勾选；保留工作区供审核，不自动提交。

### Task 13: connect 最小交互闭环

**Files:** packages/cli/创建 src/local-host/connect.ts，修改 index.ts/help 接线；复用现有输入协调、view-model、命令输出；测试 local-connect.test.ts。

**Interfaces:** runConnectedClient(client:LocalClient):Promise<void>。文本输入及明确支持的会话列表/打开、状态、审批、取消、退出走 client；其余 Slash 命令明确 unsupported，不执行本地旁路。

- [x] Step 1：在 `packages/cli/tests/local-connect.test.ts` 写行为测试，断言：单一 stdin 消费者；审批与文本不互抢；事件映射无重复正文；非 TTY 不挂起审批；Ctrl+C 取消后可继续；退出等待清理；原直接 CLI 默认行为不变。
- [x] Step 2：运行 `pnpm exec vitest run packages/cli/tests/local-connect.test.ts`，确认因本项功能缺失而失败，排除环境/导入路径错误。
- [x] Step 3：实现上述文件与接口，保持中文 JSDoc、宿主资源边界和技术方案规定值；不扩大当前任务范围。
- [x] Step 4：重跑本项测试，期望全部通过；运行 `pnpm typecheck` 检查新接口及既有调用者。
- [x] Step 5：检查 diff 与测试证据，对应 OpenSpec task 仅在实现和证据完成后勾选；保留工作区供审核，不自动提交。

### Task 14: 产物、平台与发布文档

**Files:** packages/cli/创建 tests/local-release.test.ts、scripts/v0.0.9-platform-check.mjs、docs/local-host.md、migration/v0.0.9.md、verification/v0.0.9.md、releases/v0.0.9.md；按实测更新 README/RELEASES。

**Interfaces:** 平台脚本通过已打包 CLI 启动真实 daemon/client，执行确定性 fake Provider 工具任务、审批/取消/断线/重连。发布说明区分已验证平台和未完成证据。

- [ ] Step 1：在 `packages/cli/tests/local-release.test.ts` 写行为测试，断言：tarball 三子路径均可导入且无启动副作用；原 SDK/CLI/MCP 与旧历史回归；macOS/Linux/Windows 真实 socket/pipe 与进程清理分别留证；跨进程不同会话写互斥边界明示；不增加发布包或升级版本。
- [ ] Step 2：运行 `pnpm exec vitest run packages/cli/tests/local-release.test.ts`，确认因本项功能缺失而失败，排除环境/导入路径错误。
- [ ] Step 3：实现上述文件与接口，保持中文 JSDoc、宿主资源边界和技术方案规定值；不扩大当前任务范围。
- [ ] Step 4：重跑本项测试，期望全部通过；运行 `pnpm typecheck` 检查新接口及既有调用者。
- [ ] Step 5：检查 diff 与测试证据，对应 OpenSpec task 仅在实现和证据完成后勾选；保留工作区供审核，不自动提交。

## 阶段依赖与整体验证

Task 1–3 为 P0；4–9 为 P1（先验证 stdio 端到端）；10–11 为 P2；12–13 为 P3；14 为 P4。P1 stdio 测试可使用内存 LocalTransport 替身，但不能标记真实 socket 平台通过。

每项通过后不反复跑全套；P0、P1、P2、P3 完成时分别做关联集成测试。最终执行 `pnpm verify`（包含 typecheck→test→lint 与秘密/架构门禁）、`pnpm build`、`pnpm --filter @kiturone/kapibala-cli pack --pack-destination /tmp/kapibala-v009-pack`，再从 tarball 独立安装 smoke。这些命令为未来实施验收，本轮文档编写未执行产品测试。

## 自检与待验证项

已将四类 capability 对应到 Task 1–14：协议 1–3/12，宿主 4–5/7–8，审批 6/13，传输 9–11，平台/兼容 14。没有通过文档推断平台已支持。工程初值已确定并须在 Task 1 固化：1024 个已接收操作 ID/会话，存活期间不淘汰；满后拒绝新操作，已有 ID 仍返回缓存结果。关闭再打开时更换 streamEpoch，旧代际请求一律拒绝。历史默认每页 50 条且按编码字节预算进一步分页；活动尾部与大块走同 revision 分块读取，未取得完整首快照不得开始应用后续事件。测试必须包含缓存恰好满、满后重复请求、旧代际重发、超长单消息和分块期间缓冲过期。

2026-10-19：Task 1–13 已编码并取得当前平台测试证据；Task 14 的 Linux/Windows/Node 20 等发布前门禁仍待验收。具体实施裁决、测试路径替换与证据见 docs/verification/v0.0.9.md。本计划不等同于版本已发布。
