# Kapibala Core SDK

`@kiturone/kapibala` 是 Kapibala 的 Headless Agent Harness，提供会话、模型、工具、沙箱和消息存储能力，不包含终端界面。

需要 Node.js 20 或更高版本。

v0.0.3 提供独立历史会话与上下文管理。安装指定版本：

```bash
npm install @kiturone/kapibala@0.0.3
```

API 用法和示例见 [Kapibala 项目主页](https://github.com/tedburner/kapibala)。交互式终端请使用 [`@kiturone/kapibala-cli`](https://www.npmjs.com/package/@kiturone/kapibala-cli)。

v0.0.2 默认启用工具执行前授权与审计。自定义工具应声明 `metadata.permissions`，需要人工批准时由宿主注入 `approvalChannel`；没有审批通道的待审批调用会被拒绝。迁移指南见 [v0.0.2 迁移说明](https://github.com/tedburner/kapibala/blob/main/docs/migration/v0.0.2.md)。

v0.0.3 新增 SessionManager、版本化 SessionStore 与 ContextManager，支持独立会话恢复和保守两级压缩；旧 MessageStore 仍可使用，但没有状态能力时不启用可恢复压缩。当前任务与最近成功完整轮次超限会明确停止。详细边界见 [v0.0.3 迁移说明](https://github.com/tedburner/kapibala/blob/main/docs/migration/v0.0.3.md)，本地证据见仓库 `docs/verification/v0.0.3.md`。
