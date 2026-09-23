# 001 — Agent Harness 技术方案(v0.0.1)

> 状态:已实现 · 2026-09-23(v0.0.1 审查修复与后续路线收紧)
> 范围:本篇定义 self-agent harness 的核心抽象、可插拔扩展架构、循环执行语义、安全模型与交付边界,是后续所有迭代的基线。
>
> **v0.0.1 核心变更记录**:
> 1. **版本号规范为 v0.0.1**: 遵循 SemVer 结构并采用项目十进制进位约定,作为初始极简可用交付的基线版本;补丁位只使用 0–9,`v0.0.9` 之后为 `v0.1.0`,不使用 `v0.0.10`。
> 2. **新增场景感知模型路由设计(Role-based Model Routing)**: 为解决"规划重推演、执行重吞吐与成本"的矛盾,在架构与配置契约层引入角色路由蓝图(如规划用 GPT-4o,循环执行用 DeepSeek),v0.0.1 预留契约与配置槽位。
> 3. **模型协议收敛至 OpenAI 兼容协议为主**: 第一期全力打磨 **OpenAI API 兼容协议**(涵盖原生 OpenAI、DeepSeek 原生与推理、Ollama 本地模型及兼容中转平台),统一验证流式 SSE、多工具回填与思考块;Canonical 消息模型保持双向解耦,Anthropic 协议规范保留在契约层,具体实现下沉至 v0.0.4。
> 4. **CLI 引入内建 Slash Command 控制体系**: REPL 不仅支持对话,还内建命令拦截器,首期支持 `/model [name]`(查看/热切换模型)、`/settings`、`/clear`(重置上下文)、`/status`(查看统计与配置)、`/help` 与 `/exit`。
> 5. **配置体系统一与首启向导**: 统一采用 `.kapibala` 目录与 `settings.json` 文件名,增加带 `$schema` 智能校验、首启交互式向导(Setup Wizard)与全局 `~/.kapibala/settings.json` 持久化机制。
> 6. **新增 §3 可插拔扩展架构**: 把 Plugin / Hook / Registry 契约前置,使 MCP、skill、权限后续都以**挂载**方式接入,不改 loop 代码。
> 7. **新增 §4 循环执行语义**: 补齐多工具调度、错误分类、中断恢复(双击 Ctrl+C / 单次 Abort)、落盘粒度四项必答问题。
> 8. **修正模块依赖与沙箱归属**: 厘清 `ToolExecutor` 归属执行流,消除 `tools/` 模块的循环依赖隐患。
> 9. **明确 v0.0.1 收尾增强边界**: 请求指标、工具调用展示、上下文窗口配置简写、跨平台启动与 PathSandbox/Hook 加固均继续归入 v0.0.1;权限审批、AGENTS.md、压缩、模型路由等新增子系统从 v0.0.2 起分版本交付。

## 1. 背景与定位

- **目标**:从零构建一个认真开源的 TypeScript agent harness。
- **形态**:v0.0.1 即提供**可用 CLI**——通过命令行完成 agent 对话、任务处理与**命令控制(如 `/model` 热切换)**,不做图形界面。CLI 是框架的第一个消费者,也是用户接触框架的门面。
- **技术栈**:TypeScript / Node.js ≥ 20,pnpm workspace monorepo。
- **核心决策**:
  - **框架与具体模型/工具解耦(v0.0.1 OpenAI 优先)**:核心抽象建立在规范消息模型之上。v0.0.1 重点实现并打磨 **OpenAI 兼容协议**(覆盖 OpenAI 官方、DeepSeek 原生及 reasoning 模式、Ollama、vLLM 及各类兼容中转),验证核心循环与工具调度。Anthropic 协议保留标准契约,实现延后至 v0.0.4。
  - **交互控制与会话状态自洽**:CLI 具备 Slash 命令分发能力,用户可在 REPL 内动态调整模型与配置(`/model`),Session 提供状态变更与重置 API。
  - **扩展靠挂载,不靠改代码**(见 §3):所有后续能力(MCP、skill、权限、压缩、sub-agent)都通过 Plugin + Hook 契约接入,核心循环对它们无感知。
  - 提示词分层组装,不做单块硬编码文本(见 §7)。

## 2. 核心抽象

### 2.1 规范消息/事件模型(Canonical Model)——适配层的关键

框架内部只使用一套**规范消息模型**(`CanonicalMessage` / `ContentBlock`),模型差异由各 Provider 在边界处双向翻译:

```
OpenAI-compatible wire (OpenAI / DeepSeek / Ollama 等) ──┐
                                                         ├── core(canonical) ◄── loop ──► session
Anthropic wire (v0.0.4+ 契约预留) ──────────────────────┘
```

**Headless Core / Host Adapter 边界**:

```text
CLI / TUI ─────────┐
桌面 GUI ──────────┼── Host Adapter ── AgentSession / SessionEvent ── Agent Harness Core
Web / 移动客户端 ──┘
```

- Core 只处理模型、循环、工具、历史、Hook、沙箱与语义事件,不包含终端控制码、交互输入或 UI 组件。
- `AgentSession.run()` 返回宿主无关的 `AsyncIterable<SessionEvent>`;文本、思考、工具、错误与指标都通过该事件流交付。
- CLI/TUI 可在同一进程直接消费事件;桌面渲染进程、Web 与移动客户端由守护进程或服务端托管 Core,再通过宿主传输层连接。
- v0.0.1 CLI 在每轮 `run_finish` 时由 Host Adapter 即时探测当前 Git 分支并置于底栏首位,默认其后按总耗时、上下文、本轮输入/输出 Token、工具次数/耗时排列,`--debug` 再追加模型耗时与 TTFT,不展示含义模糊的步骤指标,Token 使用 `K/M` 简写。Git 信息不得写入 canonical 消息或让 Core 依赖 Git;非 Git 目录、detached HEAD 或探测失败时省略该字段,不能阻断对话。更丰富的工作区状态栏仍归入 v0.0.8。
- v0.0.1 的 `SessionEvent` 是**进程内契约**,不是可直接长期兼容的网络协议。可序列化且带版本的 wire DTO、IPC/SSE/WebSocket 与本地守护进程归入 v0.0.9。
- `pnpm check-architecture` 扫描 `packages/core/src`,禁止 Core 反向依赖 CLI、直接读写终端或包含 ANSI 渲染;它随 `pnpm lint` 和 `pnpm verify` 执行。

- **入方向**(模型响应 → canonical):Provider 把自家流式响应(SSE)翻译为规范事件流。
  - **OpenAI 兼容协议**:解析 `choices[0].delta` 中的 `content`、`tool_calls` 以及 DeepSeek 特有的 `reasoning_content`(转为 canonical `thinking` 块)。
- **出方向**(canonical 历史 → wire):Provider 把规范历史转成自家请求格式,**包括工具结果的回填形态**(见 §4.1)。
- 收益:loop 与 session 完全不感知模型差异;新增模型只写一个翻译器。
- ⚠️ **模型切换时的兼容性清洗**:当用户在 CLI 运行时通过 `/model` 切换模型时,历史消息中的 `thinking` 块若目标模型不支持(如从 DeepSeek-R1 切到普通 GPT-4o),新 Provider 必须负责在序列化时**降级过滤或合入普通上下文**,防止下游 API 报 400 校验错误。

**ContentBlock 类型**(v0.0.1 重点消费前 4 类):

| 类型 | 说明 | v0.0.1 是否产生与消费 |
|---|---|---|
| `text` | 普通文本 | ✅ 产生并消费 |
| `tool_use` | 工具调用意图 | ✅ 产生并消费 |
| `tool_result` | 工具执行结果(含 `is_error`) | ✅ 产生并消费 |
| `thinking` | 推理内容(DeepSeek `reasoning_content` 等) | ✅ 产生(入方向流式展示) |
| `redacted_thinking` | 加密推理块,须原样回传 | ✅ 预留契约 |

> **为什么 v0.0.1 就要消费 `thinking`**:DeepSeek 的 `reasoning_content` 在当前版本就会大量出现。规范模型予以原生接纳后,CLI REPL 即可直接将思维链与正文分离渲染(如灰色字体折叠输出思考过程),极大提升开发调试体验。

### 2.2 模块清单

1. **AgentSession**(`session/`)— 一次对话会话。持有消息历史、能力注册表、当前 `ModelProfile` 与 Provider/Router、插件列表。
   - `session.run(input)`: 核心交互入口,返回事件流(`AsyncIterable<SessionEvent>`)。
   - **运行时控制 API**:
     - `session.switchModel(profile, role?)`: 动态热切换当前全局或特定角色(planning/execution)的模型。
     - `session.reset()`: 重置当前会话历史(供 `/clear` 命令调用)。
     - `session.getStats()`: 获取当前会话的轮次、已消耗 Token(prompt/completion)与加载的工具数。
