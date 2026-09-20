<div align="center">

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png" />
    <img src="assets/logo.png" width="480" alt="Kapibala" />
  </picture>

  **心如止水，稳定如初 —— AI Agent Harness**

  <p><a href="package.json"><img src="https://img.shields.io/badge/version-0.0.1-blue.svg" alt="Version"></a> <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript" alt="TypeScript"></a> <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%E2%89%A520.0-green?logo=node.js" alt="Node.js"></a> <a href="https://pnpm.io/"><img src="https://img.shields.io/badge/pnpm-workspace-orange?logo=pnpm" alt="pnpm"></a> <a href="https://vitest.dev/"><img src="https://img.shields.io/badge/tested_with-Vitest-yellow?logo=vitest" alt="Vitest"></a> <a href="https://biomejs.dev/"><img src="https://img.shields.io/badge/code_style-Biome-60a5fa?logo=biome" alt="Code Style"></a> <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-purple.svg" alt="License"></a></p>

  <p>
    <a href="#-项目介绍">项目介绍</a> •
    <a href="#-核心特性">核心特性</a> •
    <a href="#-极速测试与启动-one-minute-quickstart">极简快速测试</a> •
    <a href="#-cli-使用指南-kpbl">CLI 使用指南</a> •
    <a href="#-sdk-使用指南-kituronekapibala">SDK 使用指南</a> •
    <a href="#-架构设计">架构设计</a> •
    <a href="#-配置系统">配置系统</a> •
    <a href="#-开发与本地测试">开发与测试</a> •
    <a href="#-版本路线图">路线图</a>
  </p>

</div>

---

## 📖 项目介绍

**Kapibala**（意为**水豚 / 卡皮巴拉**，命令行启动命令为 **`kpbl`**）是一个从零构建的、面向生产级开发者的现代化 TypeScript AI Agent 底座（Agent Harness）与交互式 CLI 工具。

正如卡皮巴拉在自然界中以“情绪极其稳定、友善包容万物”著称，**Kapibala** 致力于为大模型 Agent 提供一个：
- **心如止水**：面对工具执行报错、网络抖动、模型幻觉，具备自动重试、熔断与上下文自愈能力，杜绝坏历史导致 API 400 报错；
- **连接万物**：规范消息模型（Canonical Message）与可插拔扩展架构（Plugin & Hook），解耦厂商差异，轻松串联各种工具与模型生态；
- **开箱即用**：以 **OpenAI API 兼容协议为主打**，内置 **8 家厂商 / 20 个模型**（DeepSeek、OpenAI、Anthropic、Google Gemini、通义千问、Kimi、智谱 GLM、本地 Ollama），深度覆盖 DeepSeek 原生思考推理链折叠解析，并提供极度舒适的交互式 CLI 终端。

---

## ⚡ 核心特性

- 🌐 **OpenAI 兼容协议为主（零外部模型 SDK 依赖）**
  - 基于 Node.js 原生 `fetch` 与轻量级原生 SSE（Server-Sent Events）行解析器，不依赖臃肿的第三方 SDK。
  - 原生支持 **DeepSeek**（含 `reasoning_content` 深度思考链流式分发与折叠展示）、**OpenAI**、**Anthropic**、**Google Gemini**、**通义千问**、**Kimi**、**智谱 GLM**、**本地 Ollama**，以及 OneAPI / vLLM / 任意兼容代理。
  - **流式多分片 Tool Call 拼接还原**：自动按序号组装切片的工具参数，在流结束时反序列化为合法 JSON 并触发执行。

- 🎮 **流畅交互式 CLI 与 Slash 命令系统**
  - 单一命令 `kpbl` 启动交互终端，支持打字机流式输出与思考链高亮展示。
  - 内置斜杠控制命令：`/model`（查看/热切换）、`/model setup`（重新配置）、`/settings`（查看配置）、`/clear`（重置会话）、`/status`（查看用量与已载工具）、`/help` 等。
  - 智能信号处理：生成中按下 `Ctrl+C` 触发 `AbortController` 优雅中断模型生成并修补历史，空闲时双击、`/exit` 或直接输入 `exit` 退出。

- 🧙 **首次冷启动向导 (First-Run Setup Wizard)**
  - 全新环境无配置时，启动自动引导用户选择提供商、输入 API Key 或端点。
  - 内置**只读**连通性探测（`GET {baseURL}/models`，不产生计费 token）：探测失败或密钥被拒时给出明确提示，但**不阻塞**配置保存 —— 私有网关常常未实现该端点，强行拦截反而会挡住正常配置。
  - 验证后持久化至用户级全局配置 `~/.kapibala/settings.json`（自动设置 0600 安全权限）。

