# 001 — Agent 框架技术方案(v0)

> 状态:已评审通过 · 2026-09-04(含第二轮评审修订)
> 范围:本篇定义 self-agent 框架 v0 的核心抽象、仓库结构、提示词设计与交付边界,是后续所有迭代的基线。

## 1. 背景与定位

- **目标**:从零构建一个认真开源的 TypeScript agent 框架。
- **形态**:v0 即提供**可用 CLI**——通过命令行完成 agent 对话与任务处理,不做图形界面。CLI 是框架的第一个消费者, 也是用户接触框架的门面。
- **技术栈**:TypeScript / Node.js ≥ 20,pnpm workspace monorepo。
- **核心决策**:
  - 框架与具体模型/工具解耦——模型层可替换,v0 同时实现 **Anthropic** 与 **OpenAI 兼容协议**(DeepSeek 走此通道,未来 Ollama/本地模型同样复用)。
  - 工具声明式注册,事件流贯穿全程(为后续 TUI/Web 客户端做准备)。
  - 提示词分层组装,不做单块硬编码文本(见 §5)。

## 2. 核心抽象

### 2.1 规范消息/事件模型(Canonical Model)——适配层的关键

框架内部只使用一套**规范消息模型**(`CanonicalMessage` / `ContentBlock`:text / tool_use / tool_result),模型差异由各 Provider 在边界处双向翻译:

```
Anthropic wire ──┐                    ┌── Anthropic wire
                 │  core(canonical)   │
OpenAI wire ─────┼── ◄── loop ──► ────┼── OpenAI wire(deepseek 等)
                 │                    │
未来 provider ───┘                    └── 未来 provider
```

- **入方向**(模型响应 → canonical):Provider 把自家流式响应(SSE)翻译为规范事件流。
- **出方向**(canonical 历史 → wire):Provider 把规范历史转成自家请求格式。
- 收益:loop 与 session 完全不感知模型差异;新增模型只写一个翻译器;跨模型会话迁移免费。

### 2.2 模块清单

1. **AgentSession**(`session/`)— 一次对话会话。持有消息历史、工具注册表、模型配置。`session.run(input)` 是唯一入口,返回事件流(`AsyncIterable<SessionEvent>`)。
2. **AgentLoop**(`loop/`)— 单次 run 内部的 while 循环:请求模型 → 消费规范事件流组装 assistant 消息 → 若有 tool_use 则执行工具、结果回填历史 → 继续请求,直到 stopReason 非 tool_use 或触达步数上限。纯逻辑,不碰 IO。
3. **ModelProvider**(`models/`)— 接口:`create(req: ModelRequest) -> AsyncIterable<ModelEvent>`。v0 实现:`anthropic/`、`openai-compatible/`(覆盖 DeepSeek)。
4. **Tool**(`tools/`)— `{ name, description, parameters(JSON Schema), execute(input, ctx) }`。工具结果进历史,同时作为事件发给 UI。v0 内置基础工具:read_file / write_file / edit_file / list_files / bash / grep(文件读写类必须是原生 tool,理由见 §2.4)。

### 2.4 Tool 与 Skill 的分层原则

基础能力一律做成 **tool(执行原语)**,不做成 skill;skill 是后续版本的**知识层**扩展点,两者叠加而非替代:

| | Tool | Skill |
|---|---|---|
| 本质 | 执行原语——代码确定性执行 | 知识包——markdown 指令注入上下文 |
| 谁执行 | 代码,确定性、可单测 | 模型读指令后自行组合 tools |
| 上下文成本 | schema 常驻(小),调用时才产生结果 | 整个指令体进上下文 |
| 安全边界 | 代码级强制(路径校验、沙箱) | 靠模型遵循文字约定 |
| 与 loop 关系 | 参与执行循环,产生事件 | 不参与执行循环,只影响行为 |

- **判断规则**:参数完备、确定性执行、可单测 → tool;需要判断力、上下文知识、多步流程编排 → skill。
- **启发式**:里面要写 for 循环和 try/catch 的是 tool;要写大段"应该怎么判断"的是 skill。
- **为什么文件读写必须是 tool**:① 确定性(read 返回的字节、edit 的原子替换都是代码逻辑);② 安全是代码问题不是提示词问题(沙箱校验必须每次调用由代码强制);③ 上下文经济学(tool 惰性,skill 整段进上下文)。
- skill 即使在后续版本实现后,文件操作也留在 tool 层不动——skill 承载的是"项目约定、操作规程"类知识。
5. **Event 流**(`events/`)— `SessionEvent` 统一枚:`message_start / text_delta / tool_call_start / tool_call_delta / message_stop / tool_result / error / done`。上层一切(TUI/Web/日志)只消费这个流。
6. **MessageStore**(`store/`)— 会话历史持久化接口(JSONL append-only 为默认实现),run 前加载、run 中逐事件落盘,进程崩溃可恢复。
7. **Prompt**(`prompt/`)— 系统提示词分层组装器,见 §5。

### 2.3 模块边界与依赖方向(单向,禁止反向)

```
session ──► loop ──► (models, tools, store, prompt, events, message)
```

- loop 不 import 任何模型实现(只依赖 ModelProvider 接口);models 不 import tools。
- 每个模块以 `index.ts` 作为唯一公开出口,内部文件不跨模块深引。
- `events/`、`message/` 是纯类型层,被所有模块依赖,自身不依赖任何模块。

## 3. 仓库结构(monorepo,pnpm)