2. **AgentLoop**(`loop/`)— 单次 run 内部的 while 循环:请求模型 → 消费规范事件流组装 assistant 消息 → 若有 tool_use 则经 **ToolExecutor** 执行、结果转 canonical → 继续请求,直到 stopReason 非 tool_use 或触达步数上限。**不直接做模型 IO**(模型走 ModelProvider/ModelRouter 接口),工具通过 ToolExecutor 间接调用。
3. **ModelProvider & ModelRouter**(`models/`)— 
   - **ModelProvider 接口**:负责将 canonical 请求转 wire 并返回事件流。
     - **v0.0.1 主打实现**: `openai-compatible/`(全面支持原生 OpenAI、DeepSeek、Ollama、vLLM 等)。
     - **v0.0.1 契约预留**: `anthropic/` 接口规范(具体适配实现定于 v0.0.4 交付)。
   - **ModelRouter 场景路由**:解耦执行与规划模型。定义 `resolve(role?: ModelRole): ModelProvider`,支持 planning(规划如 GPT-4o)与 execution(执行如 DeepSeek)多角色分发(v0.0.1 预留契约,默认退化为单一 defaultModel)。
4. **ToolExecutor**(`executor/` 或 `tools/executor.ts`)— 负责工具调用调度、超时控制与 Hook 拦截；v0.0.1 的内置文件工具自行调用 PathSandbox，统一执行前权限决策归入 v0.0.2。
5. **Tool**(`tools/`)— `{ name, description, parameters(JSON Schema), execute(input, ctx) }`。
6. **Event 流**(`events/`)— `SessionEvent` 统一枚举。上层一切(CLI/TUI/GUI/SDK/日志)只消费这个流;远程客户端由 Host Adapter 转为 v0.0.9 的 wire DTO。
7. **MessageStore**(`store/`)— 会话历史持久化,**消息级**落盘(见 §4.4)。
8. **Prompt**(`prompt/`)— 系统提示词分层组装器,见 §7。
9. **Hooks**(`hooks/`)— 扩展底座,见 §3.3。
10. **Plugin**(`plugin/`)— 插件契约,见 §3.2。
11. **Security**(`security/`)— 权限策略与沙箱,见 §6。
12. **Skills**(`skills/`)— 知识层注册表,见 §3.6。

### 2.3 Tool 与 Skill 的分层原则

基础能力一律做成 **tool(执行原语)**,不做成 skill;skill 是**知识层**,两者叠加而非替代:

| | Tool | Skill |
|---|---|---|
| 本质 | 执行原语——代码确定性执行 | 知识包——markdown 指令注入上下文 |
| 谁执行 | 代码,确定性、可单测 | 模型读指令后自行组合 tools |
| 上下文成本 | schema 常驻(小),调用时才产生结果 | 摘要常驻,正文按需加载(见 §7 L2.5) |
| 安全边界 | 代码级强制(权限 hook + 沙箱) | 靠模型遵循文字约定 |
| 与 loop 关系 | 参与执行循环,产生事件 | 不参与执行循环,只影响行为 |

- **判断规则**:参数完备、确定性执行、可单测 → tool;需要判断力、上下文知识、多步流程编排 → skill。
- **启发式**:里面要写 for 循环和 try/catch 的是 tool;要写大段"应该怎么判断"的是 skill。
- **为什么文件读写必须是 tool**:① 确定性;② 安全是代码问题不是提示词问题(沙箱校验必须每次调用由代码强制);③ 上下文经济学。
- skill 实现后,文件操作仍留在 tool 层不动——skill 承载的是"项目约定、操作规程"类知识。

### 2.4 模块边界与依赖方向(单向,禁止反向)

```
types/  ────────────────────────────────  纯类型层,零依赖
   ▲
   ├── tools/  skills/  security/  hooks/  plugin/   ──  只依赖 types/
   ├── models/   ──  只依赖 types/
   ▲
executor/  ──  工具调度、超时与 Hook 拦截(依赖 types/ + tools/ + hooks/)
   ▲
loop/  ──  核心执行逻辑(依赖 types/ + models/ + hooks/ + executor/)
   ▲
session/  ──  组合以上全部(依赖 loop/ + store/ + prompt/ 等)
```

- **tools/ 保持纯粹被动**:只包含 Tool 接口、注册表实现 `ToolRegistry` 与内置工具,**不反向依赖 hooks 或 security**。
- **ToolExecutor 承担执行与拦截**:负责驱动工具执行、触发 `tool:before`/`tool:after` hooks,并在执行前调用 `security/sandbox.ts` 进行 capability 校验。
- **loop 只依赖接口,不依赖任何具体实现**:模型请求走 `ModelProvider` 抽象,工具调用交给 `ToolExecutor`,loop 本身是纯逻辑驱动器。
- **每个模块以 `index.ts` 作为唯一公开出口**,内部文件不跨模块深引。
- `events/`、`message/`、`errors/` 是纯类型层,被所有模块依赖,自身不依赖任何模块。

## 3. 可插拔扩展架构(核心)

> **设计目标**:MCP、skill、权限、上下文压缩、sub-agent 这些能力,后续接入时都应该只做两件事——**实现一个 `AgentPlugin`,注册若干 Hook**。核心循环与既有模块**一行不改**。

### 3.1 三个契约撑起全部扩展性

| 契约 | 解决什么 | 类比 |
|---|---|---|
| **Plugin** | 能力的**生命周期**与**注册入口** | 插件主体 |
| **Hook** | 能力的**行为注入点**(拦截、改写、观测) | 中间件 |
| **Registry** | 能力的**命名空间**与**冲突仲裁** | 服务发现 |

三者关系是:Plugin 在 `setup()` 里通过 Registry 注册能力、通过 Hook 注入行为。

### 3.2 插件契约

```ts
export interface AgentPlugin {
  readonly name: string
  readonly version?: string
  setup(ctx: PluginContext): void | Promise<void>
  teardown?(): void | Promise<void>
}

export interface PluginContext {
  tools: ToolRegistry      // 注册/注销工具
  skills: SkillRegistry    // 注册 skill
  prompts: PromptRegistry  // 注册提示词层(L1~L4 之外的自定义层)
  hooks: HookRegistry      // 注入行为
  config: Readonly<AgentConfig>
  logger: Logger
}
```

- 插件**只依赖契约,不依赖 core 内部模块**——这是把 MCP 拆成独立包的前提。
- `teardown()` 保证资源可回收(MCP 连接、子进程、文件句柄)。

### 3.3 Hook 系统(扩展底座)

```ts
export type HookPoint =
  | 'session:start' | 'session:end'
  | 'model:before'  | 'model:after'
  | 'tool:before'   | 'tool:after'
  | 'error'

export interface HookContext {
  readonly signal: AbortSignal
  readonly logger: Logger
  readonly session: SessionSnapshot   // 只读快照,禁止直接改历史
}
```

各挂载点的语义与典型用途:

| Hook | 签名(简化) | 能做什么 | 典型消费者 |
|---|---|---|---|
| `session:start` | `(ctx)` | 初始化资源、加载配置 | MCP 连接、skill 发现 |
| `model:before` | `(ctx, req) => ModelRequest` | **改写请求**(历史、参数、system) | 上下文压缩、token 预算、skill 正文注入 |
| `model:after` | `(ctx, res)` | 观测/记录响应 | usage 统计、审计日志 |
| `tool:before` | `(ctx, call) => ToolDecision` | **allow / deny / ask / 改写入参** | **权限门**、入参清洗、危险命令拦截 |
| `tool:after` | `(ctx, call, result)` | 观测/改写结果 | 结果截断、审计、重试 |
| `error` | `(ctx, err)` | 观测/上报 | 遥测、错误聚合 |
| `session:end` | `(ctx)` | 清理 | 资源释放 |

- Hook **按注册顺序串行**执行,`tool:before` 任一返回 `deny` 则短路(不执行工具,直接产出 error 结果)。
- Hook 返回值即改写结果:`model:before` 返回新的请求对象,这使得**上下文压缩**无需修改 loop——它只是一个改写历史的 hook。

> **这是整套架构的关键**:权限、压缩、审计、限流在 v0.0.1 都还没有实现,但它们的**挂载点已经存在**。后续版本只做增量,不动主干。

### 3.4 统一能力注册中心

```ts
export interface ToolRegistry {
  register(tool: Tool, opts?: { source?: string }): void
  registerSource(source: string, tools: Tool[]): void   // 批量注册,含来源标记
  unregisterSource(source: string): void                // 批量下线
  get(name: string): Tool | undefined
  list(): Tool[]
  resolve(name: string): Tool                            // 找不到时抛出 ToolNotFound
}
```

**为什么要 `registerSource` / `unregisterSource`**:MCP 这类远端能力的工具集是动态的——server 断连后,工具应该**整批下线**,而不是留下一批"调用就报错"的空壳。按 source 标记注册是动态能力的前提。