- 🛡️ **安全沙箱与能力隔离 (PathSandbox)**
  - 工具能力分层（`fs:read`、`fs:write`、`exec`、`net:outbound` 等）。
  - 内置沙箱强制校验工作区物理路径，有效防御 `../` 越界逃逸与危险符号链接（Symlink）穿透。
  - 内置开箱即用工具：`read_file`、`write_file`、`edit_file`、`glob`、`grep`。

- 💾 **原子追加与崩溃历史自愈 (JSONL Message Store)**
  - 消息级 JSONL Append-only 持久化：user / assistant / **tool_result** 三条链路全部落盘，遇到单行损坏脏数据自动容错跳过。
  - **崩溃自愈机制**：采用**全历史扫描**而非只看末尾 —— 任意位置悬挂的 `tool_use` 都会就地补上合成的错误响应（Complete-with-error），孤儿 `tool_result` 也会被剔除，保证发往 API 的上下文结构始终合法。

- 📊 **细粒度步骤日志与关键性能指标 (Step Logs & Metrics)**
  - 核心引擎在每一执行阶段派发结构化日志事件（请求发起、首 Token 到达、流式结束、工具调用起止、单轮结束），方便追踪与性能优化。
  - **关键指标毫秒级捕获**：实时测量并展示 **首 Token 耗时 (TTFT: Time To First Token)**、模型耗时、工具耗时、单轮总耗时，以及精确的 **Token 消耗量（输入 Token、输出 Token、总 Token）**。

- 🔒 **代码级凭证防泄漏防护 (Secret Leak Prevention)**
  - 建立严格的安全凭证防提交防护网，提供独立的自动化密钥特征扫描脚本 `pnpm check-secrets`，并集成进代码检查流程。
  - `.gitignore` 深度过滤所有环境密钥、局部配置文件与历史数据，严禁真实 API Key 被意外提交。

- 🧭 **场景模型路由预留 (Role-based Model Routing)**
  - 配置与核心接口原生支持 `default`、`planning`、`execution`、`summary`、`fast` 角色路由，内置默认分工为 **`deepseek-v4-pro`（深度规划推理）** + **`deepseek-flash`（高效代码执行）**（v0.0.1 仅持久化契约，运行时统一回退到 `defaultModel`）。

---

## 🚀 极速测试与启动 (One-Minute Quickstart)

如果你刚刚克隆了本项目，**一条命令**即可完成依赖安装、编译、全量校验并直接进入交互会话：

```bash
# 跨平台一键启动（Windows / macOS / Linux 通用）
pnpm dev

# 等价写法：Windows 可双击 scripts/dev.cmd，macOS / Git Bash 用 bash scripts/dev.sh
# 详细参数见：node scripts/dev.mjs --help
```

该脚本的内部流程为：**环境预检 → 依赖安装(按需) → 工作区链接自愈 → 编译 → 校验 → 启动**，
校验（typecheck + test + lint）不通过会直接中断，避免带着红灯进入对话。

常用开关：`--no-start`（构建+校验后不启动）、`--verify-only`（只跑校验）、`--no-build`（复用上次产物）、
`--no-verify`（跳过校验）、`--clean`（从零重建）、`--skip-install`、`--global`（注册全局 `kpbl`）。
完整清单以 `node scripts/dev.mjs --help` 为准。

如需逐步手动执行，对应命令如下：

```bash
# 1. 安装依赖并编译构建
pnpm install
pnpm build

# 2. 运行全套单元测试（秒级验证沙箱防御/SSE 还原/落盘自愈/循环回填/命令分发）
pnpm test

# 2.1 运行全量类型检查（src + tests + examples 一起检，避免类型错误被 tsup 静默放过）
pnpm typecheck

# 3. 免全局安装，直接运行打包产物启动 CLI 交互体验
node packages/cli/dist/bin.js
```

### ⚡ 常用测试命令速查表

