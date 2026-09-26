<div align="center">

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png" />
    <img src="assets/logo.png" width="480" alt="Kapibala" />
  </picture>

  **心如止水，稳定如初 —— AI Agent Harness**

  <p><a href="package.json"><img src="https://img.shields.io/badge/version-0.0.2-blue.svg" alt="Version"></a> <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript" alt="TypeScript"></a> <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%E2%89%A520.0-green?logo=node.js" alt="Node.js"></a> <a href="https://pnpm.io/"><img src="https://img.shields.io/badge/pnpm-workspace-orange?logo=pnpm" alt="pnpm"></a> <a href="https://vitest.dev/"><img src="https://img.shields.io/badge/tested_with-Vitest-yellow?logo=vitest" alt="Vitest"></a> <a href="https://biomejs.dev/"><img src="https://img.shields.io/badge/code_style-Biome-60a5fa?logo=biome" alt="Code Style"></a> <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-purple.svg" alt="License"></a></p>

  <p>
    <a href="#-项目介绍">项目介绍</a> •
    <a href="#-核心特性">核心特性</a> •
    <a href="#-极速测试与启动-one-minute-quickstart">极简快速测试</a> •
    <a href="#-cli-使用指南-kpbl">CLI 使用指南</a> •
    <a href="#-sdk-使用指南-kituronekapibala">SDK 使用指南</a> •
    <a href="#-架构设计">架构设计</a> •
    <a href="#-配置系统">配置系统</a> •
    <a href="#-开发与本地测试">开发与测试</a> •
    <a href="#-版本与路线图">路线图</a>
  </p>

</div>

---

## 📖 项目介绍

**Kapibala**（意为**水豚 / 卡皮巴拉**，命令行启动命令为 **`kpbl`**）是一个从零构建的、面向生产级开发者的现代化 TypeScript AI Agent 底座（Agent Harness）与交互式 CLI 工具。

正如卡皮巴拉在自然界中以“情绪极其稳定、友善包容万物”著称，**Kapibala** 致力于为大模型 Agent 提供一个：
- **心如止水**：面对工具执行报错、网络抖动、模型幻觉，具备自动重试、熔断与上下文自愈能力，杜绝坏历史导致 API 400 报错；
- **连接万物**：规范消息模型（Canonical Message）与可插拔扩展架构（Plugin & Hook），解耦厂商差异，轻松串联各种工具与模型生态；
- **开箱即用**：以 **OpenAI API 兼容协议为主打**，内置 **8 家厂商 / 20 个模型**（DeepSeek、OpenAI、Anthropic、Google Gemini、通义千问、Kimi、智谱 GLM、本地 Ollama），深度覆盖 DeepSeek 原生思考推理链流式解析，并提供极度舒适的交互式 CLI 终端。

---

## ⚡ 核心特性

