# Design

## Context

- 运行时已就绪：桌面会话经 `createManagedSession`（宿主层 `packages/host/src/host/managed-session.ts`）装配技能工具与 MCP 挂载；MCP 启动走审批 authorizer，技能授权走 PermissionPolicy + 宿主审批。
- 配置契约已支持管理语义：`mcp.json` 逐服务器 `enabled` 字段（含项目级纯禁用覆盖，`@kiturone/kapibala-mcp` 的 `resolveMcpConfig` 已消费）；`settings.skills = { enabled?, disabled? }` 已有合并语义（`migrateGlobalSettings` 内可见）。
- 桌面 RPC 模式：`shared/contracts.ts` 用 zod 定义 `PARAMS` / `RESULTS` 方法表，`agent-host/desktop-host.ts` 按 `case '域.动作'` 分发给 service 类（参考 `SettingsService`）。
- 信任防线：MCP/技能的项目级声明都按项目信任排除（`resolveCliMcpOptions` / `getCliSkillOptions` 已实现），desktop `workspaces.ts` 持有信任状态。

## Goals / Non-Goals

**Goals**
- 一个宿主层资源服务模块承载全部读取/校验/写回逻辑，CLI 命令与桌面 RPC 同源消费
- 桌面设置面板两个子区块（MCP / Skills），复用现有设置页交互与视觉模式
- 配置写回复用全局配置短事务的锁语义（MCP `mcp.json` 新增同款事务封装）

**Non-Goals**
- 不做技能文件的创建/编辑/删除（资源管理 ≠ 资源编辑器）
- 不做会话内斜杠命令等价物（桌面无命令面板机制，另行议题）
- 不改 `resolveCliMcpOptions` 的会话装配入口签名与授权语义
- 不做 MCP 连接状态实时监控（启停效果以下次会话装配为准，面板不做长连接探活）

## Decisions

### D1：资源服务放宿主层 `packages/host/src/host/resource/`，不放 CLI

理由：读写逻辑与 CLI 命令、桌面 RPC 都需要；宿主层是本次重构刚建立的共享装配层，`internal` 门面已服务 CLI 应用层。备选「放 desktop agent-host」被否——CLI 的 `/skills` `/mcp` 命令就得保留第二份读取实现（现状正是两份，本次收敛）。

### D2：MCP 配置写回新增独立短事务，不动 `settings.json` 事务

`mcp.json` 与 `settings.json` 是两个文件契约，锁与校验各自独立：新增 `mutateGlobalMcpConfig(draft => ...)`（宿主层 resource 模块），文件锁 + 全量校验后原子写回，复用 `mutateGlobalSettings` 的实现模式（读原始 → 变更 → 校验 → 原子替换）。备选「把 MCP 并进 settings.json」被否——违反既有独立配置文件契约（`mcp.ts` 文件头明确），且迁移老用户配置是无谓的 BREAKING 风险。

### D3：技能清单扫描用「无会话轻投影」，不在面板拉起会话

面板清单来自宿主层 resource 模块直接调用既有扫描/目录能力（`SkillRegistry` 的目录侧 + 信任解析），而非从活动会话 `getSkills()` 取——设置面板必须在无会话时可用。同源性靠「同一扫描实现 + 同一信任输入」保证：resource 模块与 `getCliSkillOptions` 消费同一批函数与信任判定，测试断言两个入口输出一致。

### D4：RPC 方法域 `resources.*`，一次读取、单点变更

契约新增（命名对齐现有 `settings.*`）：
- `resources.readMcp(workspaceId)` → 全局清单（脱敏后：不含环境变量值原文）+ 项目只读声明 + 诊断
- `resources.saveMcpServer(workspaceId, draft, editName?)` / `resources.deleteMcpServer` / `resources.toggleMcpServer`
- `resources.readSkills(workspaceId)` → 清单 + 诊断 + 开关状态
- `resources.setSkillsEnabled(workspaceId, enabled)` / `resources.setSkillDisabled(workspaceId, name, disabled)`

备选「整份 JSON 提交」被否——与 settings 面板既有「单点变更 + 服务端校验」模式一致，避免面板持有原始配置全文造成竞态。脱敏原则：传输目标摘要化展示（命令行/URL 原样属敏感面，按现有 redaction 规则处理 env 值，绝不回传密钥）。

### D5：面板 UI 挂在 settings-dialog 的新区块，遵循既有门禁

设置弹窗新增「资源管理」标签区（与模型区同层级导航），MCP / Skills 两个子面板；遵循 `check-desktop` 全部 UI 规则（Kumo 组件、语义 token、无原生交互元素、无未授权依赖）。列表项操作（启停/删除）用确认对话承接删除类动作。

## Risks / Trade-offs

- [resource 模块与 CLI 命令的双消费漂移] → 以宿主层为唯一实现，CLI 命令改为薄壳调用；测试断言两入口输出一致
- [`mcp.json` 写回损坏用户手写的注释/格式] → JSON.stringify 无注释保留；写回前展示 diff 预览并把「格式重排」写进确认文案，与 settings.json 既有行为一致
- [面板与运行会话状态短时不一致（启停后旧会话仍挂载）] → 面板明示「对新建会话生效」；不做运行中会话的热插拔（授权语义复杂度不成比例）
- [诊断泄漏敏感值] → 诊断经既有 redaction 管道后展示，测试覆盖含密钥样例

## Migration Plan

纯增量功能，无数据迁移：`mcp.json` / `settings.json` 的既有文件原样可用。回滚 = 还原本次提交（新 RPC 方法无人调用即无影响）。

## Open Questions

- MCP 目标摘要的脱敏粒度（命令参数里可能含 token）——实现时按 redaction 既有规则取齐，若有歧义在 PR 内对齐样例。