**工具元数据**(供权限与 L2 提示词生成消费):

```ts
interface ToolMetadata {
  source: string              // 'builtin' | 'mcp:fs' | 'plugin:xxx'
  dangerous?: boolean         // 是否需要显式授权(bash 等)
  permissions?: Permission[]  // 声明式权限需求:fs:read / fs:write / net / exec
}
```

### 3.5 命名空间与冲突解决

| 来源 | 命名格式 | 示例 |
|---|---|---|
| 内置 | 裸名 | `read_file` |
| MCP | `mcp__<server>__<tool>` | `mcp__filesystem__read_file` |
| 插件 | `plugin__<name>__<tool>`(可选) | `plugin__git__diff` |

- 冲突策略由 `AgentConfig.conflictPolicy` 决定,默认 **`error`**(显式失败优于静默覆盖)。
- 可选:`prefer-builtin`(内置优先,忽略同名)、`prefer-last`(后者覆盖)。
- 默认策略选 `error` 的理由:工具名冲突往往意味着配置错误,静默覆盖会导致模型调用到非预期实现,这类问题极难排查。

### 3.6 各扩展点如何落地

**(a) MCP —— 独立包 `@kiturone/kapibala-mcp`,core 不感知**

```ts
export function mcpPlugin(config: MCPConfig): AgentPlugin {
  return {
    name: 'mcp',
    async setup(ctx) {
      for (const server of config.servers) {
        const client = await connect(server)              // stdio / http transport
        const { tools } = await client.listTools()
        ctx.tools.registerSource(
          `mcp:${server.name}`,
          tools.map(t => adaptMCPTool(client, t, server.name))
        )
        client.onclose(() => ctx.tools.unregisterSource(`mcp:${server.name}`))
      }
    },
    async teardown() { /* 断开全部连接、回收子进程 */ }
  }
}
```

- `adaptMCPTool` 把 MCP 的 `{ name, description, inputSchema }` 映射为规范 `Tool`,`execute` 内部转发 `client.callTool()`。
- 由于 MCP SDK 是外部重依赖,**它只存在于独立包**,`@kiturone/kapibala` 的运行时依赖保持为 0。

**(b) 权限 —— 就是一个 `tool:before` hook**

```ts
export function permissionPlugin(policy: PermissionPolicy): AgentPlugin {
  return {
    name: 'permission',
    setup(ctx) {
      ctx.hooks.on('tool:before', async (hctx, call) => {
        const decision = await policy(call, hctx)
        if (decision === 'deny')
          return { action: 'skip', result: toolError('denied by policy') }
        if (decision === 'ask') {
          const ok = await hctx.approval.request(call)
          return ok ? { action: 'continue' }
                    : { action: 'skip', result: toolError('user denied') }
        }
        return { action: 'continue' }
      })
    }
  }
}
```

- 权限系统不需要 loop 里写任何 `if (needConfirm)`——它只是众多 hook 中的一个。
- `ApprovalChannel` 是**注入的接口**:CLI 用 stdin 实现,TUI/Web 用弹窗实现,CI 用"默认拒绝"实现。

**(c) Skill —— 注册表 + L2.5 提示词层 + `load_skill` 工具**

```ts
export interface Skill {
  name: string
  description: string      // 供模型判断是否相关(常驻上下文)
  when?: string            // 触发条件描述
  body: string             // markdown 正文(按需加载)
  allowedTools?: string[]  // 该 skill 限定可用工具
}
```

采用**渐进式披露**:
1. L2.5 层只列出 `name + description`(几十个 skill 也只有几百 token);
2. 模型判断相关时,调用内置工具 `load_skill(name)` 加载正文进上下文;
3. `allowedTools` 经权限 hook 生效,实现 skill 级的最小权限。

**(d) 上下文压缩 / sub-agent —— 同样是 hook 或 tool**

- 压缩:`model:before` hook 改写历史。
- sub-agent:注册一个 `spawn_agent` 工具,内部开一个子 `AgentSession`。

## 4. 循环执行语义(v0 的必答问题)

### 4.1 多 tool_use 的调度与回填

模型单次响应可返回**多个** `tool_use`。由于 v0.0.1 以 OpenAI 兼容协议为主,两协议的回填形态与时序如下:

| | 回填形态 | 时序与结构约束 |
|---|---|---|
| **OpenAI 兼容 (v0.0.1 核心)** | 每个 `tool_call` 对应**一条独立 message** (`role: "tool"`, `tool_call_id`) | 所有 tool message 必须**连续紧跟**在触发它的 assistant 消息之后,不可插入其他角色消息 |
| Anthropic (v0.0.4+) | 多个 `tool_result` block 可合并进**一条** user message | 放在单个 user 消息的 content 数组中 |

**解法:把回填形态交给 Provider,loop 只产出 canonical 结果。**

```ts
export interface ModelProvider {
  create(req: ModelRequest): AsyncIterable<ModelEvent>
  /** 把一批工具结果装配成符合本协议的 canonical 消息序列 */
  assembleToolResults(results: ToolResult[]): CanonicalMessage[]
}
```

```ts
// loop 侧(协议无关)
const calls = assistant.content.filter(isToolUse)
const results = await executor.runAll(calls, ctx)     // v0.0.1:串行
history.push(...provider.assembleToolResults(results))
```

- **OpenAI 兼容协议的流式还原与组装**:
  - SSE chunks 中到达的 `delta.tool_calls` 会以 index 切片呈现(例如 `tool_calls[0].function.arguments` 片段到达)。Provider 负责在内存中按 index 缝合拼接为合法的 JSON 参数。
  - 完成后产生 canonical 的 `tool_use` 块。
  - 工具执行完成后,`assembleToolResults` 将每个 `ToolResult` 翻译为一条规范的 tool 结果消息,保留 `callId`(即 OpenAI 的 `tool_call_id`),以此向 OpenAI/DeepSeek 接口回填。
- **v0.0.1 串行执行**(`runAll` 内部 for-await),接口已预留并发位;改为并行时,依赖无关的工具可 `Promise.all`,顺序仍按输入顺序收集以保证结果稳定。
- **执行器从 loop 剥离**:`ToolExecutor`(`executor/` 或 `tools/executor.ts`)负责调度、超时与 Hook 触发;v0.0.1 的内置文件工具自行进行路径沙箱校验,loop 只关心"拿到结果"。
- **工具执行结果一律是 canonical 的 `tool_result`**,由 Provider 决定 wire 形态。

### 4.2 错误分类与重试

v0 把所有异常塞进一个 `error` 事件,是不可用的。v0.0.1 明确分类:

| 错误类 | 触发场景 | 处理策略 | 是否进历史 |
|---|---|---|---|
| `ModelError`(retryable) | 429 / 500 / 529 / overloaded | 指数退避 + jitter 重试,上限 N 次 | ❌ |
| `TransportError` | SSE 中途断连 | 已收到 `message_stop` → 视为完整;否则按 retryable 重试 | ❌ |
| `ToolError` | 工具 `execute` 抛错 | 转为 `is_error: true` 的 tool_result | ✅ **喂回模型自纠** |
| `ToolNotFound` | 模型调用了不存在的工具 | 同上,错误信息中列出可用工具名 | ✅ |
| `AbortError` | 用户中断 | 走 §4.3 修复流程 | 视策略 |
| `FatalError` | 配置错误、鉴权失败、schema 非法 | 冒泡终止 run | ❌ |

- **关键原则:工具失败不终止循环**。错误作为 `is_error` 结果回喂模型,让模型自行纠正——这是 agent 相比普通 API 调用的核心价值。
- **熔断**:连续工具错误达上限(默认 3 次)则终止,避免死循环烧 token。
- 重试只对 `ModelError(retryable)` 生效,且**重试前不得把半成品 assistant 消息写入历史**。
- **v0.0.2 结构化工具错误**:`KapibalaError` 增加稳定错误码与 `retryPolicy`(`never` / `immediate` / `backoff` / `after_user_action`),适配器只向模型发送脱敏后的安全错误信息。容器已删除、SSH 重试耗尽等终态错误标记为 `never`,AgentLoop 不得再次发起同类调用;权限、登录或配置缺失标记为 `after_user_action`,等待用户处理后再继续。

### 4.3 中断与历史修复(含 CLI 交互语义)

工具执行中途 Abort 会导致历史非法:`tool_use` 没有对应 `tool_result`,下次请求直接 400。

```ts
type AbortPolicy = 'complete-with-error' | 'rollback-turn'
```

- **默认 `complete-with-error`**:给所有未完成的 `tool_use` 补一条 `is_error: true`、`reason: 'aborted'` 的 tool_result,然后正常结束本轮。历史始终合法,且模型下一轮能看到"被中断了"。
- `rollback-turn`:丢弃最后一条 assistant 消息及其引发的 tool_result,回到上一个用户轮次。适合对上下文洁净度要求高的场景。
- `AbortSignal` 从 `run()` 透传到模型请求与工具执行;`AbortPolicy` 在中断路径上统一应用。