- 🌐 **OpenAI 兼容协议为主（零外部模型 SDK 依赖）**：基于 Node.js 原生 `fetch` 与轻量级 SSE 行解析器。原生支持 **DeepSeek**（含 `reasoning_content` 深度思考链流式分发与高亮）、**OpenAI**、**Anthropic**、**Google Gemini**、**通义千问**、**Kimi**、**智谱 GLM**、**本地 Ollama**，以及 OneAPI / vLLM / 任意兼容代理。**流式多分片 Tool Call 拼接还原**：自动按序号组装切片的工具参数，在流结束时反序列化为合法 JSON 并触发执行。
- 🎮 **流畅交互式 CLI 与 Slash 命令系统**：单一命令 `kpbl` 启动交互终端，支持打字机流式输出与思考链高亮；内置 `/model`、`/settings`、`/clear`、`/status`、`/help` 等斜杠命令；生成中 `Ctrl+C` 触发 `AbortController` 优雅中断并修补历史。
- 🧙 **首次冷启动向导 (First-Run Setup Wizard)**：全新环境自动引导选择提供商与密钥；内置只读连通性探测（`GET {baseURL}/models`，不产生计费 token），探测失败只告警不阻断 —— 私有网关常常未实现该端点。配置持久化至 `~/.kapibala/settings.json`（自动 0600 权限）。
- 🛡️ **安全沙箱与能力隔离 (PathSandbox)**：工具能力分层（`fs:read`、`fs:write`、`exec`、`net:outbound` 等）；沙箱强制校验工作区物理路径，防御 `../` 越界与 Symlink 穿透。内置工具：`read_file`、`write_file`、`edit_file`、`glob`、`grep`。
- 💾 **原子追加与崩溃历史自愈 (JSONL Message Store)**：消息级 JSONL Append-only 持久化，user / assistant / **tool_result** 全链路落盘，单行损坏自动容错跳过。**崩溃自愈**采用全历史扫描：任意位置悬挂的 `tool_use` 就地补合成错误响应，孤儿 `tool_result` 自动剔除，保证发往 API 的上下文结构始终合法。
- 📊 **细粒度步骤日志与关键性能指标**：每一执行阶段派发结构化日志事件（请求发起、首 Token 到达、流式结束、工具调用起止、单轮结束）。默认底栏展示 Git 分支、总耗时、上下文占用、本轮输入/输出 Token 与工具耗时；`--debug` 追加 **TTFT** 与模型耗时。
- 🧾 **可信执行（v0.0.2）**：默认写入脱敏的结构化运行日志与逐工具审批审计，记录人工批准、规则或模式自动批准、拒绝及操作结果；`--debug` 仅增加开发诊断。`Approval`、`Plan`、`Auto`、`FullAccess` 共享执行前授权门，`FullAccess` 只能在本次会话显式选择，且仍受显式规则和路径约束。
- 💻 **跨平台命令工具（v0.0.2）**：`run_command` 默认注册，每条命令仍需按当前模式审批或裁决；解释器发现只用 `PATH` 与运行时探针，Windows 自动按 native Bash → WSL → PowerShell 兜底（不写死安装路径），其他平台使用 Bash，也可用 `--shell` 指定解释器或其全路径、用 `--disable-shell` 关闭。命令进程以当前系统用户权限运行，不受文件工具的 PathSandbox 限制。
- 🧩 **Headless Core 与多宿主复用**：`@kiturone/kapibala` 只负责模型、循环、工具、历史、Hook 与结构化 `SessionEvent`，不包含任何终端 / GUI 组件；TUI、桌面、Web 等宿主消费同一套事件流。`pnpm check-architecture` 已加入 lint 门禁，防止 Core 反向依赖宿主。
- 🔒 **代码级凭证防泄漏防护**：独立的自动化密钥特征扫描脚本 `pnpm check-secrets` 并入 lint 流程；`.gitignore` 深度过滤环境密钥与历史数据，严禁真实 API Key 被意外提交。
- 🧭 **场景模型路由预留 (Role-based Model Routing)**：配置与核心接口原生支持 `default`、`planning`、`execution`、`summary`、`fast` 角色路由，内置默认分工为 **`deepseek-v4-pro`（深度规划推理）** + **`deepseek-flash`（高效代码执行）**（v0.0.1 仅持久化契约，运行时统一回退到 `defaultModel`）。

---

## 🚀 极速测试与启动 (One-Minute Quickstart)

需要 Node.js 20 或更高版本。CLI 和 Core SDK 均已发布到 npm；使用已发布版本无需克隆仓库。

### 从 npm 安装使用

```bash
# 临时运行 CLI（首次运行会引导配置模型和 API Key）
npx @kiturone/kapibala-cli@0.0.2

# 全局安装后在任意目录使用 kpbl
npm install -g @kiturone/kapibala-cli@0.0.2
kpbl

# 在自己的 Node.js / TypeScript 项目中使用 Core SDK
npm install @kiturone/kapibala@0.0.2
```

