# Proposal: v0.0.9 本地客户端契约与发布前加固

## Why

v0.0.8 已建立 Headless Core、命令输出分离与纯展示模型，但进程内类型和 Promise 审批无法直接跨进程复用。v0.0.9 需要建立可连接、可审批、可取消、可重同步的本地宿主，为后续桌面端提供契约。

## What Changes

- 保持现有 Core、CLI、MCP 三个发布包，在 CLI 内增加 protocol/local-host/transport/client 模块。
- 增加无 Node 依赖的 `@kiturone/kapibala-cli/protocol` 和无启动副作用的 Node `@kiturone/kapibala-cli/client` 子路径。
- 实现版本化 JSON-RPC 2.0、双向审批、控制代际、事件序号和一致性快照（断线通过快照重建，不重放事件）。
- 增加 `kpbl serve --stdio`、`kpbl daemon start|status|stop`、`kpbl connect`；默认 CLI 继续直接运行。
- 会话独立加载配置/Provider/技能/MCP，宿主显式注入写租约；无终端向导，缺信任或配置明确失败。
- 实现本地认证、预算、背压、启动身份和清理门禁，保留 canonical 工具事务闭合与历史持久化。

不交付 GUI、HTTP/WebSocket/TCP、系统服务安装、自动更新、跨进程不同会话的工作区写互斥、全屏 TUI 或重启自动续跑。

## Capabilities

### New Capabilities

- `local-client-protocol`: 版本、运行时校验、方法/错误、事件身份与子路径边界。
- `local-host-lifecycle`: 会话资源、控制权、运行/取消/关闭、快照与恢复。
- `local-approval-bridge`: 双向审批关联、五种选择、参数绑定、撤销和过期。
- `local-transport`: JSONL、stdio/socket、认证、daemon 身份和资源限制。

### Modified Capabilities

无。现有 Core 安全、消息落盘、SDK 与直接 CLI 的约束继续适用。

## Impact

仅 CLI 新增运行模块、构建子路径、测试和工程门禁；Core 仅在实际必要时增加通用 Headless 接点。三个包版本发布流程保持不变。

设计真源：[技术方案](../../../docs/design/002-v0.0.9-local-client-contract.md)。实现进度以本 change 的 tasks 为准，不将规格完成标为功能完成。