| 测试场景 | 最简命令 | 说明 |
|---|---|---|
| **一键编译 + 校验 + 启动** | `pnpm dev` | 跨平台（Win/mac/Linux），等价于 install → build → verify → REPL |
| **编译 + 校验，但不启动** | `pnpm dev:build` | 等价于 `node scripts/dev.mjs --no-start`：依赖 → 链接自愈 → 编译 → 校验后停在启动前 |
| **只跑校验（不编译、不启动）** | `node scripts/dev.mjs --verify-only` | 完整门禁 typecheck + test + lint（含密钥扫描），与 `pnpm verify` 同源 |
| **快速进入 REPL（跳过校验）** | `node scripts/dev.mjs --no-verify` | 跳过 typecheck / test / lint，调试时最快 |
| **单次问答（不进入 REPL）** | `node scripts/dev.mjs -p "看看当前目录"` | 一次性提问并输出结果后退出 |
| **从零重新构建** | `node scripts/dev.mjs --clean` | 清理 dist 与 .tsup 缓存后重新编译 |
| **监听见效模式（只重建不启动）** | `pnpm dev:cli` | `tsup --watch` 监听源码并重建，需另开终端运行产物 |
| **带 Key 临时体验** | `node scripts/dev.mjs -m deepseek-flash --api-key "sk-xxx"` | 不修改本地配置，临时指定密钥运行一次 |
| **测试指定推理模型** | `node scripts/dev.mjs -m deepseek-v4-pro` | 体验 DeepSeek V4 Pro 思考过程与推理流式输出 |
| **全局链接后测试** | `pnpm link:cli` ➡️ 任意终端直接输入 `kpbl` | 一键全局注册系统命令 |
| **自动化测试套件** | `pnpm test` | 运行 Vitest 自动化单元测试（全部通过） |
| **全量类型检查** | `pnpm typecheck` | 覆盖 `src` / `tests` / `examples`，防止类型错误被 tsup 静默放过 |
| **一键校验** | `pnpm verify` | 依次执行 typecheck → test → lint |
| **代码规范与格式** | `pnpm lint` | 运行 Biome 极速静态检查 |
| **SDK 极简代码测试** | `npx tsx examples/minimal.ts` | 运行底层 SDK 基础会话与工具加载示例 |

---

## 🖥️ CLI 使用指南 (`kpbl`)

### 1. 安装与启动方式

#### 方式一：本地全局链接为 `kpbl` 命令（推荐）
在项目根目录下编译后执行一键软链接：
```bash
# 1. 编译构建
pnpm build

# 2. 全局链接 CLI 命令（内部执行 cd packages/cli && npm link）
pnpm link:cli

# 3. 链接成功后，在系统任意终端均可直接执行：
kpbl
```

#### 方式二：一键开发脚本（推荐，跨平台）
```bash
# 在项目根目录下：自动完成 依赖安装 → 编译 → 校验 → 启动
pnpm dev

# Windows 也可直接双击 scripts/dev.cmd；
# macOS / Git Bash 用 bash scripts/dev.sh
# 常用参数：--no-verify（跳过校验）、--clean（从零重建）、-p "问题"（单次问答）
```

#### 方式三：只重建不启动（源码监听）
```bash
# tsup --watch：监听源码变更并重新打包，不会启动 REPL，
# 需另开一个终端运行产物：
pnpm dev:cli
node packages/cli/dist/bin.js
```

#### 方式四：直接运行打包产物
```bash
node packages/cli/dist/bin.js
```

---

### 2. 命令行选项 (CLI Options)

```text
🐾 Kapibala (kpbl) v0.0.1 - Production-grade TypeScript AI Agent Harness

使用方式:
  kpbl [选项] [问题/指令]

示例:
  kpbl                             # 启动交互式会话终端 (REPL)
  kpbl "请帮我查看当前目录结构"    # 免交互单次会话模式 (直接问答并退出)
  kpbl -m deepseek-v4-pro          # 指定深度推理模型启动终端

选项:
  -m, --model <id>       指定要使用的模型 profile id (如 deepseek-flash, claude-opus-5)
  -p, --prompt <text>    直接执行单次问答并输出结果 (免进入 REPL)
  --base-url <url>       临时覆盖模型 API 端点 (例如使用自建代理/中转)
  --api-key <key>        临时指定 API 密钥
  --debug                输出详细调试日志与每步阶段耗时
  -v, --version          查看当前版本
  -h, --help             查看帮助信息
```

#### 常用命令示例：
```bash
# 场景 1：极简单次问答 (类似于 Claude Code `claude "xxx"`)
kpbl "帮我用 TypeScript 写一个防抖函数 debounce"

# 场景 2：启动交互终端 (REPL)
kpbl

# 场景 3：指定使用 DeepSeek V4 Pro 深度推理模型
kpbl -m deepseek-v4-pro

# 场景 4：临时传入 Key 快速测试（不修改本地配置文件）
kpbl -m deepseek-flash --api-key "sk-xxxxxxxx"
```

---

### 3. 初次冷启动向导体验 (Setup Wizard)

初次使用且本机尚未配置任何 API Key 时，系统将自动弹出交互向导。厂商清单取自内置目录，**2 步选择**（先选厂商、再选档位）：