> 结构原则:**每个核心模块 = core 下一个独立目录**,目录内自带接口定义与实现,模块间只走 `index.ts` 公开出口。目录即模块边界,保证后续扩展(新增 provider、新增工具、新增 store)都是"加目录",而不是改既有文件。

```
kapibala/
├── package.json              # pnpm workspace 根
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── biome.json                # lint + format(Biome 单工具)
├── packages/
│   ├── core/                 # @self-agent/core — SDK 本体
│   │   └── src/
│   │       ├── index.ts      #   唯一公开导出
│   │       ├── session/      #   AgentSession(组合 loop + prompt + tools + store)
│   │       ├── loop/         #   AgentLoop(纯逻辑)
│   │       ├── events/       #   SessionEvent / ModelEvent 规范事件类型
│   │       ├── message/      #   CanonicalMessage / ContentBlock 规范消息类型
│   │       ├── prompt/       #   提示词分层组装器(见 §5)
│   │       ├── tools/        #   Tool 接口 + registry + 内置工具(read/write/edit/bash/glob/grep)
│   │       ├── models/       #   ModelProvider 接口 + anthropic/ + openai-compatible/(DeepSeek)
│   │       └── store/        #   MessageStore 接口 + jsonl 实现
│   └── cli/                  # @self-agent/cli — 对话式 CLI(见 §4)
│       └── src/
│           └── index.ts      #   REPL 入口:读 stdin → run → 渲染事件流
├── examples/
│   └── minimal.ts            # 10 行的用法示例,文档的门面
└── docs/
    └── design/               # 设计文档(本篇所在)
```

## 4. v0 交付范围

1. **packages/core**:
   - Message / ContentBlock 类型(text / tool_use / tool_result)
   - `defineTool` 帮助函数(Zod schema → JSON Schema,运行时校验 + 类型推导二合一)
   - ToolRegistry(注册 / 查询 / 按名分发)
   - AgentLoop:完整 while 循环 + 最大步数保护 + 中断(AbortSignal 贯穿)
   - Anthropic provider:流式解析 SSE → ModelEvent
   - OpenAI 兼容 provider(DeepSeek):请求映射(工具/消息/停止原因)+ 流式 SSE 解析 → ModelEvent
   - JSONL MessageStore
   - 统一导出入口 `index.ts`
2. **packages/cli**:极简对话 REPL —— 读 stdin 一行,run,渲染事件流到终端(纯 stdout,不引 TUI 框架)。基础对话能力属 v0;技能、MCP、权限门等交互扩展属后续版本。
3. **examples/minimal.ts**:最短可用示例。
4. **docs/design/001**:本设计文档。
5. **工程化**:vitest、Biome、tsup 构建、changesets(开源版本管理)、GitHub Actions CI。
6. **不做**:多会话管理、上下文压缩、sub-agent、MCP、权限系统、skill 机制。

## 5. 提示词设计(分层组装)

**原则:系统提示词不是一段写死的文本,而是运行时分层组装的产物。** 每层独立演进、独立测试,来源单一:

| 层 | 内容 | 来源 | 稳定性 |
|----|------|------|--------|
| L1 行为层 | agent 身份、能力边界、响应风格、循环行为规则(如何使用工具、何时停止) | `prompt/` 内置模板 | 低频变更,随框架版本走 |
| L2 工具层 | 可用工具清单与使用说明 | 从 ToolRegistry **自动生成**——工具的 name/description/parameters 即文档,单一事实来源,注册即生效 | 随工具注册动态变化 |
| L3 环境层 | cwd、平台、日期、shell 等 | 运行时注入 | 每次 run 变化 |
| L4 用户层 | 项目约定、领域知识 | 项目根 `AGENTS.md`(预留,自动发现并拼装) | 用户自管 |

- 组装顺序 L1→L4,层间以固定分隔符连接,输出 `system prompt` 字符串。
- **与 Provider 的关系**:L1 存放模型无关的中性表述;各 Provider 可携带一层**模型级微调**(如 DeepSeek 与 Anthropic 的指令遵循风格差异),由 Provider 声明、组装器拼接——这就是分层带来的扩展空间。
- v0 先实现 L1+L2+L3;L4 的文件发现机制随工具管理一起做。

## 5. 技术要点

- **Zod + zod-to-json-schema**:工具参数声明,运行时校验与 TS 类型推导合一。
- **事件流统一用 AsyncGenerator**:不引 RxJS,压依赖面。
- **AbortSignal** 从 `run()` 透传到模型请求与工具执行,支持随时中断。
- **模块边界与依赖方向**(单向):`session → loop → (models, tools, store)`;loop 不 import 模型实现,models 不 import tools。

## 6. 验证方式

1. `pnpm install && pnpm build` 通过。
2. `pnpm test`:loop 在 mock provider(anthropic + openai-compatible)下正确执行多步工具调用;JSONL store roundtrip。
3. `pnpm dev`(cli REPL)分别连 Anthropic key 与 DeepSeek key,手工验证一轮对话 + 工具调用。
4. `examples/minimal.ts` 单独 `npx tsx` 可跑。

## 7. 后续路线(不在 v0)

- **v0.2**:多会话管理、上下文压缩、MCP、sub-agent
- **v0.3**:权限/确认门(tool 调用前人工确认)、流式渲染优化、TUI
- **v0.4**:skill 机制(知识层:内部 skill 与项目 skill,作为 tool 层之上的叠加扩展)、AGENTS.md 自动发现(L4)