包页面：[CLI](https://www.npmjs.com/package/@kiturone/kapibala-cli) · [Core SDK](https://www.npmjs.com/package/@kiturone/kapibala)。

### 克隆仓库本地调试

如果你刚刚克隆了本项目，**一条命令**即可完成依赖安装、编译、全量校验并直接进入交互会话（运行的是当前源码，适合修改和调试）：

```bash
# 跨平台一键启动（Windows / macOS / Linux 通用）
pnpm dev
```

内部流程：**环境预检 → 依赖安装(按需) → 工作区链接自愈 → 编译 → 校验 → 启动**，校验（typecheck + test + lint）不通过会直接中断。

常用开关：`--no-start`（构建+校验后不启动，= `pnpm dev:build`）、`--verify-only`（只跑校验）、
`--no-build`（复用上次产物）、`--no-verify`（跳过校验，调试最快）、`--clean`（从零重建）、
`-p "问题"`（单次问答）、`--global`（注册全局 `kpbl`）。完整清单以 `node scripts/dev.mjs --help` 为准。

---

## 🖥️ CLI 使用指南 (`kpbl`)

### 1. 启动方式速览

```bash
kpbl                             # 启动交互式会话终端 (REPL)
kpbl "请帮我查看当前目录结构"    # 免交互单次会话模式 (直接问答并退出)
kpbl -m deepseek-v4-pro          # 指定深度推理模型启动终端
kpbl -m deepseek-flash --api-key "sk-xxx"   # 临时传入 Key 快速测试（不修改配置文件）

# 本地源码调试：pnpm dev 进 REPL；或编译后直接运行产物
pnpm build && node packages/cli/dist/bin.js
# 监听源码变化：pnpm dev:cli（tsup --watch，只重建不启动 REPL，需另开终端跑产物）
# 链接为全局命令：pnpm build && pnpm link:cli，之后任意终端直接输入 kpbl
```

### 2. 命令行选项 (CLI Options)

```text
选项:
  -m, --model <id>       指定要使用的模型 profile id (如 deepseek-flash, claude-opus-5)
  -p, --prompt <text>    直接执行单次问答并输出结果 (免进入 REPL)
  --base-url <url>       临时覆盖模型 API 端点 (例如使用自建代理/中转)
  --api-key <key>        临时指定 API 密钥
  --debug                向 stderr 输出脱敏开发诊断与每步阶段耗时
  --permission <mode>    本次会话权限: approval|plan|auto|full-access
  --shell <kind>         命令解释器: auto|bash|pwsh|powershell
  --disable-shell        关闭默认命令工具
  -v, --version          查看当前版本
  -h, --help             查看帮助信息
```

v0.0.2 开发版默认保存脱敏的运行日志和逐工具审计于 `~/.kapibala/logs/`、`~/.kapibala/audit/`；使用 `/logs [count]` 查看最近记录，`/status` 查看路径。审计记录操作 ID、工具调用 ID、审批来源和结果，不保存原始提示词、命令输出、密钥或完整命令；完整命令可能出现在已有会话历史中。`--debug` 增加的诊断也经过脱敏。命令的大输出保存在工作区 `.kapibala/tool-results/`，可用 `read_file` 按行读取；这些文件随工作区权限可见。

### 3. 初次冷启动向导 (Setup Wizard)

初次使用且本机尚未配置任何 API Key 时，系统将自动弹出交互向导。厂商清单取自内置目录，**2 步选择**（先选厂商、再选档位）：

```text
🐾 欢迎使用 Kapibala (kpbl)!
检测到当前尚未配置可用的模型服务。请选择您要使用的提供商：

  1) DeepSeek (推荐默认) —— 国内直连、极速响应与旗舰推理能力 (2个模型)
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

### 4. 终端内置 Slash 命令与快捷键

进入交互终端后，提示符将动态展示当前模型 `kpbl (model-id) ❯ `。

#### 🎮 `/model` 两步分级交互式菜单

输入 `/model` 进入两步选择流程（**第一步选提供商，第二步选具体模型**），按 **`↑`/`↓`** 移动、**`Enter`** 确认、数字键 `1`-`9` 盲按直选、**`Esc`** 取消：

```text
? 第一步：请选择模型提供商 (Provider)
  ❯ ● 1) DeepSeek [当前提供商] - 国内直连、极速响应与旗舰推理能力 · 2个模型 · 🔑 已配置密钥
    ○ 2) OpenAI - GPT-6 Astra / GPT-5.6 Sol·Terra·Luna · 4个模型 · ⚠️ 未配置密钥
    ...（每个厂商直接标注密钥就绪状态；只列有模型的厂商，末尾恒定向导 / 更新密钥 / 设为默认三项）

? 第二步：请选择【DeepSeek】的具体模型
  ❯ ● 1) DeepSeek Flash (V4.1-Flash) [当前使用] - deepseek-flash | 1000k | 深度思考 · 🔑 已配置密钥
    ○ 2) DeepSeek V4 Pro (深度推理) - deepseek-v4-pro | 1000k | 深度思考 · 🔑 已配置密钥
    ○ 3) ⬅️ 返回上一级 (重新选择提供商)
```

> 徽章 `[当前使用]`（正在用的模型）与 `[默认]`（全局默认模型）是**互斥**的：当前模型同时也是默认模型时，只显示前者。

#### 🔑 API Key 按厂商族共用（一个厂商只需配置一次）

| 行为 | 说明 |
|---|---|
| **复用** | 为 `gpt-5.6-terra` 填过 Key 后，同厂商其它模型自动复用，切换时打印 `🔑 复用 ... 的 API Key（来源）`，菜单里也标注密钥状态 |
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

> **未来规划（v0.0.8）**：将 `/` 升级为统一命令面板，聚合内置 Slash 命令、可调用的 Skills 与 MCP Prompt，支持模糊过滤、Tab 补全与 Esc 关闭；原始 MCP Tool 不进入该菜单。

#### ⌨️ 快捷键规范 (Claude Code 风格状态机)：
- **`Ctrl + C`（模型回答生成中）**：单次按下立即中止当前回答，已生成的历史自动修复闭合，会话上下文完好保留；
- **`Ctrl + C`（输入框有内容时）**：单次按下立即**清空当前输入行**并重绘提示符；
- **`Ctrl + C`（输入框为空时）**：第 1 次提示 `(再按一次 Ctrl+C 退出程序)`，**1.5 秒内连按 2 次安全退出**；
- **`Ctrl + D`**：随时在空行触发 EOF 退出。

---

## 🧩 SDK 使用指南 (`@kiturone/kapibala`)

`@kiturone/kapibala` 是一个独立的、高内聚低耦合的 Agent 核心引擎包。在使用 SDK 的项目中安装已发布版本：

```bash
npm install @kiturone/kapibala@0.0.2
```

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
    return { city: input.city, weather: '晴朗', temperature: '22°C' };
  },
});

// 注册工具至会话
session.tools.register(weatherTool);
```

