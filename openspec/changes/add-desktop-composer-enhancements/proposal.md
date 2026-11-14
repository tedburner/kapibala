# Proposal

## Why

桌面会话输入框目前是「纯文本直达模型」：`/` 斜杠命令与 `@` 文件引用都没有——CLI 有完整的斜杠命令系统（19 个命令 + 补全），桌面把 `/skill foo` 当普通文本发给模型；`@` 文件引用则两端都缺。这是桌面与主流 Agent Harness（CLI/终端类产品标配）在输入体验上最大的差距：会话内无法快捷使用技能、无法快捷指认文件。CLI 命令系统是已验证资产，桌面补的是适配层而非第二套实现。

## What Changes

- **会话命令面（方案 B：命令系统上桌）**：desktop-host 构造 `CommandContext` 桌面适配器（会话=托管会话、输出=事件/通知、问答/选择/密钥输入=桌面对话框），renderer 识别 `/` 前缀经新 RPC 走与 CLI **同一个** `CommandDispatcher`；命令面板提供补全（命令名 + 描述），`/` 前缀输入不再发给模型
  - 首批接入非交互命令（`/skills /mcp /status /agents /help /history /branch /fork /archive…`）与 `/skill <name> <task>` 直发；需要选择菜单/密钥输入的交互命令（如 `/model` 选模型、密钥录入）映射到桌面对话框后接入
- **`@` 文件引用（轻量语义）**：composer 中 `@` 触发工作区内文件补全（沙箱边界内枚举，模糊匹配），选中后以 `@<相对路径>` 文本进入消息——模型用既有 read 工具自行读取，不注入文件内容、不新增授权路径、零额外 token；新增工作区文件枚举 RPC 供补全列表消费
- **共享 composer 基建**：`/` 与 `@` 共用触发符识别 + 补全面板 UI + 键盘导航（上下选择/Tab/Enter 确认/Esc 关闭）
- 明确不做：`@` 不做内容注入式附件；不做会话内 MCP 服务器管理（走资源管理面板）；命令系统本身不新增命令（复用 CLI 现有目录）；无 BREAKING 变更

## Capabilities

### New Capabilities

- `composer/session-commands`: 桌面会话输入的斜杠命令面——`/` 前缀识别、命令补全、与 CLI 同源的命令执行、交互命令的对话框映射边界
- `composer/file-reference`: 会话输入的 `@` 文件引用——沙箱内文件补全、轻量文本语义、枚举的边界与预算约束

### Modified Capabilities

（无——`run.start` 纯文本路径保留；CLI 命令行为不变）

## Impact

- **packages/cli**：`commands/dispatcher.ts` 与 `commands/*` 不改行为；`interactive-host.ts` 的补全接口（`setCompleter`）形状作为桌面端口参考
- **packages/desktop**：`shared/contracts.ts` 新增 `run.command` / `workspace.listFiles` / 交互问答 RPC（question/select/readSecret 的请求-响应，复用审批面板的请求-应答模式）；`agent-host/` 新增 CommandHostService（构造 CommandContext 适配器 + FileListService）；`renderer/` composer 新增触发符识别、补全面板组件、命令/文件两种数据源
- **packages/host**：`internal` 门面按需登记 dispatcher 相关装配（若命令装配从 CLI 根下移）；文件枚举复用 core 既有 fs 能力，core 零改动
- **安全边界**：`@` 引用不改变文件读取授权（模型读文件仍走 read 工具与沙箱审批）；命令执行沿用 CLI 既有权限语义（命令层无新增授权路径）；枚举 RPC 严格限于沙箱 workspaceRoot 内且不返回文件内容
- **门禁**：`check-desktop` 的 renderer 规则（无原生交互元素、语义 token）适用于新补全面板；命令适配器在 desktop agent-host 层，不触碰 core headless 门禁
