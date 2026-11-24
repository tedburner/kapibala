# Kapibala Core SDK

`@kiturone/kapibala` 是 Kapibala 的 Headless Agent Harness，保持 **0 外部运行时依赖**，提供会话循环、原生多协议模型接入、工具与风险分级权限裁决、路径硬禁区、JSONL 因果树历史存储、两级上下文压缩与按需技能加载，不绑定任何终端或 GUI。

环境要求：Node.js 20 或更高版本。

```bash
npm install @kiturone/kapibala
```

- **显式工作区身份**：构造 `AgentSession` 时必须传入绝对路径 `workspaceRoot`，Core 不隐式读取 `process.cwd()`；
- **事务与权限不变量**：`tool_use` 与 `tool_result` 强制成对闭合落盘，异常恢复只补写 `OUTCOME_UNKNOWN` 占位而不重放写操作；自定义工具通过 `metadata.permissions` 参与统一权限与路径硬禁区裁决；
- **原生多协议与路由**：内置 `OpenAICompatibleProvider`、`AnthropicMessagesProvider`、`OpenAIResponsesProvider`，支持 `default` / `planning` / `execution` / `fast` / `summary` 角色路由。

完整示例与架构文档见 [Kapibala 项目主页](https://github.com/tedburner/kapibala) 与 [SDK 使用指南](https://github.com/tedburner/kapibala/blob/main/docs/sdk.md)；公开导出面差异与升级指南见 [SDK 兼容性说明](https://github.com/tedburner/kapibala/blob/main/docs/sdk-compatibility.md)。交互式终端与本地守护进程请使用 [`@kiturone/kapibala-cli`](https://www.npmjs.com/package/@kiturone/kapibala-cli)。