**CLI 终端中断状态机**:
在 Node.js CLI 环境下,终端 `Ctrl+C` 信号作如下分流处理:
1. **生成/执行中(Active Turn)**: 单次按下 `Ctrl+C` 触发当前 turn 的 `AbortController.abort()`,CLI 捕获后优雅停止流式输出,触发 `complete-with-error` 修复消息历史,并重新打印用户输入提示符(`kpbl > `),**不退出程序**。
2. **空闲等待中(Idle / Prompt)**: 用户在命令行等待输入状态下按下 `Ctrl+C`,直接退出 REPL 进程。
3. **紧急退出**: 无论任何状态,如果在 1 秒内连续按下两次 `Ctrl+C`,强制销毁所有子进程并直接退出。

### 4.4 落盘粒度与崩溃恢复

v0 写"run 中逐事件落盘"是**错的**——事件是 `text_delta` 流式增量,逐 delta 落盘无法恢复出完整消息。

**修正为消息级落盘**:

| 时机 | 落盘内容 |
|---|---|
| 用户输入 | 一条 user message |
| `message_stop` | 一条**完整** assistant message(delta 仅在内存组装) |
| `tool:after` | 一条 tool_result message |

- JSONL append-only,`{ ts, type, message }` 单行一条。
- **崩溃恢复**:`store.load()` 时检查末尾——若最后一条是含未完成 `tool_use` 的 assistant message,按 `AbortPolicy` 修复后再继续;脏行(半截 JSON)直接丢弃到最后一个完整换行。
- `usage` 累加可选落盘,供 token 统计。

**v0.0.3 消息生命周期与压缩约束(规划)**:

1. 先定义失败轮次、连续同角色消息和完整工具事务的规范化规则,保证各 Provider 接收合法历史;再给 canonical 消息稳定 ID,把发送、完成、中断、压缩覆盖等生命周期状态与正文分层维护,不得靠改写正文暗示状态。
2. 压缩由上下文预算触发,只能在完整消息/完整工具事务边界切分。至少保留最近一个完整的 user → assistant 交互轮次;assistant 的 `tool_use` 与对应 `tool_result` 必须作为不可拆分事务保留或一起进入摘要。
3. 更早历史交给 `summary` 角色生成结构化摘要检查点,记录覆盖的消息 ID 范围;摘要失败时继续保留原始历史,不得以不完整摘要替换 canonical 数据。
4. 为提高 Provider prompt cache 命中率,系统提示词、工具声明和已确认摘要采用稳定、确定性的序列化;新消息只追加在稳定前缀之后,仅在摘要检查点或项目指令快照真正变化时使对应前缀失效。
5. 压缩次数、摘要覆盖范围、最近压缩时间与压缩前后 Token 数通过结构化事件提供给宿主展示,避免 UI 根据消息条数猜测。

## 5. 配置系统

> 配置解决两件事:**值从哪来**(分层与优先级),以及**谁有权改**(收紧与信任)。
> 为避免初期过度设计,框架将配置演进拆分为 **v0.0.1 最小实用配置** 与 **v0.0.2+ 权限/作用域配置蓝图**。

### 5.1 v0.0.1 最小实用配置体系(本次交付)

v0.0.1 的配置聚焦于驱动 **OpenAI 兼容协议的多模型自由切换**、**初次冷启动向导**、**极简持久化体验** 与 **多场景模型路由契约预留**。

#### 1. ModelProfile(模型画像)与 UserSettings

每个模型抽象为一个 `ModelProfile`,使得用户输入 `/model deepseek` 即可同时完成端点、密钥与协议特性的绑定:

```ts
export type ContextWindowValue = number | `${number}K` | `${number}M`

export interface ModelProfile {
  id: string                   // 唯一标识,如 'deepseek-flash', 'deepseek-v4-pro', 'gpt-5.6-sol'
  name: string                 // 友好显示名称
  provider: 'openai-compatible'// v0.0.1 固定走 OpenAI 兼容协议
  baseURL: string              // API 端点,如 'https://api.deepseek.com/v1'
  apiKeyEnv: string            // 环境变量名,如 'DEEPSEEK_API_KEY'
  apiKey?: string              // 配置文件中指定的密钥(可选,推荐走环境变量)
  modelName: string            // 发给 API 的实际 model 参数
  contextWindow?: ContextWindowValue // 上下文窗口 Token 数;未配置时按 1M 作为默认估算
  supportsThinking?: boolean   // 是否解析 reasoning_content 思考块
}

export type ModelRole = 'default' | 'planning' | 'execution' | 'summary' | 'fast'

export interface ModelRoutingConfig {
  planning?: string   // 规划/架构拆解, 如 'gpt-5.6-sol' 或 'deepseek-v4-pro'
  execution?: string  // 频繁工具循环执行, 如 'deepseek-flash'
  summary?: string    // 上下文压缩与会话总结
  fast?: string       // 快速分类/意图识别
}

export interface UserSettings {
  $schema?: string
  defaultModel: string
  modelRouting?: ModelRoutingConfig
  profiles: ModelProfile[]
}
```

`contextWindow` 的 v0.0.1 收尾增强规则如下:

1. 同时接受正整数与带单位字符串,例如 `1000000`、`"1M"`、`"256K"`、`"1.05M"`。
2. `K/M` 按十进制换算(`1K = 1,000`,`1M = 1,000,000`),大小写不敏感;`K` 最多 3 位小数、`M` 最多 6 位小数,换算结果必须是正整数 Token;不接受容易与字节单位混淆的 `KB/MB`。
3. 加载配置时立即归一化为正整数 Token 数;零、负数、未知单位、非有限值与无法整除为整数的结果都作为配置错误报告。
4. 内置 profile 始终携带目录中的明确窗口;自定义 profile 未配置时使用 `1M` 默认估算,CLI 必须标记为“默认估算”,不能伪装成模型官方值。
5. 上下文占用率使用**最近一次内部模型请求**的 `promptTokens / contextWindow`;禁止使用会话累计 Token 或一次 run 内多个步骤的累计输入 Token,后两者会重复计算被反复发送的历史。
6. v0.0.1 只展示窗口占用,不伪造压缩状态;真实压缩次数、摘要覆盖范围与最近压缩时间由 v0.0.3 的上下文管理模块提供。

框架内置 profiles 以 `packages/cli/src/settings.ts` 的 `BUILTIN_PROFILES` 为唯一真源,用户无需把完整目录复制进配置文件;用户配置只保存实际启用、覆盖或持有密钥的 profile。

#### 2. 多场景模型路由设计(Role-based Model Routing 蓝图)

> **为什么必须支持场景模型分离(如规划用 GPT,执行用 DeepSeek)?**
> 1. **能力倾斜与上下文经济学**:
>    - **规划阶段(Planning Phase)**: 任务开始时的全局拆解、依赖分析、架构设计。这一步调用次数极少(1~2次),但对长上下文逻辑推演、复杂指令遵循要求极高。适合配置当前目录中的高推理档模型。
>    - **执行阶段(Execution Phase)**: 工具调用循环(读写文件、grep、执行命令、修语法报错)。单任务动辄循环 5~15 轮,极度依赖**低延迟(TTFT)与性价比**。此时适合当前目录中的快速档或本地模型,不在设计文档复制一份会过期的具体型号清单。
>    - **总结压缩阶段(Summary Phase)**: 历史消息滚动压缩,用轻量快速模型即可胜任。
> 2. **落地演进节奏**:
>    - **v0.0.1 (当前)**: 在 `UserSettings` schema 与 `ModelRouter` 抽象层预留 `modelRouting` 契约,底层默认 fallback 回退到 `defaultModel`,不增加第一期执行复杂度。
>    - **v0.0.4+**: CLI 支持动态绑定角色 `/model planning <id>` 与 `/model execution <id>`,Loop 引入阶段性路由调用;小模型意图分类保持可选,不作为每次请求的默认前置调用。

#### 3. 配置源与优先级(从高到低)