---

### 3. 持久化、Hooks 与模型路由

```typescript
import { AgentSession, JSONLMessageStore } from '@kiturone/kapibala';

// 会话持久化：每次输入/输出均原子追加至 JSONL，启动时自动检查悬挂 tool_use 自愈
const store = new JSONLMessageStore('./.kapibala/messages.jsonl');
const session = new AgentSession({ defaultProfile: profile, defaultProvider: provider, store });

// 生命周期 Hook：不侵入核心循环即可拦截 / 监控工具执行、提示词装配、模型调用
session.hooks.on('tool:before', async (ctx, tool, input) => {
  console.log(`[审计] 即将调用工具: ${tool.name}，参数:`, input);
});
session.hooks.on('tool:after', async (ctx, tool, result) => {
  console.log(`[审计] 工具 ${tool.name} 执行完成`);
});

// 场景模型路由：不同职责分配给不同模型（规划用旗舰推理档，编码执行用快速档）
session.switchModel(plannerProfile, 'planning', plannerProvider);
session.switchModel(executorProfile, 'execution', executorProvider);
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
executor/  ──  工具调度、超时与 Hook 拦截 (依赖 types/ + tools/ + hooks/)
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
               ToolExecutor (超时 + 调度执行)    │
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
    }
  ]
}
```

> `contextWindow` 同时接受整数与带单位的字符串（如 `1000000`、`"1M"`、`"256K"`），`K/M` 按十进制换算、大小写不敏感；不接受容易与字节混淆的 `KB/MB`。未配置时按 `1M` 作为展示估算值。

> **`profiles` 只需要写你自己关心或自建的模型。** 内置清单由程序侧提供，缺哪家就在运行时从代码里补哪家；重复抄一份进配置只会得到一份会过期的快照。因此这个数组**允许为空**，`~/.kapibala/settings.json` 里通常只有你填过密钥的那几条。

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

清单版本号记录在 `settings.json` 的 `builtinCatalogVersion` 字段（由程序写入，无需手改）。启动时若发现它落后于当前版本，会**自动做一次目录升级**：已退役的模型 id 被**重定向**到现役档位（密钥一并带过去，密钥丢失不可逆，绝不直接删），仍在内置清单里的 profile 会同步过期的 `baseURL` / `modelName` / 上下文窗口，`defaultModel` 与 `modelRouting` 里指向旧 id 的引用被改写 —— 且**不会写入任何你从未启用过的内置模型**，升级只整理你已有的配置。

---

## 🧪 开发与本地测试

本节命令需在克隆后的仓库根目录运行，用于测试和调试当前源码；`npx @kiturone/kapibala-cli@0.0.2` 运行的是 npm 上的已发布版本。日常开发只需一条 `pnpm dev`（编译 → 校验 → 进 REPL），若只想要构建与校验、不启动会话，用 `pnpm dev:build`。

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 一键：依赖 → 链接自愈 → 编译 → 校验 → REPL |
| `pnpm dev:build` | 编译 + 校验，但不启动 REPL |
| `pnpm verify` | 完整门禁：typecheck → test → lint（含密钥扫描） |
| `pnpm build` | 编译构建所有包 (Core + CLI) |
| `pnpm typecheck` | 全量类型检查 (`src` + `tests` + `examples`)，防止类型错误被 tsup 静默放过 |
| `pnpm test` | 运行 Vitest 全套单元测试（沙箱防御 / SSE 还原 / 落盘自愈 / 循环回填与中断路径等） |
| `pnpm test:watch` | 监听模式运行单测 |
| `pnpm check-secrets` | API Key 凭证防泄露安全扫描（禁止提交任何真实 Key） |
| `pnpm lint` / `pnpm format` | Biome 代码风格检查 / 自动格式化与修复 |
| `npx tsx examples/minimal.ts` | 运行最小化 SDK 验证脚本 |

---

## 🗺️ 版本与路线图

v0.0.1 既有能力增强明细、版本号规则与完整的版本路线图已移至独立文档：**[docs/RELEASES.md](docs/RELEASES.md)**。

---

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 开源协议。