```text
🐾 欢迎使用 Kapibala (kpbl)!
检测到当前尚未配置可用的模型服务。请选择您要使用的提供商：

  1) DeepSeek (推荐默认) —— 国内直连、极速响应与旗舰推理能力 (2个模型)
  2) OpenAI —— GPT-6 Astra / GPT-5.6 Sol·Terra·Luna (4个模型)
  3) Anthropic Claude —— Fable 5.1 / Opus 5 / Sonnet 5 / Haiku 4.5 (4个模型)
  4) Google Gemini —— Gemini 3.1 Pro / Gemini 3 Flash (2个模型)
  5) 通义千问 (Qwen) —— 阿里云官方 DashScope 兼容模式 (3个模型)
  6) Kimi (月之暗面) —— Kimi K3 / K2.7 Code (2个模型)
  7) 智谱 GLM —— GLM-5.3 / GLM-5.3-Flash (2个模型)
  8) 本地 Ollama —— 完全本地运行开源模型，无须 API Key (1个模型)
  9) 自定义 OpenAI 兼容接口 —— OneAPI / vLLM / 代理

请输入选项 [1-9] (默认 1): 1

  1) DeepSeek Flash (V4.1-Flash) —— deepseek-flash | 1000k | 深度思考
  2) DeepSeek V4 Pro (深度推理) —— deepseek-v4-pro | 1000k | 深度思考
请选择具体模型 [1-2] (默认 1): 1

请输入您的 DeepSeek API Key (sk-...): sk-********************

⏳ 正在验证连接与可用性...
✔ 连接验证成功 (HTTP 200)
✔ 配置已成功持久化至全局：~/.kapibala/settings.json
已就绪！当前默认模型：DeepSeek Flash (V4.1-Flash) (deepseek-flash)

kpbl (deepseek-flash) ❯ 
```

> 若探测返回 401/403，会提示「端点可达但密钥被拒绝」；若端点不可达或未实现 `GET /models`，会提示「未能验证连通性」。
> 两种情况都只告警、不阻断 —— 配置照常保存，避免私有网关被误挡在门外。
>
> 若该厂商族已有可用密钥，向导不会让你重新粘贴，而是先问一句：
> `检测到 DeepSeek 的可用 API Key（来自同厂商模型 'deepseek-flash'）。直接复用？[Y/n]:` —— 默认直接复用。

---

### 4. 终端内置 Slash 命令与快捷键 (参考 Claude Code CLI 体验)

进入交互终端后，提示符将动态展示当前模型 `kpbl (model-id) ❯ `，可随时使用以下操作：

#### 🎮 `/model` 两步分级交互式菜单
输入 `/model` 将进入清晰的两步分级选择流程（**第一步选提供商，第二步选具体模型**），告别复杂记忆与输入：

**第一步：选择模型提供商 (Provider)**
```text
? 第一步：请选择模型提供商 (Provider) (按 ↑/↓ 移动，回车确认，Esc 取消)
  ❯ ● 1) DeepSeek [当前提供商] - 国内直连、极速响应与旗舰推理能力 · 2个模型 · 🔑 已配置密钥
    ○ 2) OpenAI - GPT-6 Astra / GPT-5.6 Sol·Terra·Luna · 4个模型 · ⚠️ 未配置密钥
    ○ 3) Anthropic Claude - Fable 5.1 / Opus 5 / Sonnet 5 / Haiku 4.5 · 4个模型 · ⚠️ 未配置密钥
    ○ 4) Google Gemini - Gemini 3.1 Pro / Gemini 3 Flash · 2个模型 · ⚠️ 未配置密钥
    ○ 5) 通义千问 (Qwen) - 阿里云官方 DashScope 兼容模式 · 3个模型 · ⚠️ 未配置密钥
    ○ 6) Kimi (月之暗面) - Kimi K3 / K2.7 Code · 2个模型 · ⚠️ 未配置密钥
    ○ 7) 智谱 GLM - GLM-5.3 / GLM-5.3-Flash · 2个模型 · ⚠️ 未配置密钥
    ○ 8) 本地 Ollama - 完全本地运行开源模型，无须 API Key · 1个模型 · 免密钥
    ○ 9) ⚙️ 运行配置向导添加/配置新模型 (/model setup)
    ○ 10) 🔑 更新当前模型 [DeepSeek Flash (V4.1-Flash)] 的 API Key
    ○ 11) ⭐️ 将当前模型 [DeepSeek Flash (V4.1-Flash)] 设为全局默认
```

