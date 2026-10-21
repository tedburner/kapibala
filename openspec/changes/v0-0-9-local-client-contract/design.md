# Design: v0.0.9 本地客户端契约

## Context

设计真源为 [技术方案](../../../docs/design/002-v0.0.9-local-client-contract.md)，本文件说明 OpenSpec 对应关系，避免复制第二份会漂移的完整设计。

## Decisions

1. 保持三个发布包；模块归属和子路径见技术方案 §3。protocol 为独立浏览器构建，client 为 Node 入口，transport 持有字节分帧。
2. JSON-RPC 2.0、不支持 batch；协议版本独立于产品版本。方法、事件和错误见 §4。
3. 单会话单控制者/单运行，控制代际不可复用；断线取消在途运行，最终状态等待事务闭合。见 §5。
4. canonical store 为历史真源，不保留可重放事件环；同队列捕获快照与订阅水位，过期要求重同步。见 §6。
5. stdio 随父进程结束，daemon 使用本地 socket/pipe；认证、身份校验与资源上限见 §7。
6. 宿主级写租约显式注入；每会话独立配置与 MCP 容器，不热更新、不跨会话共用连接。无新增信任交互。见 §9。

## Alternatives

独立 protocol/local-host npm 包增加发布和版本编排成本，本版没有独立发布需求，故采用内部模块加受控子路径。HTTP/WebSocket 扩大网络边界，本版不采用。stdio-only 无法支持 daemon 重连，保留本地 socket。

## Implementation and Validation

P0 契约 → P1 宿主/stdio → P2 daemon/socket → P3 connect → P4 发布加固。详细路径、接口、测试与步骤见 [实施计划](../../../docs/superpowers/plans/2026-10-19-v0-0-9-local-client-contract.md)。四个 capability 的 Scenario 是验收条件；实现状态见 [tasks](tasks.md)。

## Risks

真实 Windows pipe 权限、进程树回收和共享启动装配可能影响工期。缺平台证据不能标记该平台通过。跨进程不同会话仍可能同时写同工作区，必须在用户文档中明确边界。审批内容脱敏后无法充分说明目标时拒绝，避免盲批。
