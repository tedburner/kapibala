# Proposal

## Why

桌面端会话的运行时已经支持技能与 MCP（共享宿主层装配：`load_skill` 等工具已注册、`mcp.json` 配置后经审批挂载），但用户只能手动编辑 JSON——没有可感知、可配置、可诊断的管理面。技能与 MCP 是宿主产品力的两大扩展资源，缺管理面等于对用户不可用；且 host 层重构（`@kiturone/kapibala-host` 独立包）已就位，管理服务可以放在宿主层被 CLI 与桌面共同消费，现在是引入的最佳时机。

## What Changes

- 桌面设置新增「资源管理」区块，分 MCP 与 Skills 两个子面板：
  - **MCP**：全局 `~/.kapibala/mcp.json` 的服务器列表展示与 CRUD（新增/编辑/删除）、逐服务器启用/禁用（复用现有 `enabled: false` 配置契约）、启动审批说明与诊断展示；项目级 `.kapibala/mcp.json` 只读展示，未信任项目的排除声明按现有信任防线原样呈现
  - **Skills**：全局启用开关（`settings.skills.enabled`，走既有 `mutateGlobalSettings` 配置事务）、技能列表（名称/scope/可用性/描述摘要）、扫描诊断展示、逐技能禁用（`settings.skills.disabled`）
- 宿主层新增资源管理服务模块（MCP 配置读写 + 技能目录扫描），桌面经既有 RPC 契约模式暴露；CLI 应用层同步复用（`/skills`、`/mcp` 命令与设置面板共享同一服务，不另写第二份读取逻辑）
- 配置文件契约不变：MCP 仍走独立 `mcp.json`（全局 + 项目级整项覆盖 + 未信任项目排除），技能仍走 `settings.json` 的 `skills` 段 + 既有技能目录发现/信任规则；**无 BREAKING 变更**
- 范围边界（评审确认）：本版只做设置面板，不做会话内斜杠命令等价物；不做技能文件的新建/编辑/删除；不改动 MCP 启动审批与技能加载授权语义

## Capabilities

### New Capabilities

- `resource-management/mcp`: 桌面（及复用同一服务的 CLI）对 MCP 服务器资源的配置管理面——全局清单 CRUD、逐服务器启停、项目级只读视图与信任排除诊断的可见性要求
- `resource-management/skills`: 技能资源的可见性与开关管理面——全局启用状态、技能清单与扫描诊断、逐技能禁用的事务语义

### Modified Capabilities

（无——项目尚无 synced specs；现有 mcp.json/settings 契约行为不变，仅新增管理面）

## Impact

- **packages/host**：新增资源管理服务模块（如 `src/host/resource/`：MCP 配置读取/校验/写回 + 技能清单扫描），经 `@kiturone/kapibala-host/internal` 供 CLI 应用层、经新 RPC 契约供桌面；`mcp.ts` 的 `resolveCliMcpOptions` 保持为会话装配入口不变
- **packages/desktop**：`shared/contracts.ts` 新增 `resources.*` RPC 方法（zod PARAMS/RESULTS）；`agent-host/` 新增 ResourceService；`renderer/settings-dialog.tsx` 新增资源管理区块（遵循 check-desktop 的 UI 门禁：语义化 token、Kumo 组件、无原生交互元素）
- **packages/cli**：`commands/skills.ts` / `commands/mcp.ts` 改为消费宿主层资源服务（删除与设置面板重复的读取实现）
- **安全边界**：项目级 MCP/技能声明的信任防线（未信任项目排除）、技能 boundary 物理边界校验、MCP 启动审批、密钥不落盘规则全部原样保留；管理面是**只读投影 + 既有契约的受控写回**，不新增授权路径
- **门禁**：`check-desktop` 白名单与 import 规则不变；`check-architecture` 不受影响（管理服务在宿主层，不进 core）