> 每个厂商直接标注密钥就绪状态（`🔑 已配置密钥` / `⚠️ 未配置密钥` / `免密钥`），
> 不必等切过去才发现还要补录。
>
> 注意厂商行的**序号是动态的**：只列「该分类下确实存在模型」的厂商（所以没配过自建端点就不会出现「自定义端点 / 其它」那一行），
> 末尾的向导 / 更新密钥 / 设为默认三项恒定收尾。

**第二步：选择该提供商下的具体模型**
```text
? 第二步：请选择【DeepSeek】的具体模型 (按 ↑/↓ 移动，回车确认，Esc 取消)
  ❯ ● 1) DeepSeek Flash (V4.1-Flash) [当前使用] - deepseek-flash | 1000k | 深度思考 · 🔑 已配置密钥
    ○ 2) DeepSeek V4 Pro (深度推理) - deepseek-v4-pro | 1000k | 深度思考 · 🔑 已配置密钥
    ○ 3) ⬅️ 返回上一级 (重新选择提供商)
```
> `deepseek-v4-pro` 自身并没有单独保存密钥 —— 它直接复用同厂商族的密钥，所以同样标注 `🔑 已配置密钥`。
>
> 徽章 `[当前使用]`（正在用的模型）与 `[默认]`（全局默认模型）是**互斥**的：当前模型同时也是默认模型时，只显示前者。

- 按键盘 **`↑` / `↓`** 移动高亮光标，按 **`Enter`** 即可选中并热切换；
- 支持数字键 **`1`-`9`** 极速盲按直选；
- 随时支持选 `⬅️ 返回上一级` 重新选择厂商，按 **`Esc`** 随时退出取消。

#### 🔑 API Key 按厂商族共用（一个厂商只需配置一次）

同一厂商的多个模型**共用同一份密钥**，不需要为每个模型重复输入：

| 行为 | 说明 |
|---|---|
| **复用** | 为 `gpt-5.6-terra` 填过 Key 后，切到 `gpt-6-astra` / `gpt-5.6-luna` 会自动复用，不再询问 |
| **可见** | 切换时打印 `🔑 复用 OpenAI 的 API Key（来自 'gpt-5.6-terra'）`，菜单里也直接标注各厂商的密钥状态 |
| **唯一** | 更新密钥时同厂商族的冗余副本会被自动清理，配置文件里始终只保留一份 |
| **隔离** | 8 家可识别厂商（DeepSeek / OpenAI / Anthropic / Google / 通义千问 / Kimi / 智谱 / Ollama）按厂商归组；**自定义端点按 host 隔离**，两个不同的自建网关不会串用密钥 |
| **不跨厂商** | 绝不做跨厂商兜底 —— 拿 OpenAI 的 Key 去打 DeepSeek 端点只会得到一条没头没尾的 401，排障成本极高 |

解析优先级：**本模型内联密钥 → 同厂商族已存密钥 → 本模型声明的环境变量 → 同族环境变量回退**。

#### 常用 Slash 指令一览表：

| 指令 | 作用说明 | 示例 |
|---|---|---|
| `/model` | **呼出交互式模型选择菜单** (支持上下键/数字键直选) | `/model` |
| `/model <id>` | 命令行快速切换模型 (高级快捷方式) | `/model deepseek-v4-pro` |
| `/model setup` | 重新唤出终端交互配置向导 | `/model setup` |
| `/model key [id]` | 更新指定模型（或其所属厂商族）的 API Key | `/model key gpt-5.6-terra` |
| `/model set-default <id>` | 将指定模型持久化为全局默认模型 | `/model set-default gpt-5.6-terra` |
| `/settings` | 查看当前生效的配置信息与加载路径 | `/settings` |
| `/clear` | 清空当前对话上下文历史，开启全新会话 | `/clear` |
| `/status` | 打印当前会话已载入工具列表及运行状态 | `/status` |
| `/help` | 打印可用 Slash 命令说明 | `/help` |
| `/exit` 或 `/quit` | 退出交互终端（**裸输入 `exit` / `quit` 亦可，无需斜杠**） | `/exit` |

#### ⌨️ 快捷键规范 (Claude Code 风格状态机)：
- **`Ctrl + C`（模型回答生成中）**：**单次按下立即中止当前回答**，已生成的历史自动修复闭合，会话上下文完好保留；
- **`Ctrl + C`（输入框有内容时）**：单次按下立即**清空当前输入行**并重绘提示符；
- **`Ctrl + C`（输入框为空时）**：按下第 1 次提示 `(再按一次 Ctrl+C 退出程序)`，**1.5 秒内连按 2 次安全退出程序**；
- **`Ctrl + D`**：随时在空行触发 EOF 退出。