1. **运行时 Slash 命令(最高优先级)**: `/model <profile_id>`(临时热切换),`/model <role> <profile_id>`(指定角色切换)
2. **CLI 启动参数**: `--model <id>`, `--base-url <url>`, `--api-key <key>`
3. **环境变量**: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`
4. **项目本地配置**: 当前工作区 `.kapibala/settings.json`
5. **全局用户配置**: 用户家目录下 `~/.kapibala/settings.json`(Windows 下为 `%USERPROFILE%\.kapibala\settings.json`)

```json
{
  "$schema": "https://raw.githubusercontent.com/tedburner/kapibala/main/schemas/settings.schema.json",
  "defaultModel": "deepseek-flash",
  "modelRouting": {
    "planning": "gpt-5.6-sol",
    "execution": "deepseek-flash",
    "summary": "deepseek-flash"
  },
  "profiles": [
    {
      "id": "deepseek-flash",
      "name": "DeepSeek Flash (V4.1-Flash)",
      "provider": "openai-compatible",
      "baseURL": "https://api.deepseek.com/v1",
      "apiKey": "sk-***",
      "modelName": "deepseek-flash",
      "contextWindow": "1M",
      "supportsThinking": true
    },
    {
      "id": "custom-my-gateway-https-gw-example-com-v1",
      "name": "My Gateway",
      "provider": "openai-compatible",
      "baseURL": "https://gw.example.com/v1",
      "apiKeyEnv": "CUSTOM_API_KEY",
      "modelName": "gpt-5.6-terra",
      "contextWindow": "256K"
    }
  ]
}
```

> **`$schema` 赋能开发体验 (DX)**:
> 配置文件首行声明 `$schema`,VS Code / Cursor 等主流编辑器将自动挂载字段校验、悬浮说明与智能补全(IntelliSense),用户手动编辑时无须查阅文档即可获得即时语法反馈。

#### 4. 首次使用冷启动:交互式配置向导 (First-Run Setup Wizard)

当新用户在完全没有配置环境变量、也没有任何本地配置文件的状态下首次启动 `kpbl` 时,CLI 不直接退出报错,而是自动唤起终端**交互式初始化向导**:

1. **选择服务商与模型**:
   - 服务商与型号均从 `BUILTIN_PROFILES` 和 provider 展示元数据动态生成,不在向导中维护第二份硬编码清单。
   - 内置目录之外保留“自定义 OpenAI 兼容接口”,用于 OneAPI / vLLM / 私有网关。
2. **引导录入**:
   - 引导用户输入 API Key(或检测到已有环境变量时提示直接复用)。
3. **连通性校验 & 全局持久化**:
   - 发送一次轻量探测测试端点连通性;
   - 连通成功后,自动创建目录 `~/.kapibala/` 并将配置持久化写入全局 `~/.kapibala/settings.json`(文件权限设为 POSIX `0600`,防止其他用户越权读取);
   - 自动将当前选中的模型设为 `defaultModel`,直接无缝进入 REPL 对话循环!

在 REPL 运行时,用户亦可随时通过 `/settings setup` 或 `/model setup` 重新调出向导,或通过 `/model set-default [id]` 将当前模型持久化为全局默认。

#### 5. 密钥安全底线
- 优先从环境变量读取密钥。
- 配置文件中明文 key 在读取时打印脱敏警告(`sk-***1234`),鼓励使用 `${ENV_VAR}` 占位。
- 全局与本地 `.kapibala` 目录均自动被 `.gitignore` 规则识别,防止意外提交。
- 全局与本地 `.kapibala` 目录均自动被 `.gitignore` 规则识别,防止意外提交。

---

### 5.2 v0.0.2+ 权限与作用域配置蓝图(架构储备)

随 v0.0.2 权限插件与项目指令加载落地,配置将开始演进为完整的五层合并机制:

| 层 | 位置 | 作用域 | 入库 | 可被下级覆盖 |
|---|---|---|---|---|
| **L0 托管** | `$KAPIBALA_MANAGED_CONFIG` 或 `/etc/kapibala/managed.json` | 机器级 | — | ❌ **不可覆盖** |
| **L1 命令行** | `--model` `--permission` `--deny-tool` | 单次运行 | — | — |
| **L2 项目本地** | `.kapibala/settings.local.json` | 当前项目·个人 | ❌ gitignore | ✅ |
| **L3 项目** | `.kapibala/settings.json` | 当前项目·团队 | ✅ 入库 | ✅(受 §6.4 信任策略约束) |
| **L4 全局用户** | `~/.kapibala/settings.json` | 全部项目 | — | ✅ |

- 优先级 **L0 > L1 > L2 > L3 > L4**。
- **合并语义**: 标量字段覆盖;权限规则(`allow`/`deny`)**并集累加**,`deny` 绝对优先。
- 诊断命令:提供 `kpbl settings show` 打印规则来源层。

## 6. 安全与权限模型

> v0 声称"安全是代码问题不是提示词问题(路径校验、沙箱)",但同时内置 bash——二者在能力上是矛盾的:bash 一旦可用,`cat`/`curl` 可绕开一切路径校验。

### 6.1 三层防线

| 层 | 机制 | 形态 |
|---|---|---|
| 静态策略 | 配置声明的权限规则、路径 root、网络开关 | 配置(见 §5),启动即生效 |
| 动态策略 | `tool:before` hook 逐次裁决(见 §3.6 的权限示例) | 代码,可组合 |
| 交互确认 | `ApprovalChannel` 请求人工确认 | 注入接口(CLI / TUI / CI 各自实现) |

### 6.2 权限规则模型

```ts
interface PermissionRule {
  // 匹配维度:工具名(支持 mcp__fs__* 通配) 或 能力(capability)
  tool?: string
  capability?: Capability
  pattern?: string              // 针对入参的匹配,如 bash 的 command 前缀
  decision: 'allow' | 'deny' | 'ask'
}

type Capability =
  | 'fs:read' | 'fs:write' | 'exec'
  | 'net:outbound' | 'env:read' | 'agent:spawn'
