# Tasks: v0.0.9 本地客户端契约

2026-10-19：P0–P3 已编码并通过当前 macOS 门禁；P4 的 Windows ACL/进程树与 Node 20 真实验收仍待完成，Linux/Windows CI 全量门禁已通过。先写行为测试并确认失败，再实现并通过对应测试。保持三个发布包，不自动提交。详细步骤见 [实施计划](../../../docs/superpowers/plans/2026-10-19-v0-0-9-local-client-contract.md)。

## 1. P0 协议边界与构建

- [x] 1.1 协议类型、方法、事件与错误目录；通过 `packages/cli/tests/protocol.test.ts`，记录证据后再勾选。
- [x] 1.2 unknown 运行时校验与版本协商；通过 `packages/cli/tests/protocol.test.ts`，记录证据后再勾选。
- [x] 1.3 protocol/client 子路径独立构建与 tarball 导入门禁；通过 `packages/cli/tests/protocol-boundary.test.ts`，记录证据后再勾选。

## 2. P1 Headless 宿主与审批

- [x] 2.1 独立配置/Provider/技能/MCP 容器与显式租约注入；通过 `packages/cli/tests/local-host-resources.test.ts`，记录证据后再勾选。
- [x] 2.2 Registry、控制代际、同会话单运行及关闭；通过 `packages/cli/tests/local-host-session.test.ts`，记录证据后再勾选。
- [x] 2.3 五选一审批桥、到期/断线/取消撤销；通过 `packages/cli/tests/local-host-approval.test.ts`，记录证据后再勾选。
- [x] 2.4 运行生命周期与取消后的事务闭合；通过 `packages/cli/tests/local-host-session.test.ts`，记录证据后再勾选。
- [x] 2.5 快照水位、一致快照与去重缓存（不提供跨连接事件重放）；通过 `packages/cli/tests/local-host-events.test.ts`，记录证据后再勾选。

## 3. P2 本地传输与 daemon

- [x] 3.1 UTF-8/LF 分帧及 stdio 生命周期；通过 `packages/cli/tests/local-transport.test.ts`，记录证据后再勾选。
- [x] 3.2 socket/pipe 认证、端点权限与预算背压；通过 `packages/cli/tests/local-socket.test.ts`，记录证据后再勾选。
- [x] 3.3 daemon 启动锁、健康握手、身份与停止；通过 `packages/cli/tests/local-daemon.test.ts`，记录证据后再勾选。

## 4. P3 连接客户端

- [x] 4.1 LocalClient 请求关联、超时、取消和重同步；通过 `packages/cli/tests/local-client.test.ts`，记录证据后再勾选。
- [x] 4.2 connect 有限命令、审批与既有展示模型适配；通过 `packages/cli/tests/local-connect.test.ts`，记录证据后再勾选。

## 5. P4 发布加固

- [ ] 5.1 文档、包兼容、平台真实进程与完整门禁；通过 `scripts/v0.0.9-platform-check.mjs（macOS 真实 daemon 已通过；Linux/Windows 全量 CI 已通过，ACL/Node 20 待验收）`，记录证据后再勾选。


## 证据与尚未交付

本地完整门禁、真实进程、打包安装与剩余平台证据见 [验收记录](../../../docs/verification/v0.0.9.md)。勾选表示该实现项已在当前环境验证，不等于所有平台已可发布。实现以按字节预算的快照分块替代按消息数量直接塞单帧；陈旧实例元数据采取保留并报错，不自动回收未知 PID。版本号由发布脚本统一推进。
