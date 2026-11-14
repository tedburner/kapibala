# CLI 使用指南（kpbl）

`kpbl` 是 Kapibala 的交互式命令行入口。本文是完整使用参考；安装与最小上手见 [README](../README.md#️-cli--kpbl)。

## 启动方式速览

```bash
kpbl                             # 启动交互式会话终端 (REPL)
kpbl "请帮我查看当前目录结构"    # 免交互单次会话模式 (直接问答并退出)
kpbl -m deepseek-v4-pro          # 指定 DeepSeek V4 Pro 启动终端
kpbl -m deepseek-flash --api-key "sk-xxx"   # 临时传入 Key 快速测试（不修改配置文件）

# 本地源码调试：pnpm dev 进 REPL；或编译后直接运行产物
pnpm build && node packages/cli/dist/bin.js
# 监听源码变化：pnpm dev:cli（tsup --watch，只重建不启动 REPL，需另开终端跑产物）
# 链接为全局命令：pnpm build && pnpm link:cli，之后任意终端直接输入 kpbl
```

## 命令行选项 (CLI Options)

```text
选项:
  -m, --model <id>       指定要使用的模型 profile id (如 deepseek-flash, claude-opus-5)
  --role <role>          显式主任务角色: default|planning|execution|fast
  -p, --prompt <text>    直接执行单次问答并输出结果 (免进入 REPL)
  --base-url <url>       临时覆盖模型 API 端点 (例如使用自建代理/中转)
  --api-key <key>        临时指定 API 密钥
  --debug                向 stderr 输出脱敏开发诊断与每步阶段耗时
  --permission <mode>    本次会话权限: approval|plan|auto|full-access
  --shell <kind>         命令解释器: auto|bash|pwsh|powershell
  --disable-shell        关闭默认命令工具
  --no-mcp               停用 MCP 生态服务与提示词
  --continue             继续当前项目最近有内容的会话
  --resume <id>          按完整 ID 或唯一前缀恢复会话
  -v, --version          查看当前版本
  -h, --help             查看帮助信息
```

当前工作区默认保存脱敏的运行日志和逐工具审计于 `~/.kapibala/logs/`、`~/.kapibala/audit/`；使用 `/logs [count]` 查看最近记录，`/status` 查看路径。审计记录操作 ID、工具调用 ID、审批来源和结果，不保存原始提示词、命令输出、密钥或完整命令；完整命令可能出现在已有会话历史中。`--debug` 增加的诊断也经过脱敏。命令的大输出保存在工作区 `.kapibala/tool-results/`，可用 `read_file` 按行读取；这些文件随工作区权限可见。

历史正文存放在 `~/.kapibala/sessions/<project-key>/`，每会话独立 JSONL，列表缓存可重建。保护范围外、成功完成旧轮次的成功读取/搜索结果先剪裁，仍超过阈值再滚动摘要；原文保留，各级提交后激活。当前任务、最近成功轮次及失败尾部完整保护，超限明确停止，任务内部压缩留到后续。迁移、命令和 SDK 接入见 [v0.0.3 迁移说明](migration/v0.0.3.md)，实测证据见 [v0.0.3 验收记录](verification/v0.0.3.md)。

## 初次冷启动向导 (Setup Wizard)

初次使用且本机尚未配置任何 API Key 时，系统将自动弹出交互向导。厂商清单取自内置目录，**2 步选择**（先选厂商、再选档位）：

```text
🐾 欢迎使用 Kapibala (kpbl)!
检测到当前尚未配置可用的模型服务。请选择您要使用的提供商：

  1) DeepSeek (推荐默认) —— DeepSeek Flash / V4 Pro (2个模型)
  2) OpenAI —— GPT-6 Astra / GPT-5.6 Sol·Terra·Luna (4个模型)
  ...（共 8 家内置厂商 + 自定义 OpenAI 兼容接口）

请输入选项 [1-9] (默认 1): 1
请选择具体模型 [1-2] (默认 1): 1
请输入您的 DeepSeek API Key (sk-...): sk-********************

⏳ 正在验证连接与可用性...
✔ 连接验证成功 (HTTP 200)
✔ 配置已成功持久化至全局：~/.kapibala/settings.json
已就绪！当前默认模型：DeepSeek Flash (V4.1-Flash) (deepseek-flash)
```

> 若探测返回 401/403，会提示「端点可达但密钥被拒绝」；若端点不可达或未实现 `GET /models`，会提示「未能验证连通性」。
> 两种情况都只告警、不阻断 —— 配置照常保存，避免私有网关被误挡在门外。
>
> 若该厂商族已有可用密钥，向导不会让你重新粘贴，而是先问一句：
> `检测到 DeepSeek 的可用 API Key（来自同厂商模型 'deepseek-flash'）。直接复用？[Y/n]:` —— 默认直接复用。

## 终端内置 Slash 命令与快捷键

进入交互终端后，提示符展示当前模型、权限与会话 ID 前缀。普通启动默认新建；`/history` 查看当前项目历史，`/resume [id]` 续答。`--continue` 或 `--resume <id>` 可在启动时恢复。恢复不重放工具、不继承会话批准、不改变工作目录。

### `/model` 两步分级交互式菜单

输入 `/model` 进入两步选择流程（**第一步选提供商，第二步选具体模型**），输入选项编号并按 **`Enter`** 确认，**`Esc`/`Ctrl+C`** 取消；所有菜单、密钥与审批复用同一输入协调器，非 TTY 无参数只列模型：

```text
? 第一步：请选择模型提供商 (Provider)
  ❯ ● 1) DeepSeek [当前提供商] - DeepSeek Flash / V4 Pro · 2个模型 · 🔑 已配置密钥
    ○ 2) OpenAI - GPT-6 Astra / GPT-5.6 Sol·Terra·Luna · 4个模型 · ⚠️ 未配置密钥
    ...（每个厂商直接标注密钥就绪状态；只列有模型的厂商，末尾恒定向导 / 更新密钥 / 设为默认三项）

? 第二步：请选择【DeepSeek】的具体模型
  ❯ ● 1) DeepSeek Flash (V4.1-Flash) [当前使用] - deepseek-flash | 1000k · 🔑 已配置密钥
    ○ 2) DeepSeek V4 Pro - deepseek-v4-pro | 1000k · 🔑 已配置密钥
    ○ 3) ⬅️ 返回上一级 (重新选择提供商)
```

> 徽章 `[当前使用]`（正在用的模型）与 `[默认]`（全局默认模型）是**互斥**的：当前模型同时也是默认模型时，只显示前者。

### API Key 按厂商族共用（一个厂商只需配置一次）

| 行为 | 说明 |
|---|---|
| **复用** | 为 `gpt-5.6-terra` 填过 Key 后，同厂商其它模型自动复用，切换时打印 `🔑 复用 ... 的 API Key（来源）`，菜单里也标注密钥状态 |
| **唯一** | 更新密钥时同厂商族的冗余副本会被自动清理，配置文件里始终只保留一份 |
| **隔离** | 8 家可识别厂商（DeepSeek / OpenAI / Anthropic / Google / 通义千问 / Kimi / 智谱 / Ollama）按厂商归组；**自定义端点按 host 隔离**，两个不同的自建网关不会串用密钥 |
| **不跨厂商** | 绝不做跨厂商兜底 —— 拿 OpenAI 的 Key 去打 DeepSeek 端点只会得到一条没头没尾的 401，排障成本极高 |

解析优先级：**本模型内联密钥 → 同厂商族已存密钥 → 本模型声明的环境变量 → 同族环境变量回退**。

### 常用 Slash 指令一览表

| 指令 | 作用说明 | 示例 |
|---|---|---|
| `/model` | **呼出交互式模型选择菜单**（编号选择；非 TTY 只列模型） | `/model` |
| `/model <id>` | 更新本次 default 绑定并切回 default 角色 | `/model deepseek-v4-pro` |
| `/model <role> <id>` | 保存 planning/execution/fast/summary 模型绑定 | `/model planning claude-opus-5` |
| `/model route <role>` | 选择 default/planning/execution/fast 主任务角色 | `/model route planning` |
| `/model setup` | 重新唤出终端交互配置向导 | `/model setup` |
| `/model key [id]` | 未指定 ID 时更新当前角色模型；同步刷新同组所有角色凭据 | `/model key gpt-5.6-terra` |
| `/model set-default <id>` | 将指定模型持久化为全局默认模型 | `/model set-default gpt-5.6-terra` |
| `/settings`、`/config` | 查看配置；default 设置下次启动模型，setup 打开向导 | `/settings default deepseek-flash` |
| `/new`、`/clear` | 保留旧文件并新建独立会话 | `/new` |
| `/history [page]` | 当前项目历史，每页 20 项 | `/history 2` |
| `/history --tree` | 展示当前会话的分支因果树 | `/history --tree` |
| `/history --search <query>` | 跨项目全文检索（分词、`"短语"`、`project:` / `branch:` / `tag:` 限定） | `/history --search "并发调度"` |
| `/history --all [page]` | 跨项目全局会话漫游 | `/history --all 2` |
| `/history --agents` | 列出后台子代理任务树 | `/history --agents` |
| `/resume [id]` | 选择历史或按 ID/唯一前缀续答（v1 历史续答前自动升级副本） | `/resume` |
| `/branch`、`/branch switch <branchId>`、`/branch <recordId> [name]` | 列出分支、切换活动分支、以指定记录为切点分叉并自动切换；未闭合工具事务拒绝分叉 | `/branch msg-12 perf-lab` |
| `/fork [title]` | 把当前活动分支导出为独立新会话并切换，导入历史不计入新会话费用 | `/fork 性能实验` |
| `/archive <id>`、`/archive list [page]`、`/archive restore <id>` | 逻辑归档、浏览归档清单与恢复；运行中会话禁止归档 | `/archive list` |
| `/agents`、`/agents show <id>`、`/agents cancel <id>`、`/agents collect <id>` | 观测任务树、查看明细、取消任务、把终态通知注入来源分支（异分支拒绝） | `/agents collect a1b2` |
| `/rename <title>` | 修改当前会话标题 | `/rename 上下文设计` |
| `/context` | 查看保护范围、预算、剪裁与有效检查点 | `/context` |
| `/compact` | 空闲时手动摘要旧完整交互 | `/compact` |
| `/permissions [mode]`、`/mode` | 查询或切换权限；FullAccess 显式确认 | `/permissions plan` |
| `/status` | 打印当前会话已载入工具列表及运行状态 | `/status` |
| `/logs [count]` | 最近 1–100 条运行与审批日志，默认 20 条 | `/logs 20` |
| `/instructions` | 查看当前加载的项目指令来源 | `/instructions` |
| `/skills [query]` | 检索已发现且已信任的技能清单（不加载正文） | `/skills pdf` |
| `/skill <name> [task...]` | 按技能名加载其说明并提交任务；省略任务时直接以默认启动语运行 | `/skill pdf-review 检查这份设计` |
| `/plugins [name]` | 查看已挂载插件及其能力贡献；指定名字看明细 | `/plugins mcp` |
| `/mcp` | 查看已配置服务清单、连接状态与能力统计 | `/mcp` |
| `/mcp tools <server>` | 列出该服务导出的工具及只读安全标记 | `/mcp tools git-tools` |
| `/mcp reconnect <server>` | 沿用当前已解析配置安全重连（代次单调递增） | `/mcp reconnect git-tools` |
| `/mcp enable\|disable <server>` | 会话内启停该服务的工具，纯内存生效、忙碌时拦截 | `/mcp disable git-tools` |
| `/prompts [query]` | 检索已就绪服务的 Prompt 模板元数据（不预取正文） | `/prompts review` |
| `/prompt <server/name> [arguments-json]` | 受控获取模板并作为单条 user 消息进入任务执行流 | `/prompt git-tools/commit "topic=docs"` |
| `/help [command]` | 与注册共用命令目录、别名和参数规则 | `/help resume` |
| `/exit` 或 `/quit` | 退出交互终端（**裸输入 `exit` / `quit` 亦可，无需斜杠**） | `/exit` |

### 快捷键规范 (Claude Code 风格状态机)

- **`Ctrl + C`（模型回答生成中）**：单次按下立即中止当前回答，等候模型、工具、摘要及存储清理，事务闭合落盘后才能切换；
- **`Ctrl + C`（输入框有内容时）**：单次按下立即**清空当前输入行**并重绘提示符；
- **`Ctrl + C`（输入框为空时）**：第 1 次提示 `(再按一次 Ctrl+C 退出程序)`，**1.5 秒内连按 2 次安全退出**；
- **`Ctrl + D`**：随时在空行触发 EOF 退出。

## 本地宿主（daemon / connect / serve）

在本仓库构建后，可使用 `kpbl daemon start` 启动本地宿主，`kpbl connect --workspace /absolute/project` 进入连接模式，`kpbl daemon stop` 等待清理并停止。非交互问答使用 `kpbl connect --workspace /absolute/project -p "解释项目结构"`；父进程托管使用 `kpbl serve --stdio`。

默认 CLI 行为保持不变；能力范围与预算见 [本地宿主说明](local-host.md)，当前稳定契约与迁移边界见 [v0.0.10 验收](verification/v0.0.10.md) 及[迁移说明](migration/v0.0.10.md)。
