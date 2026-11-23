<div align="center">

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png" />
    <img src="assets/logo.png" width="480" alt="Kapibala" />
  </picture>

  **心如止水，稳定如初 —— AI Agent Harness**

  <p>
    <a href="https://github.com/tedburner/kapibala/actions/workflows/verify.yml"><img src="https://github.com/tedburner/kapibala/actions/workflows/verify.yml/badge.svg" alt="Verify" /></a>
    <a href="https://www.npmjs.com/package/@kiturone/kapibala-cli"><img src="https://img.shields.io/npm/v/@kiturone/kapibala-cli?label=cli&color=0969da" alt="CLI Version" /></a>
    <a href="https://www.npmjs.com/package/@kiturone/kapibala"><img src="https://img.shields.io/npm/v/@kiturone/kapibala?label=core%20sdk&color=0969da" alt="Core SDK Version" /></a>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0-2da44e?logo=node.js&logoColor=white" alt="Node.js" /></a>
    <a href="packages/core/package.json"><img src="https://img.shields.io/badge/core%20deps-0-1f883d" alt="Zero Runtime Dependencies" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8250df" alt="MIT License" /></a>
  </p>

  <p>
    <a href="#快速开始">快速开始</a> ·
    <a href="#核心特性">核心特性</a> ·
    <a href="#交互式-cli">交互式 CLI</a> ·
    <a href="#桌面客户端">桌面客户端</a> ·
    <a href="#headless-sdk">Headless SDK</a> ·
    <a href="#架构与包结构">架构与包结构</a> ·
    <a href="#本地开发">本地开发</a> ·
    <a href="#文档与路线图">文档与路线图</a>
  </p>

</div>

---

**Kapibala**（命令行入口 `kpbl`）是从零构建的 TypeScript AI Agent Harness，用同一套无头运行时同时驱动**交互式终端 CLI**、**本地守护进程**、**Electron 桌面客户端**与 **Headless SDK**。

核心包 `@kiturone/kapibala` 保持 **0 外部运行时依赖**，不绑定任何终端或 GUI。所有容易失控的运行态都受明确不变量约束：`tool_use` 与 `tool_result` 强制成对闭合、崩溃重启不重放工具副作用、持久历史采用独立 JSONL 因果树、上下文按两级预算保守压缩、命令执行经过词法风险分级与路径硬禁区裁决。

## 快速开始

环境要求：Node.js 20+。

### 1. 命令行直接使用

```bash
# 免安装直接启动（首次运行自动进入两步向导配置厂商与 API Key）
npx @kiturone/kapibala-cli

# 或全局安装后在任意项目目录运行 kpbl
npm install -g @kiturone/kapibala-cli
kpbl
```

