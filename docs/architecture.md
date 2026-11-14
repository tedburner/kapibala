# 架构设计

Kapibala 是 pnpm monorepo：`packages/core`（`@kiturone/kapibala`，运行时 0 依赖的 Headless 核心）、`packages/cli`（`kpbl` 与共享宿主层）、`packages/mcp`（MCP 扩展）与 `packages/desktop`（Electron 桌面客户端）。完整设计基线见 [docs/design/001-agent-framework-design.md](design/001-agent-framework-design.md)。

## 模块分层与依赖方向（单向依赖，禁止反向）

```text
types/ + errors/        协议契约与错误类型
models/                Provider / Router（原生 fetch + SSE）
capabilities/          Prompt / Instructions / Security / Tools / Shell
extensibility/         Hooks / Plugin / Logging
runtime/               AgentLoop / ToolExecutor；通过共享契约准备请求
context/               AgentSession / SessionManager / Store / History / Compaction

Session 协调各子系统；runtime 不导入具体 ContextManager 或 Store。
Core 保持 Headless 与零运行时依赖，公开 SDK 导出保持兼容。
```

## 核心执行循环时序 (AgentLoop)

```text
User Input ──► session.run() 
                    │
                    ▼
               AgentLoop ◄────────────────────────┐
                    │ (分层组装上下文与提示词)            │
                    ▼                             │
               ModelProvider (Messages/Responses/Chat) │ (模型生成 tool_use)
                    │                             │
                    ▼                             │
               ToolExecutor (超时 + 调度执行)    │
                    │                             │
                    ▼                             │
               回填规范 ToolResults ───────────────┘
                    │ (达到最终自然语言答复)
                    ▼
               持久记录交互终态 & 结束本次任务
```

## 宿主复用边界

所有宿主（CLI 终端、daemon、Electron 桌面端）都通过 `AgentSession` / `SessionEvent` 复用同一 Agent Harness：

- **Core 保持 Headless**：不依赖 CLI、不直接读写终端、不包含 ANSI/UI 渲染；`pnpm check-architecture` 已并入 lint 门禁，新增宿主能力不得绕过。
- **共享宿主层**：CLI 的 `/host` 子路径导出受管会话装配与公共脱敏投影，桌面端经 `@kiturone/kapibala-cli/host` 复用同一实现；原始历史仍是唯一耐久事实。
- **受控边界**：桌面渲染层只接收白名单校验后的展示 DTO，进程域、导入边界与 UI 依赖由 `check-host` / `check-desktop` 门禁静态拦截。

公开 API 的兼容承诺与差异登记见 [SDK 兼容性说明](sdk-compatibility.md)。
