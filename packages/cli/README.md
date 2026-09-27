# Kapibala CLI

Kapibala 的交互式命令行工具，命令名为 `kpbl`。

需要 Node.js 20 或更高版本。

使用 v0.0.3：

```bash
npx @kiturone/kapibala-cli@0.0.3
```

也可以安装后运行：

```bash
npm install -g @kiturone/kapibala-cli@0.0.3
kpbl
```

首次运行会引导配置模型和 API Key。查看命令选项：

```bash
kpbl --help
```

完整文档见 [Kapibala 项目主页](https://github.com/tedburner/kapibala)。

v0.0.2 默认注册跨平台 `run_command`，每条命令按当前权限模式授权；可用 `--disable-shell` 关闭。命令使用当前系统用户权限，文件工具的 PathSandbox 不覆盖命令进程。升级说明见 [v0.0.2 迁移说明](https://github.com/tedburner/kapibala/blob/main/docs/migration/v0.0.2.md)。

v0.0.3 默认新建会话，用 `/history` 浏览、`/resume [id]` 续答，也可用 `kpbl --continue` 或 `kpbl --resume <id>`。`/new` 与 `/clear` 保留旧文件；`/context` 查看预算，`/compact` 手动摘要。非 TTY 不等待菜单或自动批准。
