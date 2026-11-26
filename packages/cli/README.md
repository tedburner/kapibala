# Kapibala CLI

Kapibala 的交互式命令行工具与受控本地守护进程，命令名为 `kpbl`。

环境要求：Node.js 20 或更高版本。

```bash
# 免安装直接启动（首次运行自动进入向导配置模型厂商与 API Key）
npx @kiturone/kapibala-cli

# 或全局安装后在任意项目目录运行
npm install -g @kiturone/kapibala-cli
kpbl
```

查看全部启动参数与子命令：

```bash
kpbl --help
```

- **交互式编码工作流**：默认新建独立 JSONL 因果会话，支持 `/history`、`/resume`、`/branch`、`/fork`、跨会话消息引用 `/quote`、可续聊委派会话 `/delegate`、会话级文件/端口监视 `/watches`、任务清单 `/todos` 与证据看板 `/evidence`；
- **风险分级权限**：支持 `approval` / `plan` / `auto` / `full-access` 四档模式，每条 `run_command` 经词法风险分级与路径硬禁区裁决（可用 `--disable-shell` 关闭）；
- **扩展生态与本地宿主**：内置外部代理管理与直连会话（`/external`，支持 ACP / Claude Code / Codex / Pi）、MCP 服务管理与逐服务启动批准（`/mcp`）、按需技能与跨工具导入（`/skills`、`/skill import`），并提供 `kpbl daemon` / `kpbl connect` / `kpbl serve --stdio` 本地协议（wire v2）接入及 `@kiturone/kapibala-cli/protocol`、`/client`、`/view-model`、`/host` 子路径导出。

完整文档见 [Kapibala 项目主页](https://github.com/tedburner/kapibala)、[CLI 使用指南](https://github.com/tedburner/kapibala/blob/main/docs/cli.md) 与 [本地宿主协议规范](https://github.com/tedburner/kapibala/blob/main/docs/local-protocol.md)。