```

- **优先用 capability 而非 tool 名**:工具可以被动态注册(MCP 会引入大量未知工具),而 capability 是稳定小集合。用 capability 写规则,新接入的 MCP 工具自动被既有策略覆盖,无需为它单独补规则。
- 工具通过 `metadata.permissions` 声明其所需 capability(见 §3.4);未声明的工具自 v0.0.2 起一律走确认门。
- **v0.0.1 的 `metadata.permissions` 只是声明,尚未参与授权**。内置文件工具在各自 `execute` 内调用 PathSandbox;ToolExecutor 不读取 capability。v0.0.2 必须先交付统一执行前权限决策,用内置工具的声明做第一批端到端测试,再接入 opt-in Bash。插件代码已在宿主进程运行,工具调用审批不能替代对不可信插件的宿主隔离。

### 6.3 求值顺序(deny 绝对优先)

对每次工具调用,按 §5.2 收集所有层的匹配规则后:

1. 若**任一层**存在匹配的 `deny` → **deny**,终止。
2. 否则取**优先级最高层**的 `allow` → **allow**。
3. 否则 → **ask**(询问用户)。

> **deny 绝对优先是整个模型的核心安全属性**。若改成"高层覆盖低层",项目配置里写一条 `allow` 就能推翻全局的 `deny`;而项目配置是 `git clone` 来的,本质上是不可信输入。这条规则使**收紧永远比放宽松容易**——全局/托管层可以一票否决,项目层无法自我授权。

- 默认兜底是 `ask` 而非 `allow`:未匹配任何规则时一律询问,宁可多问一次,也不错放一次。

### 6.4 项目配置的收紧策略(全局 vs 项目)

项目配置(L3)来自仓库,是**不可信输入**——clone 一个仓库就执行其中的配置,等同于执行陌生代码。因此引入信任策略:

| 策略 | 项目的 `deny` | 项目的 `allow` | 说明 |
|---|---|---|---|
| `strict` | ✅ 生效 | ❌ 忽略 | 项目只能收紧,不能放宽 |
| `trusted` | ✅ 生效 | ✅ 生效 | 用户已显式信任该项目 |
| `prompt`(默认) | 首次运行时展示配置 diff,由用户选择 | | 选择结果记入全局配置 |

- **默认 `prompt`**:首次在某项目运行时,展示该项目配置相对全局基线的**增量 diff**(新增了哪些 allow/deny),用户选择"仅本次 / 信任该项目 / 严格模式"。
- **信任记录按绝对路径存储**于全局配置,而非仓库名或 remote URL。仓库被移动或重命名后信任自动失效——防止攻击者用同名目录冒用信任。
- **`strict` 是 CI 的推荐默认**:无人值守环境下 `ask` 无法工作,应配 `strict` + 显式 `allow` 白名单。

### 6.5 v0.0.1 的具体约束

1. **v0.0.1 不实现、不注册 bash 工具**。v0.0.2 权限决策与审批就绪后,才允许以 opt-in 方式注册,并声明 `dangerous: true`。
2. **文件系统沙箱**(`security/sandbox.ts`):路径解析(含 `..` 归一化、符号链接解析)后必须落在允许的 root 内,越界直接 `ToolError`。
3. **权限决策缓存属 v0.0.2 规划**:`once`(本次允许)/ `always`(会话内记住)/ `never`(会话内拒绝),v0.0.1 尚无审批入口。
4. **v0.0.1 内置工具无网络能力**;第三方插件代码仍拥有宿主进程权限。`net` 声明在 v0.0.2 权限决策接入前不构成网络隔离。
5. **未挂载权限插件时的语义是 fail-open**(工具直接执行)。这在 v0.0.1 是可接受的——默认工具集不含 bash、全部受路径沙箱约束,危险面已经由上面第 1 条的 bash opt-in 策略压到最小。**v0.0.2 引入权限插件后应改为 fail-closed**:未声明 `permissions` 的工具一律走确认门。此项需在 v0.0.2 明确,避免默认放行的语义被后继版本继承。
6. **v0.0.1 不实现权限规则引擎**(§6.2–6.4 的求值、分层合并、信任策略均属 v0.0.2)。当前防线是**不注册 bash + 内置文件工具逐项调用 PathSandbox**;`ToolMetadata` 声明和 `tool:before` 挂载点仅为后续权限决策预留契约,不能据此声称第三方工具已受沙箱保护。

### 6.6 v0.0.2 四态 SessionMode

四种模式是权限策略与审批交互的统一前端语义,CLI、未来 TUI/Web 与 SDK 不得各自发明一套名称:

| 模式 | 默认行为 | 不变量 |
|---|---|---|
| `Approval` | 沙箱内只读默认允许;写入、执行、网络与高危工具逐次询问,可记住本次或本会话决策 | 未经确认不得产生副作用 |
| `Plan` | 只允许读取与分析;写入、执行、网络直接拒绝,不弹审批 | 适合纯规划,拒绝结果仍闭合工具历史 |
| `Auto` | 沙箱内读取与写入自动允许;执行、网络与标记为 `dangerous` 的工具仍询问 | 提高日常开发吞吐,不静默扩大高危能力 |
| `FullAccess` | 自动批准所有**已声明** capability | 只跳过人工审批,仍受 PathSandbox、显式 deny 与宿主硬边界约束 |

- `FullAccess` 不是“关闭所有安全边界”;若未来提供突破工作区或宿主隔离的能力,必须使用独立且更醒目的显式开关,不能复用此模式名称。
- `ApprovalChannel` 是注入接口;TTY CLI 负责交互,非交互环境对需要询问的操作默认拒绝。
- 审批拒绝、超时和取消都转为合法的 `is_error` 工具结果,不得破坏 assistant `tool_use` → `tool_result` 闭合不变量。
- 项目配置与项目指令只能收紧规则;放宽权限必须来自已信任的用户级配置或本次人工批准。

## 7. 提示词设计(分层组装)

**原则:系统提示词不是一段写死的文本,而是运行时分层组装的产物。** 每层独立演进、独立测试,来源单一:

| 层 | 内容 | 来源 | v0.0.1 |
|----|------|------|------|
| L1 行为层 | agent 身份、能力边界、响应风格、循环行为规则 | `prompt/` 内置模板 | ✅ |
| L2 工具层 | 可用工具清单与使用说明 | 从 ToolRegistry **自动生成** | ✅ |
| **L2.5 skill 层** | skill 摘要清单(name + description) | 从 SkillRegistry 生成,正文按需经 `load_skill` 加载 | 预留 |
| L3 环境层 | cwd、平台、日期、shell | 运行时注入 | ✅ |
| L4 用户层 | 项目约定、领域知识 | 项目根 `AGENTS.md` 自动发现 | 预留 |

- 组装顺序 L1 → L2 → L2.5 → L3 → L4,层间固定分隔符连接。
- **Provider 级微调**:L1 存放模型无关的中性表述;各 Provider 可携带一层模型级微调(如 DeepSeek 与 Anthropic 的指令遵循风格差异),由 Provider 声明、组装器拼接。
- L2 自动生成意味着**工具的 `description` 直接决定模型调用准确率**——它是可测试资产,应有 snapshot 测试(见 §11)。

v0.0.2 将 L4 扩展为多层 `AGENTS.md` 发现:先加载用户级指令,再从项目根到当前工作目录逐层合并,越靠近当前目录优先级越高。加载器必须限制单文件大小、总注入量和最大层数,并允许诊断命令展示实际来源。`AGENTS.md` 属于知识/行为输入,可以要求更谨慎,但不能注册工具、修改 SessionMode 或扩大权限。

`AGENTS.md` 支持轮次边界热加载:每次开始新的用户轮次前检查适用文件链,有变化时原子生成新的指令快照;同一 active run 始终使用启动时快照,禁止执行途中改变约束。读取或解析失败时保留最后一份有效快照并向宿主发送诊断,不得静默退化为空指令。这样项目约定能在下一轮生效,同时不会让一次工具循环前后遵守不同规则。

## 8. 仓库结构(monorepo,pnpm)

> 结构原则:**每个核心模块 = core 下一个独立目录**,目录内自带接口定义与实现,模块间只走 `index.ts` 公开出口。目录即模块边界,保证后续扩展都是"加目录/加包",而不是改既有文件。

```
kapibala/
├── package.json              # pnpm workspace 根
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── biome.json                # lint + format(Biome 单工具)
├── packages/
│   ├── core/                 # @kiturone/kapibala — SDK 本体(运行时依赖 0)
│   │   └── src/
│   │       ├── index.ts      #   唯一公开导出
│   │       ├── session/      #   AgentSession(含 switchModel/reset API)
│   │       ├── loop/         #   AgentLoop(纯逻辑执行循环)
│   │       ├── executor/     #   ToolExecutor(调度、超时与 Hook 驱动)
│   │       ├── events/       #   SessionEvent / ModelEvent
│   │       ├── message/      #   CanonicalMessage / ContentBlock
│   │       ├── errors/       #   错误分类(§4.2)
│   │       ├── prompt/       #   提示词分层组装器
│   │       ├── tools/        #   Tool 接口 + ToolRegistry + builtin/
│   │       ├── skills/       #   SkillRegistry + loader(§3.6 的 skill 示例)
│   │       ├── plugin/       #   AgentPlugin 契约(§3.2)
│   │       ├── hooks/        #   HookRegistry(§3.3)
│   │       ├── security/     #   sandbox.ts + capability 校验(§6)
│   │       ├── models/       #   ModelProvider 接口
│   │       │   ├── openai-compatible/ # v0.0.1 核心实现(OpenAI/DeepSeek/Ollama)
│   │       │   └── anthropic/         # v0.0.1 接口契约(v0.0.4 交付实现)
│   │       └── store/        #   MessageStore + jsonl 实现
│   ├── cli/                  # @kiturone/kapibala-cli — 交互式 CLI(bin 名: kpbl)
│   │   └── src/
│   │       ├── index.ts      #   启动入口与命令行参数解析(minimist)
│   │       ├── repl.ts       #   REPL 交互循环、流式打印、Ctrl+C 中断状态机
│   │       ├── settings.ts   #   ModelProfile 管理、UserSettings 读写(~/.kapibala/settings.json)
│   │       ├── wizard.ts     #   首次运行交互式配置向导(First-Run Setup Wizard)
│   │       └── commands/     #   内建 Slash 命令拦截器
│   │           ├── dispatcher.ts #   命令分发解析器
│   │           ├── model.ts      #   /model 查看与热切换
│   │           ├── settings.ts   #   /settings 查看与配置
│   │           ├── clear.ts      #   /clear 重置会话
│   │           ├── status.ts     #   /status 查看统计与用量
│   │           └── help.ts       #   /help 帮助信息
│   └── mcp/                  # @kiturone/kapibala-mcp(后续,v0.0.1 不建)
│       └── src/              #   stdio/http transport + tool adapter
├── examples/
│   ├── minimal.ts            # 10 行用法示例
│   └── plugin.ts             # 自定义插件示例(后续)
└── docs/design/              # 设计文档(本篇所在)
```

**包导出约定**(开源 SDK 的门面,必须定义清楚):

- 构建:tsup,**ESM 为主 + CJS 双发**,`dts` 生成类型。
- `exports` map:`"."` 主入口;`"./zod"` 为 Zod 糖(见 §10);`"./plugin"`、`"./testing"` 预留 subpath。
- 各包独立 tsconfig,根 `tsconfig.base.json` 提供公共编译选项;先不上 project references(构建顺序由 pnpm topological 保证),待包数量增长后再引入。

## 9. v0.0.1 交付范围

1. **packages/core**:
   - `message/` `events/` `errors/` 规范类型(含 `thinking` 解析消费与规范转换)
   - `defineTool`(JSON Schema 为契约,Zod 为可选糖)
   - **ToolRegistry(命名空间 + source 批量注册/注销 + 冲突策略)**
   - **ToolExecutor(调度、超时与 Hook 拦截;统一权限决策归入 v0.0.2)**
   - AgentLoop:while 循环 + 最大步数 + 熔断 + **AbortPolicy**
   - **Plugin / Hook / Registry 契约**(接口与注册实现,MCP 等消费方后续接入)
   - **OpenAI 兼容 Provider(v0.0.1 核心主打)**:流式 SSE 深度解析(累加拼接 chunked `tool_calls` 参数、解析 DeepSeek `reasoning_content` 为 thinking 规范块)+ `assembleToolResults`(连续多 tool 严格回填)
   - **Anthropic Provider(v0.0.1 规范契约)**:定义接口规范,实现定于 v0.0.4 交付
   - **ModelRouter 场景路由契约(v0.0.1 规范契约)**:定义角色分发接口,预留规划/执行模型分离槽位
   - **JSONL MessageStore(消息级落盘 + 崩溃恢复)**
   - `security/sandbox.ts`(由内置文件工具在执行时逐项调用)+ 权限策略接口(仅契约,不含求值引擎)
   - 统一导出入口 `index.ts`

**v0.0.1 内置工具集与权限标注**(capability 阶梯:只读 < 写入 < 执行,危险面逐级上升):

| 工具 | capability | `dangerous` | v0.0.1 防线(无权限引擎时的实际执行) | v0.0.2 起的权限语义 |
|---|---|---|---|---|
| `read_file` | `fs:read` | — | 读沙箱:路径归一化后必须落在 root 内 | 按 `fs:read` 规则 allow/deny/ask |
| `glob` | `fs:read` | — | 同上 | 同上 |
| `grep` | `fs:read` | — | 同上 | 同上 |
| `write_file` | `fs:write` | — | 写沙箱:root 内 + 拒绝越界与 symlink 逃逸 | 按 `fs:write` 规则;可对特定路径配 pattern |
| `edit_file` | `fs:write` | — | 同上(唯一目标精确替换) | 同上 |
| `bash` | `exec` + `net:*`(不可判定) | ✅ | **v0.0.1 不实现、不注册** | v0.0.2 在 SessionMode、`exec` 规则、command 前缀 pattern 与确认门就绪后以 opt-in 方式接入 |
| ~~`repl`~~(代码执行) | `exec` | ✅ | **v0.0.1 不做**——危险面等同 bash,但实现成本高(持久进程、状态、回收),验证场景用不到;`bash` 已能覆盖"跑一段代码"的需求 | 随 exec 能力一起在 v0.0.2+ 评估 |

- v0.0.2 设计意图:**能力阶梯决定默认策略**——只读与写入由权限策略决策,执行类工具一律 opt-in;v0.0.1 的 capability 标注尚不触发策略。模型拿到的能力集越小,行为越可预测,提示词 L2 层也越干净。
- `list_files` 从工具集移除:`glob` 可完全覆盖其场景,少一个工具就少一份 L2 提示词成本。

2. **packages/cli**:
   - 交互式对话 REPL,启动命令 **`kpbl`**(package.json `bin` 字段注册)。
   - **首次运行向导 (Setup Wizard)**: 当无环境变量且无配置文件时自动触发,引导选择服务商并验证保存至全局 `~/.kapibala/settings.json`。
   - **内建 Slash Command 控制层**:
     - `/model [name]`: 查看或热切换当前模型(具体预设始终取自 `BUILTIN_PROFILES`,命令层不硬编码型号清单)。
     - `/settings`: 查看或修改全局/项目设置(支持 `/settings setup` 呼出向导,`/settings default <id>` 设定默认模型)。
     - `/clear`: 重置当前会话历史上下文。
     - `/status`: 打印当前模型、已消耗 Token 计数与当前激活工具列表。
     - `/help`: 打印支持的命令清单。
     - `/exit` / `/quit`: 退出终端。
   - **v0.0.8 统一命令面板（未来规划）**:
     - `CommandDispatcher`、`SkillRegistry` 与 MCP Prompt Registry 统一提供候选元数据：稳定 ID、展示名、一行描述、来源类型、参数提示、是否允许用户调用及执行引用；Host 只查询和渲染，不自行扫描 Skill/MCP 文件。
     - 候选范围仅包含内置 Slash 命令、用户可调用的 Skills 与 MCP Prompt。原始 MCP Tool 仍由模型通过工具协议调用，不进入 `/` 菜单。
     - 匹配优先级固定为精确匹配 → 前缀匹配 → 子串匹配 → 模糊匹配，同等级保持注册顺序稳定；裸 `/` 使用策划后的稳定顺序，不因运行时 Map 遍历或异步 MCP 返回顺序抖动。
     - 面板默认显示 3 行，仅限制可见窗口而不截断候选集合；剩余数量显示为 `+N more`，可用上下键滚动浏览。Tab 补全当前候选，Enter 执行，Esc 关闭。
   - **终端交互与中断状态机**:单次 `Ctrl+C` 优雅中止当前 turn 的模型流式生成或工具执行(保持上下文自愈),空闲状态单次 `Ctrl+C` 或任意状态双击 `Ctrl+C` 退出 REPL。
   - `--debug` 参数: dump 原始 SSE 响应数据流。
   - 配置加载: 环境变量优先,项目 `.kapibala/settings.json` 次之,全局 `~/.kapibala/settings.json` 兜底。

3. **examples/minimal.ts**:最短可用示例(10 行代码通过 OpenAI 兼容协议跑通单次对话)。
4. **docs/design/001**:本设计文档。
5. **工程化**:vitest、Biome、tsup、changesets、GitHub Actions CI。
6. **不做**:权限交互门与多层 AGENTS.md(移至 v0.0.2)、消息生命周期与上下文压缩(移至 v0.0.3)、Anthropic 协议具体实现与多角色路由运行时切换(移至 v0.0.4)、skill、MCP、多会话、sub-agent、REPL 类代码执行工具、**完整五层配置合并引擎(从 v0.0.2 起按真实消费方渐进落地)**。
   > 但 **§3 的契约与挂载点全部落地**——后续版本只做增量,不改主干。
   > v0.0.1 的配置聚焦于 ModelProfile + 环境变量 + 单文件配置 + `/model` 运行时切换。

## 10. 技术要点

- **JSON Schema 为契约,Zod 为可选糖**:`Tool.parameters` 是标准 JSON Schema,core 运行时依赖保持 **0**;`defineTool` 的 Zod 支持放在 `./zod` subpath(Zod v4 已内置 `z.toJSONSchema`,无需 `zod-to-json-schema`)。这样不会把用户的校验库选择权绑死。
- **事件流统一用 AsyncGenerator**:不引 RxJS,压依赖面。
- **`run()` 的消费语义**(v0 未定义,此处明确):返回**已启动**的 generator;取消**只能通过 `AbortSignal`**,不支持靠 `break` 取消——`break` 会导致 generator 挂起在 `yield` 上、资源无法回收。CLI 侧需保证消费完整或用 `signal` 中断。
- **AbortSignal** 从 `run()` 透传到模型请求与工具执行。
- **依赖面策略**:**运行时依赖压到 0,开发依赖可以宽**(vitest 等不进用户产物)。

## 11. 验证方式

1. `pnpm install && pnpm build` 通过。
2. `pnpm test`(CI 可跑,**不依赖真实 API key**):
   - **OpenAI 兼容 SSE fixture 契约测试**:录制 OpenAI 与 DeepSeek 的 SSE 片段回放,验证解析 → ModelEvent 的正确性(含 reasoning_content、chunked tool_calls 拼接、usage、错误帧)。
   - **CLI Slash 命令单元测试**:验证 `/model` 动态切换 Provider 参数、`/clear` 清空历史并触发 MessageStore 逻辑、`/status` 统计信息正确性。
   - loop 在 mock provider 下正确执行**多步 + 多工具**调用。
   - `assembleToolResults` 正确产出严格按 `tool_call_id` 匹配的连续 tool 消息序列。
   - **错误路径**:429 重试、工具抛错转 `is_error`、连续错误熔断。
   - **中断路径**:工具执行中 abort → 历史合法性断言。
   - JSONL store roundtrip + 崩溃恢复(半截 JSONL 恢复)。
   - 沙箱路径校验(含 `..` 越界、符号链接)。
   - **提示词 L2 层 snapshot 测试**(工具 description 变更会被感知)。
3. `pnpm dev`(cli REPL)连 DeepSeek key(分别验证 chat 与 reasoning 模式)或本地 Ollama,手工验证一轮对话 + 工具调用 + `/model` 切换(**仅作为冒烟,不替代 2**)。
4. `examples/minimal.ts` 单独 `npx tsx` 可跑。

## 12. 版本路线与扩展点映射

> 每个版本对应 **§3 的一个扩展点**,实现方式是"加插件 + 注册 hook",不重构主干。
>
> **编号约定**:版本号按十进制位进位,序列为 `v0.0.8` → `v0.0.9` → `v0.1.0`,不使用 `v0.0.10`;后续同理,`v0.1.9` 之后进入 `v0.2.0`。

| 版本 | 内容 | 依赖的扩展点 | 交付形态 |
|---|---|---|---|
| **v0.0.1** | 核心骨架 + OpenAI 兼容全套 + 交互 CLI + 既有能力收尾增强 | Plugin / Hook / Registry / Executor;指标、工具展示、每轮底栏当前 Git 分支、配置、脚本、沙箱与 Headless Core 架构门禁 | 当前版本 |
| **v0.0.2** | 可信执行与项目指令:先验收四态 SessionMode、执行前权限决策与 ApprovalChannel,再交付结构化工具错误、审批缓存、多层 AGENTS.md;权限端到端测试通过后才接入 opt-in Bash | `tool:before` / `tool:after` + L4 提示词层 + 项目信任 | core + CLI 增量 |
| **v0.0.3** | 消息生命周期与上下文管理:先规范失败轮次、连续同角色消息及完整工具事务,再交付状态层、上下文预算、滚动压缩与摘要检查点 | `model:before` 改写历史 + MessageStore 扩展 + Summary 路由回退 | core 内增量 |
| **v0.0.4** | Anthropic 原生 Provider 消费 v0.0.3 的合法消息序列 + 场景模型路由运行时落地 | Provider 适配 + ModelRouter;小模型意图分类为可选策略 | core + CLI 增量 |
| **v0.0.5** | skill 机制:SkillRegistry、渐进式披露、`load_skill`、来源与权限约束;向宿主暴露可搜索的 Skill 名称、描述、来源、参数提示和用户可调用性元数据,CLI 展示当前加载/调用的 Skill 名称 | `skills/` + L2.5 层 + `model:before` | core 内增量 |
| **v0.0.6** | MCP(stdio → http),受项目信任和权限策略约束;CLI 保留并展示 MCP server/tool 命名空间,MCP Prompt 以名称、描述、来源和参数提示注册为用户命令 | Plugin + `registerSource` 动态上下线 + MCP Prompt Registry | **独立包 `@kiturone/kapibala-mcp`** |
| **v0.0.7** | 先验收多会话恢复/检索/归档与 SessionManager,再交付 sub-agent;权限继承收紧与工作区隔离测试通过后才发布 `spawn_agent` | MessageStore 索引 + 多会话协调 + 注册 `spawn_agent` 工具 | core 内增量 |
| **v0.0.8** | 产品化终端体验:TUI、共享前端 ViewModel、多任务状态、可扩展状态栏、流式渲染;统一 `/` 命令面板对 Slash 命令、用户可调用的 Skills 与 MCP Prompt 做稳定模糊匹配,展示名称/描述/来源;默认可见 3 条但可滚动浏览全部结果,支持上下键、Enter、Tab 与 Esc,原始 MCP Tool 不进入菜单;思考过程生成时完整展示,完成后折叠且可展开 | `SessionEvent` 消费者 + CommandDispatcher/SkillRegistry/MCP Prompt Registry 查询接口 + CLI/TUI Host Adapter | 独立包 + CLI 增量 |
| **v0.0.9** | 本地客户端契约与发布前加固:版本化 wire DTO、本地守护进程和一种受控本地传输;审计、预算、宿主隔离与兼容性测试。桌面/Web/移动及远程接入在契约稳定后推进,远程接入先具备认证与授权 | 事件传输适配 + 宿主隔离 + 兼容性测试 | core + 本地宿主适配 |
| **v0.1.0** | 阶段性整合:稳定已交付的 Core API、事件协议和本地客户端契约,完成迁移验证与发布流程,不新增运行时子系统 | 全部已落地扩展点的集成验收 | CLI + Core SDK + 扩展包 |

## 13. 待定议题:全局与项目的作用域模型(非 v0.0.1 范围)

> 本节只记录问题与初步分类,**不做设计**。完整的作用域模型随权限(v0.0.2)、skill(v0.0.5)、MCP(v0.0.6)按真实消费方逐步展开。若后续需要跨模块统一,再拆成独立文档(如 002-scope-model)。

§5/§6 只覆盖了"配置与权限"这一个维度的全局/项目关系。但这个问题会扩散到几乎每个子系统,且方向并不一致:

| 子系统 | 全局 | 项目 | 初步倾向 |
|---|---|---|---|
| 工具 | 用户安装的内置/MCP 工具 | 项目特有的脚本工具、MCP server | 项目能否**禁用**全局工具?命名空间冲突之外的"可见性"问题 |
| Skill | 个人积累的知识包 | 团队操作规程 | 项目应**覆盖**全局(项目约定 > 个人习惯)——与权限的"收紧"方向**相反** |
| 插件/MCP | 个人常用 server | 项目声明依赖 | 项目只能"**声明**",装载需用户确认(同 §6.4 信任模型) |
| 会话历史 | 全库检索 | 按 cwd 归属 | 归项目,存全局缓存目录(不入库,防泄密);全局检索是 v0.0.7+ 的索引问题 |
| 记忆/上下文 | 个人偏好 | 项目约定 | 提示词 L4 层需拆成 L4a 全局 + L4b 项目 |
| 缓存/索引 | — | 代码索引、embedding | 放全局缓存目录按项目哈希分桶,避免污染仓库 |
| 审计 | 集中留存 | — | 合规场景下审计**不能被项目配置关闭**——"只能收紧"的又一个实例 |
| 预算 | 用户总额度 | 单项目限额 | 项目额度受全局剩余额度约束 |

初步观察到一个三分类模式(待验证):

1. **授权类**(权限、插件、MCP、预算):项目只能收紧,放宽需显式信任——不可信输入不能自我授权。
2. **知识类**(skill、AGENTS.md):项目优先于全局——"在这个项目里就该遵守这个项目的约定"。
3. **数据类**(会话、缓存、索引):默认存全局按项目分桶——既不入库污染仓库,也不散落难检索。

另有两个前置问题,比分类更根本,需要先定:

- **"项目"如何界定?** 按 git root 还是 cwd?monorepo 子包算独立项目吗?从子目录运行算项目内吗?——这决定所有"项目级"发现的实现。
- **项目身份如何稳定?** §6.4 信任记录按绝对路径,仓库移动即失效,用户需重新确认(体验差);引入 git remote 作第二因子可以缓解,但 remote 本身可伪造,权重需要斟酌。

## 14. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v0 | 2026-09-04 | 初版,定义核心抽象与 v0 范围 |
| v0.1 | 2026-09-04 | 新增 §3 可插拔扩展架构、§4 循环执行语义、§5 配置系统、§6 安全与权限模型(含全局/项目收紧策略);提示词加 L2.5 skill 层;路线图重排为扩展点映射;新增 §13 待定议题(作用域模型,不展开);修正编号错乱与"迁移免费""逐事件落盘"等表述 |
| **v0.0.1** | 2026-09-13 | **规范版本号为 v0.0.1 & 引入场景模型路由设计**:将版本号对齐为初始可交付版本 v0.0.1;第一期模型协议收敛为以 OpenAI API 兼容协议为主(涵盖原生 OpenAI、DeepSeek 与推理模式、Ollama 等),Anthropic 协议规范保留在契约层、实现现重排至 v0.0.4;架构引入**场景模型路由(Role-based Model Routing)**蓝图(规划用高智力模型,执行用高吞吐低成本模型),v0.0.1 预留配置与路由契约;CLI REPL 增加内建 Slash 命令分发系统(`/model`, `/settings`, `/clear`, `/status`, `/help`, `/exit`),Session 增加运行时控制 API;配置体系统一采用 `.kapibala` 目录与 `settings.json` 文件名,增加带 `$schema` 智能校验、首启交互式向导(Setup Wizard)与全局 `~/.kapibala/settings.json` 持久化机制;修复 ToolExecutor 与 sandbox 依赖边界;完善终端 Ctrl+C 中断状态机 |
| **v0.0.1 收尾增强** | 2026-09-22 | **既有能力增强与未来路线重排**:已完成请求指标与上下文占用、工具调用耗时/脱敏展示、每轮底栏当前 Git 分支、`contextWindow` 的 `K/M` 简写和默认 `1M` 估算,补齐 PathSandbox/Hook 回归测试,并以自动化门禁固化 Headless Core / Host Adapter 边界;跨平台启动继续保持单一流程真源。后续按依赖拆为 v0.0.2 权限与 AGENTS.md、v0.0.3 消息/压缩、v0.0.4 多协议/模型路由、v0.0.5 Skills、v0.0.6 MCP、v0.0.7 多会话/Sub-Agent、v0.0.8 TUI、v0.0.9 客户端协议与发布加固,再按十进制进位进入 v0.1.0 整合版本。未来规划项不得在实现前作为现成功能宣传。 |
| **v0.0.1 审查修复** | 2026-09-23 | 递归 grep 跳过符号链接,文件工具增加单行与输出边界并拒绝空替换目标;CLI 过滤模型输出中的终端控制序列;OpenAI 兼容 Provider 在 wire 层规整失败轮次消息。澄清 v0.0.1 capability 仅为声明,统一执行前授权属 v0.0.2;消息规范化前移至 v0.0.3,多会话与子代理分阶段验收, v0.0.9 聚焦本地客户端契约。 |
