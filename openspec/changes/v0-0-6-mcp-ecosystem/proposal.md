# Proposal: v0.0.6 受控 MCP 生态接入

## Why

v0.0.5 已建立技能发现、运行级权限收紧和统一工具事务，v0.0.6 需要让同一 Harness 消费外部工具与用户 Prompt。接入必须同时解决连接清理、目录变化、审批身份和结果未知问题，避免外部能力绕过既有权限与消息落盘规则。

## What Changes

- 新增独立包 `@kiturone/kapibala-mcp`，通过 Core 公共插件/工具契约接入官方 SDK；Core 保持 Headless 和运行时零依赖。
- 支持 Stdio 与 Streamable HTTP，HTTP 首版使用环境变量提供的固定 Header/Bearer 凭据；分别设置启动、目录、调用和清理期限。
- 提供用户/项目 `mcp.json`、确定性整项覆盖、环境变量白名单、项目信任与独立 Server 启动授权；配置、端点或可识别执行目标变化需重新授权。
- 发现分页 Tools/Prompts，按 source 原子发布；连接代次和能力目录 epoch 防止旧回调污染新状态，断连撤销执行资格，新增/变更 MCP 定义在下一 run 生效。
- 补齐通用 source 快照、最终参数校验、执行身份和显式结果适配契约；本轮 MCP 声明保持稳定，调用与审批绑定同一身份，Skill/硬拒绝始终优先。
- 转换文本和结构化结果、区分远端 dispatchOutcome 与宿主投影错误、限制响应大小；应用/SDK/transport 均不得重放已发送调用，未知结果要求用户介入，取消等待本地收口并闭合历史。
- 新增 PromptRegistry 与受控任务准备入口，用户显式执行 Prompt，来源随单条 user 消息落盘；恢复不重新获取或授予权限。
- CLI 提供 `/mcp`、`/prompts`、`/prompt` 与 `--no-mcp`，沿用活动会话/输入所有权和忙碌门禁；SDK 可注入授权、状态及任务准备回调。
- 扩展第三个包的编译、类型检查、工作区链接和发布/安装验证。Resources、OAuth、旧 HTTP+SSE、Sampling、Elicitation、MCP Apps、Code Mode 和自动安装不进入本版。
- 缓存友好的上下文压缩专项增强与实测另行排期、版本待定；RELEASES 保留目标，既有压缩约束继续有效，不将 MCP 前缀稳定视为缓存专项已完成。Prompt 基于 Core + Stdio 闭环可独立于 HTTP 推进，最终交付仍汇合两种传输。

## Capabilities

### New Capabilities

- `tool-source-transactions`: 原子来源更新、运行快照与版本撤销。
- `mcp-config-trust`: 配置覆盖、凭据边界、项目信任与启动授权。
- `mcp-connection-lifecycle`: 传输、状态、连接代次、启动与清理。
- `mcp-tool-execution`: 命名、目录预算、参数校验、权限和审批身份。
- `mcp-result-lifecycle`: 结果转换、取消、未知结果、审计与恢复。
- `mcp-user-prompts`: 用户调用、任务准备、来源与消息提交。
- `cli-mcp-management`: 管理命令、搜索、运行门禁与输出。
- `mcp-package-delivery`: 独立包、公开契约、门禁与安装交付。

### Modified Capabilities

无。当前主规范清单为空，上述契约按新增能力建立；v0.0.2–v0.0.5 未归档变更中的权限、历史与协议前缀规则仍是实现约束。

## Impact

- Core：ToolRegistry、Tool/ApprovalRequest、ToolExecutor、AgentSession/AgentLoop、canonical 可选来源及验证/投影消费者；所有新增导出同步中文 JSDoc。
- MCP：新增 `packages/mcp`，只依赖 Core 根导出和官方 SDK，SDK 版本需通过明确兼容验证后锁定。
- CLI：配置/信任、启动/会话工厂、活动控制器、命令目录/输入协调器及事件展示。
- 工程：tsconfig、开发脚本的 workspace 链接、构建/架构检查、release/flow 与 Actions 的包清单、可信发布和冒烟。
- 规划已在本地捕获，功能尚未实现；当前版本仍为 0.0.5。技术论证见 [技术设计](../../../docs/superpowers/specs/2026-10-12-v0-0-6-mcp-ecosystem-design.md)，实施顺序见 [开发计划](../../../docs/superpowers/specs/2026-10-12-v0-0-6-development-plan.md)，进度以 [tasks](tasks.md) 为准。