也支持直接通过环境变量提供凭证（如 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`），同一厂商族下的多个模型自动共用同一份密钥。

### 2. 作为 SDK 集成

```bash
npm install @kiturone/kapibala          # 零运行时依赖 Headless Core
npm install @kiturone/kapibala-mcp      # 可选：MCP 协议扩展包（CLI 与桌面端已内置）
```

## 核心特性

- **确定性会话与上下文管理**：每个会话保存为独立的 Schema v2 JSONL 因果树（`parentId` / `branchId`），支持回答级无损重试、任意节点分叉（`/branch` / `/fork`）与跨项目全文检索。工具调用强制事务闭合，异常中断后重启只补写 `OUTCOME_UNKNOWN` 占位，绝不静默重放写操作；长对话自动对保护窗口外的旧读取结果先剪裁、再做滚动摘要。
- **原生多协议与场景路由**：内置 **8 家厂商 / 20 款模型**（DeepSeek、OpenAI、Anthropic、Google Gemini、通义千问、Kimi、智谱、本地 Ollama）并支持自定义网关，同时实现原生 **Anthropic Messages**、**OpenAI Responses** 与 **OpenAI Chat Completions** 兼容层，支持按 `default`、`planning`、`execution`、`fast`、`summary` 角色路由不同模型。
- **风险分级权限与路径硬禁区**：提供 `Approval`、`Plan`、`Auto`、`FullAccess` 四档模式，内部按「沙箱边界 × 询问策略」两轴裁决。Shell 命令经词法分析划分为 7 类风险（干净的工作区内构建与测试在 `Auto` 下直接放行，未跟踪或已修改脚本绑定内容摘要审批指纹）；`.git/hooks`、`.git/config`、`.env*`、`.envrc` 与 `.kapibala/**` 设为硬禁区，任何工具写入均直接拦截。
- **多任务委派、跨会话引用与外部监视**：除后台子代理任务树（`spawn_agent`）外，支持创建用户可见、可续聊的独立委派会话（`/delegate` / `send_agent`）；支持把同项目其它会话或分支的消息作为带溯源头的脱敏冻结快照引入当前上下文（`/quote`）；内置会话级外部监视（`watch_start` / `/watches`），监听文件变更或本地端口就绪后落盘背景通知并在空闲时自动续跑。
- **MCP 与技能体系（支持跨工具导入）**：支持 Stdio 与 Streamable HTTP 双传输 MCP 服务，按服务器配置摘要逐个批准启动并提供 `/prompt` 模板调用；有界 `SkillRegistry` 支持按需加载与 `allowed-tools` 权限收紧；支持从 Claude Code、Codex、Cursor 等外部工具预览并一次性导入技能与 MCP 配置。

## 交互式 CLI

`kpbl` 内置 ConPTY / Bracketed Paste 终端输入守护、按厂商分组的模型菜单、过程输出折叠（`Ctrl+O` 切换详情）与结构化审计日志。

```bash
kpbl                                      # 启动交互式会话终端（默认新建会话）
kpbl -p "解释当前仓库的模块依赖关系"         # 免交互单次问答并退出
kpbl --continue                           # 继续当前项目最近一次会话
kpbl --resume <session-id>                # 按完整 ID 或唯一前缀恢复指定会话
kpbl -m claude-sonnet-5 --role planning   # 指定模型与场景角色启动
kpbl --permission auto                    # 指定本次会话权限档位: approval|plan|auto|full-access
kpbl daemon                               # 启动受控本地守护进程（支持 kpbl connect 接入）
```

常用 Slash 命令速查（完整 40+ 条命令、参数与快捷键见 [docs/cli.md](docs/cli.md)）：

| 分类 | 命令 | 说明 |
|---|---|---|
| 模型与权限 | `/model` · `/permissions` | 两步分级切换模型、查看或切换会话权限档位 |
| 历史与分支 | `/history` · `/resume` · `/branch` · `/fork` | 查看分支树（`--tree`）、跨项目全文检索（`--search`）、切分支或导出新会话 |
| 上下文复用 | `/quote` · `/context` · `/compact` | 跨会话引用历史片段、查看上下文预算占比、手动触发压缩 |
| 多代理与监视 | `/delegate` · `/delegations` · `/agents` · `/watches` | 派发可续聊委派会话、观测后台子代理任务树、管理文件/端口监视 |
| 任务与证据 | `/todos` · `/evidence` · `/status` · `/logs` | 查看四态任务清单、聚合会话文件增删行数与来源看板、查看审计日志 |
| 扩展生态 | `/mcp` · `/prompts` · `/skills` · `/skill` | 管理与导入 MCP 服务、调用受控 Prompt、诊断与导入本地技能 |

## 桌面客户端

基于同一套 Harness 构建的跨平台 Electron 工作台：Main 进程只管原生窗口、托盘与通知，单个 `utilityProcess` 运行 Agent Host，沙箱化的 React 渲染层通过版本化本地协议只接收脱敏 `ViewModel` 快照与增量事件。

- **Streamdown 对话与富内容预览**：支持按需全语言代码高亮、代码块折行开关、沙箱化 HTML/SVG 渲染预览、Mermaid 图表、KaTeX 公式、内联图片与紧凑思考块，千条长会话采用虚拟列表保持流畅滚动。
- **任务胶囊与右侧信息抽屉**：输入框上方实时展示 `todo_write` 任务进度胶囊与四态清单浮层，底栏常驻工作区、Git 分支与上下文用量；右侧抽屉集成**会话证据看板**（真实持久化的文件增删行数、引用溯源、MCP 调用与委派汇总）、**图片产物自动预览**与**工具差异详情**。
- **统一配置与资源管理**：与 CLI 读写同一份 `~/.kapibala/` 配置，图形化管理厂商分组模型与连通性探测、项目文件夹信任授权、MCP 服务器增删改与逐服务批准、跨工具技能/MCP 导入抽屉，以及 GitHub Releases 版本检查与 SHA-256 校验下载。

```bash
pnpm dev:desktop     # 桌面端开发模式（热重建，读写本机 ~/.kapibala 配置）
pnpm try:desktop     # 打包测试版桌面应用并以隔离临时目录启动（不触碰个人配置）
```

> [!NOTE]
> **关于预构建桌面安装包**：GitHub Releases 随版本自动构建并附带 macOS（arm64 / x64）、Windows、Linux 四平台**未签名个人自用测试包**，当前不包含代码签名、Apple 公证与静默自动安装。macOS 首次打开需右键打开或执行 `xattr -dr com.apple.quarantine`，Windows 首次运行会提示 SmartScreen。发布边界与校验说明见 [docs/desktop-release.md](docs/desktop-release.md)。

## Headless SDK

`@kiturone/kapibala` 可独立嵌入任意 Node.js 服务、评测流水线或自定义前端，通过异步迭代器消费结构化 `SessionEvent`：

```typescript
import {
  AgentSession,
  OpenAICompatibleProvider,
  builtinTools,
  type ModelProfile,
} from '@kiturone/kapibala';

const profile: ModelProfile = {
  id: 'deepseek-flash',
  name: 'DeepSeek Flash',
  provider: 'openai-compatible',
  baseURL: 'https://api.deepseek.com/v1',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  modelName: 'deepseek-flash',
  supportsThinking: true,
};

const session = new AgentSession({
  workspaceRoot: process.cwd(), // 必填：显式传入工作区绝对路径，Core 不隐式读取 cwd
  defaultProfile: profile,
  defaultProvider: new OpenAICompatibleProvider({
    baseURL: profile.baseURL,
    apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    modelName: profile.modelName,
  }),
});

for (const tool of builtinTools) {
  session.tools.register(tool);
}

try {
  await session.init();
  for await (const event of session.run('请梳理当前目录下的模块入口')) {
    if (event.type === 'text_delta') process.stdout.write(event.text);
  }
} finally {
  await session.destroy();
}
```

自定义工具（`defineTool`）、生命周期钩子（`HookRegistry`）、多角色模型路由与原生 Anthropic / OpenAI Responses 协议接入见 [docs/sdk.md](docs/sdk.md)。

## 架构与包结构

仓库采用 pnpm workspace 管理，包与进程边界由 CI 门禁脚本（`check-architecture`、`check-desktop`、`check-protocol-contract`、`check-public-api`）静态强制：

```text
┌──────────────────────┐   ┌───────────────────────────┐   ┌────────────────────┐
│  packages/cli (kpbl) │   │ packages/desktop (Electron)│   │   Your Custom App  │
└──────────┬───────────┘   └─────────────┬─────────────┘   └─────────┬──────────┘
           │                             │ Typed IPC / Wire v2       │
           └──────────────┬──────────────┘                           │
                          ▼                                          │
           ┌──────────────────────────────┐                          │
           │  packages/host (Shared Host) │                          │
           │  Protocol · ViewModel · Watch│                          │
           └──────────────┬───────────────┘                          │
                          │                ┌─────────────────────────┤
                          ▼                ▼                         ▼
           ┌──────────────────────────────┐           ┌─────────────────────────┐
           │ packages/mcp (@kiturone/...) │──────────▶│      packages/core      │
           │   Stdio & Streamable HTTP    │  Plugin   │  Headless · 0 Deps SDK  │
           └──────────────────────────────┘           └─────────────────────────┘
```

| 路径 | 包名 | 发布形态 | 职责边界 |
|---|---|---|---|
| `packages/core` | [`@kiturone/kapibala`](https://www.npmjs.com/package/@kiturone/kapibala) | npm 公共包 | Headless 核心：Agent 循环、工具与权限裁决、JSONL 因果会话、压缩、原生多协议 Provider，运行时 0 依赖 |
| `packages/mcp` | [`@kiturone/kapibala-mcp`](https://www.npmjs.com/package/@kiturone/kapibala-mcp) | npm 公共包 | MCP 客户端插件：Stdio / Streamable HTTP 传输、进程树回收、按源原子上下线与受控 Prompt |
| `packages/host` | `@kiturone/kapibala-host` | 私有共享层 | 跨端宿主真源：版本化协议契约、0 Node 依赖纯 `ViewModel`、受管会话装配、外部监视与资源导入 |
| `packages/cli` | [`@kiturone/kapibala-cli`](https://www.npmjs.com/package/@kiturone/kapibala-cli) | npm 公共包 | 命令行工具 `kpbl`：交互式 REPL、40+ Slash 命令、冷启动向导、本地守护进程与客户端 SDK 转发出口 |
| `packages/desktop` | `@kiturone/kapibala-desktop` | GitHub Release | Electron 桌面工作台：Main / Agent Host / 沙箱 Renderer 三进程隔离，基于 Kumo 与 Streamdown 构建 |

## 本地开发

克隆仓库后，一条命令即可完成环境检查、依赖安装、工作区软链自愈、全包构建、门禁校验并启动源码 REPL：

```bash
git clone https://github.com/tedburner/kapibala.git
cd kapibala
pnpm dev
```

常用开发与门禁命令（跨平台开发脚本参数见 `node scripts/dev.mjs --help`）：

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 依赖检查 → 工作区链接自愈 → 构建 → 全量校验 → 启动 CLI REPL |
| `pnpm dev:build` | 执行构建与全量校验，不进入交互终端 |
| `pnpm verify` | 提交门禁：`typecheck` → `build + vitest` → `lint`（含架构边界、契约快照、密钥扫描与 Biome） |
| `pnpm dev:desktop` | 启动桌面客户端开发模式（热重载） |
| `pnpm verify:desktop` | 桌面完整门禁：生产构建 → 产物边界检查 → 桌面单测 → Playwright 真 Electron E2E |
| `pnpm verify:compat` | 公开 API 与历史 tarball 跨版本兼容性矩阵校验 |
| `pnpm verify:soak` | 本地守护进程与会话恢复稳定性压力冒烟 |

## 文档与路线图

| 文档 | 内容 |
|---|---|
| [配置系统](docs/configuration.md) | 配置文件层级、`$schema` 补全、内置模型目录与自动迁移机制 |
| [CLI 使用指南](docs/cli.md) | 命令行参数、全量 Slash 命令、配置向导与终端快捷键 |
| [SDK 使用指南](docs/sdk.md) | Headless 接入、自定义工具、Hooks、场景路由与多协议示例 |
| [架构设计](docs/architecture.md) | 六大核心领域、工具事务闭合不变量与宿主复用边界 |
| [本地宿主与协议](docs/local-host.md) | `daemon` / `connect` / `serve --stdio` 与 [本地 wire 协议规范](docs/local-protocol.md) |
| [MCP 使用指南](docs/mcp.md) | MCP 服务器配置、逐服务授权、跨工具导入与 `/prompt` 用法 |
| [技能体系](docs/skills.md) | `SKILL.md` 规范、信任边界、按需加载与跨工具导入诊断 |
| [模型与协议](docs/models/openai-compatible.md) | [Anthropic 原生](docs/models/anthropic.md)、[OpenAI Responses](docs/models/openai-responses.md)、兼容层与输出预算 |
| [桌面开发指南](docs/desktop-development.md) | 桌面三进程边界、开发调试与 [未签名测试包发布流程](docs/desktop-release.md) |
| [SDK 兼容性说明](docs/sdk-compatibility.md) | 公开导出面兼容基线与版本迁移差异登记 |
| [版本发布与路线图](docs/RELEASES.md) | 历次版本交付明细、验收记录与后续规划（如 `v0.1.5` 第三方 ACP 接入、`v0.1.6` Git Worktree 隔离与文件检查点） |

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