---

## 🧩 SDK 使用指南 (`@kiturone/kapibala`)

`@kiturone/kapibala` 是一个独立的、高内聚低耦合的 Agent 核心引擎包。您可以在任何 Node.js / TypeScript 项目中将其作为底层框架使用。

### 1. 基础对话与流式事件监听

```typescript
import {
  AgentSession,
  OpenAICompatibleProvider,
  builtinTools,
  type ModelProfile,
} from '@kiturone/kapibala';

// 1. 定义模型配置
const profile: ModelProfile = {
  id: 'deepseek-flash',
  name: 'DeepSeek Flash (V4.1-Flash)',
  provider: 'openai-compatible',
  baseURL: 'https://api.deepseek.com/v1',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  modelName: 'deepseek-flash',
  supportsThinking: true,
};

// 2. 创建 OpenAI 兼容 Provider（原生 fetch + SSE 解析）
const provider = new OpenAICompatibleProvider({
  baseURL: profile.baseURL,
  apiKey: process.env.DEEPSEEK_API_KEY || 'sk-your-key',
  modelName: profile.modelName,
});

// 3. 构造 Session 会话门面
const session = new AgentSession({
  defaultProfile: profile,
  defaultProvider: provider,
  systemPrompt: 'You are an expert AI assistant powered by Kapibala.',
});

// 4. 注册内置安全文件工具 (read_file, write_file, edit_file, glob, grep)
for (const tool of builtinTools) {
  session.tools.register(tool);
}

// 5. 流式执行并消费事件
const stream = session.run('请帮我统计当前目录下的文件');

for await (const event of stream) {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.text);
      break;
    case 'thinking_delta':
      process.stdout.write(`\x1b[90m${event.thinking}\x1b[0m`);
      break;
    case 'tool_call_start':
      console.log(`\n[调用工具] ${event.name}...`);
      break;
    case 'tool_call_finish':
      console.log(`[工具入参]`, event.input);
      break;
    case 'message_stop':
      console.log(`\n[Token 用量]`, event.usage);
      break;
  }
}
```

---

### 2. 自定义业务工具 (Custom Tool)

通过 `defineTool` 可以为 Agent 扩展任意自定义业务工具，沙箱机制与权限系统会自动执行安全保障：

```typescript
import { defineTool, type ToolContext } from '@kiturone/kapibala';

// 定义一个数值计算工具
export const weatherTool = defineTool({
  name: 'get_weather',
  description: '获取指定城市的当前天气与气温',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名称，如北京、上海' },
    },
    required: ['city'],
  },
  metadata: {
    permissions: ['net:outbound'],
  },
  async execute(input: { city: string }, ctx: ToolContext) {
    // 执行业务逻辑或外部请求
    return {
      city: input.city,
      weather: '晴朗',
      temperature: '22°C',
    };
  },
});

// 注册工具至会话
session.tools.register(weatherTool);
```

---

### 3. 会话历史持久化与崩溃自愈 (`JSONLMessageStore`)

```typescript
import { AgentSession, JSONLMessageStore } from '@kiturone/kapibala';

// 指定 JSONL 消息落盘文件路径
const store = new JSONLMessageStore('./.kapibala/messages.jsonl');

const session = new AgentSession({
  defaultProfile: profile,
  defaultProvider: provider,
  store, // 会话每次输入/输出均原子追加至 JSONL，且启动时自动检查悬挂 tool_use 自愈
});
```

---

### 4. 注册生命周期钩子 (Hooks)

通过 Hook 系统可以在不侵入核心循环的前提下对工具执行、提示词装配、模型调用进行拦截与监控：

```typescript
// 在工具执行前进行日志打印或安全审计
session.hooks.on('tool:before', async (ctx, tool, input) => {
  console.log(`[审计] 即将调用工具: ${tool.name}，参数:`, input);
});

// 在工具执行完成后
session.hooks.on('tool:after', async (ctx, tool, result) => {
  console.log(`[审计] 工具 ${tool.name} 执行完成`);
});
```

---

### 5. 场景模型路由 (Role-based Routing)

Kapibala 内置支持将不同职责分配给不同模型（如规划用旗舰推理档，编码执行用快速档）：

```typescript
// 动态切换指定角色的模型
session.switchModel(plannerProfile, 'planning', plannerProvider);
session.switchModel(executorProfile, 'execution', executorProvider);

// 查看当前路由状态
console.log('默认模型:', session.getActiveProfile('default').name);
console.log('规划模型:', session.getActiveProfile('planning').name);
```

---

## 🏗️ 架构设计

### 模块分层与依赖方向（单向依赖，禁止反向）

```text
types/  ────────────────────────────────  纯规范契约层 (Canonical Message / Events)
   ▲
   ├── tools/  security/  hooks/  plugin/   ──  仅依赖 types/
   ├── models/   ──  仅依赖 types/ (原生 fetch + SSE 解析，隔离具体协议)
   ▲
executor/  ──  调度与沙箱拦截 (依赖 types/ + tools/ + security/ + hooks/)
   ▲
loop/  ──  核心执行逻辑 (依赖 types/ + models/ + hooks/ + executor/)
   ▲
session/  ──  组合完整能力门面 (依赖 loop/ + store/ + prompt/ + router/ 等)
```

### 核心执行循环时序 (AgentLoop)

```text
User Input ──► session.run() 
                    │
                    ▼
               AgentLoop ◄────────────────────────┐
                    │ (分层组装上下文与提示词)            │
                    ▼                             │
               ModelProvider (OpenAI-compatible)  │ (模型生成 tool_use)
                    │                             │
                    ▼                             │
               ToolExecutor (沙箱校验 + 调度执行)    │
                    │                             │
                    ▼                             │
               回填规范 ToolResults ───────────────┘
                    │ (达到最终自然语言答复)
                    ▼
               JSONL 完整落盘 & 结束单轮交互
```

---

## ⚙️ 配置系统

Kapibala 采用统一规范的 `.kapibala` 目录与 `settings.json` 命名。

### 配置文件优先级与位置

1. **运行时 Slash 指令**（最高优先级）：`/model <id>`
2. **CLI 启动参数**：`--model <id>`、`--base-url <url>`、`--api-key <key>`
3. **环境变量**：`OPENAI_API_KEY`、`DEEPSEEK_API_KEY`、`OPENAI_BASE_URL` 等
4. **工作区项目级配置**：`./.kapibala/settings.json`
5. **全局用户配置**：`~/.kapibala/settings.json`（Windows 为 `%USERPROFILE%\.kapibala\settings.json`）

### 智能配置补全 (`$schema`) 与配置格式

配置文件首行声明 `$schema`，在 VS Code / Cursor 等编辑器中自动享有**自动补全、格式校验与字段文档悬浮提示**：

```json
{
  "$schema": "https://raw.githubusercontent.com/tedburner/kapibala/main/schemas/settings.schema.json",
  "defaultModel": "deepseek-flash",
  "modelRouting": {
    "planning": "deepseek-v4-pro",
    "execution": "deepseek-flash"
  },
  "builtinCatalogVersion": 2,
  "profiles": [
    {
      "id": "deepseek-flash",
      "name": "DeepSeek Flash (V4.1-Flash)",
      "provider": "openai-compatible",
      "baseURL": "https://api.deepseek.com/v1",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "modelName": "deepseek-flash",
      "contextWindow": 1000000,
      "supportsThinking": true
    },
    {
      "id": "custom-my-gateway-https-gw-example-com-v1",
      "name": "My Gateway",
      "provider": "openai-compatible",
      "baseURL": "https://gw.example.com/v1",
      "apiKeyEnv": "CUSTOM_API_KEY",
      "modelName": "gpt-5.6-terra"
    }
  ]
}
```

> **`profiles` 只需要写你自己关心或自建的模型。** 内置清单由程序侧提供（见下节），
> 缺哪家就在运行时从代码里补哪家；重复抄一份进配置只会得到一份会过期的快照 ——
> 厂商换代的第二天，它还指着已经 404 的 `modelName`。
> 因此这个数组**允许为空**，`~/.kapibala/settings.json` 里通常只有你填过密钥的那几条。

### 内置模型清单与自动升级

内置清单共 **8 家厂商 / 20 个模型**，默认模型为 `deepseek-flash`：

| 厂商 | 模型 id | 上下文 | 深度思考 |
|---|---|--:|:--:|
| **DeepSeek** | `deepseek-flash`（V4.1-Flash，默认）<br>`deepseek-v4-pro`（深度推理） | 1000k | ✅ |
| **OpenAI** | `gpt-6-astra`（旗舰）<br>`gpt-5.6-sol`（复杂推理与编码）<br>`gpt-5.6-terra`（日常均衡）<br>`gpt-5.6-luna`（高吞吐低价） | 1050k | ✅ |
| **Anthropic** | `claude-fable-5-1`（最强推理）<br>`claude-opus-5`（复杂 Agent 与编码）<br>`claude-sonnet-5`（日常主力）<br>`claude-haiku-4-5`（最快最省） | 1000k<br>200k | ✅ |
| **Google** | `gemini-3.1-pro-preview`<br>`gemini-3-flash-preview` | 1000k | ✅ |
| **通义千问** | `qwen3.8-max`<br>`qwen3.8-flash`<br>`qwen3.7-plus` | 1000k | ✅ |
| **Kimi** | `kimi-k3`<br>`kimi-k2.7-code` | 1000k<br>256k | ✅ |
| **智谱 GLM** | `glm-5.3`<br>`glm-5.3-flash` | 1000k | ✅ |
| **本地 Ollama** | `ollama`（`gpt-oss:20b`，免密钥） | 131k | — |

清单版本号记录在 `settings.json` 的 `builtinCatalogVersion` 字段（由程序写入，无需手改）。
启动时若发现它落后于当前版本，会**自动做一次目录升级**：

- 已退役的模型 id 被**重定向**到现役档位，**密钥一并带过去**（密钥丢失不可逆，绝不能直接删）；
- 仍在内置清单里的 profile 会**同步**过期的 `baseURL` / `modelName` / 上下文窗口（`apiKey` 原样保留）；
- `defaultModel` 与 `modelRouting` 里指向旧 id 的引用被改写；
- **不写入任何你从未启用过的内置模型** —— 升级只整理你已有的配置，不会替你「扩充」清单。

历史退役 id 的重定向关系：`deepseek-chat` → `deepseek-flash`、`deepseek-reasoner` → `deepseek-v4-pro`、
`deepseek-v4-flash` → `deepseek-flash`、`gpt-4o` → `gpt-5.6-terra`、`gpt-4o-mini` → `gpt-5.6-luna`、
`o3-mini` → `gpt-5.6-sol`、`qwen-plus` → `qwen3.8-flash`。
（**从内置清单删掉任何 id 都必须在此补一条重定向**，否则它会在老用户配置里变成孤儿。）

---

## 🧪 开发与本地测试

Kapibala 拥有极高的代码质量与工程自洽性，包含全套单元测试与自动化规范检查。

日常开发只需一条 `pnpm dev`（编译 → 校验 → 进 REPL）；若只想要做完构建与校验、不启动会话，用 `pnpm dev:build`。以下为逐条手动命令：

```bash
# 1. 运行 API Key 凭证防泄露安全扫描 (禁止提交任何真实 Key)
pnpm check-secrets

# 2. 运行全部单测 (Vitest：包含沙箱穿透防御、SSE 还原、落盘自愈、循环回填与中断路径、性能指标与步骤日志)
pnpm test

# 3. 监听模式运行单测
pnpm test:watch

# 4. 运行安全扫描与 Biome 代码风格检查
pnpm lint

# 5. 自动格式化与代码修复
pnpm format

# 6. 编译构建所有包 (Core + CLI)
pnpm build

# 7. 全量类型检查 (src + tests + examples)
pnpm typecheck

# 8. 运行最小化 SDK 验证脚本
npx tsx examples/minimal.ts
```

---

## 🗺️ 版本路线图

| 版本 | 阶段重点 | 核心能力与扩展点 | 交付形态 |
|:---:|---|---|---|
| **v0.0.1** | **核心骨架与交互 CLI** (已完成) | OpenAI 兼容协议原生支持、带 Slash 命令的对话 CLI (`kpbl`)、首次配置向导、PathSandbox 沙箱、崩溃历史自愈、场景模型路由契约 | CLI (`kpbl`) + Core SDK |
| **v0.2** | **多协议与场景模型路由落地** | Anthropic 原生协议支持、场景模型路由激活（规划/执行模型物理分离调度）、`tool:before` 用户授权确认门 (`ApprovalChannel`)、企业级多层配置合并 | Core 内增量 |
| **v0.3** | **技能体系 (Skills)** | 渐进式披露 L2.5 提示词分层、按需动态加载 `load_skill`、Skill 独立权限集约束 | Core 内增量 |
| **v0.4** | **MCP 生态扩展** | Stdio / HTTP 动态连接、MCP 工具集动态批量上下线 (`registerSource`) | 独立包 `@kiturone/kapibala-mcp` |
| **v0.5** | **记忆与会话管理** | 多会话检索、基于 Hook 的上下文智能滚动压缩（由 Summary 专用模型驱动） | Core 内增量 |
| **v0.6** | **多智能体 (Sub-Agent)** | 子代理派生工具 `spawn_agent`（支持分配专属角色与隔离工作区） | Core 内增量 |
| **v0.7** | **富终端界面与遥测** | 现代 TUI 界面、增强交互体验、OpenTelemetry 分布式链路追踪 | 独立包 |

---

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 开源协议。
