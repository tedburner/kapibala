<div align="center">

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png" />
    <img src="assets/logo.png" width="480" alt="Kapibala" />
  </picture>

  **心如止水，稳定如初 —— AI Agent Harness**

  <p>把 Claude Code、Codex、Pi、Antigravity、OpenCode 与自研多协议 Agent 放进同一个桌面工作台与终端。</p>

  <p>
    <a href="https://github.com/tedburner/kapibala/releases/latest"><strong>下载桌面客户端</strong></a> ·
    <a href="#客户端核心体验">核心体验</a> ·
    <a href="#支持的外部代理与模型生态">支持代理</a> ·
    <a href="#安装与快速开始">快速安装</a> ·
    <a href="#2-命令行与守护进程">CLI 终端</a> ·
    <a href="#文档与路线图">文档</a> ·
    <a href="https://github.com/tedburner/kapibala/releases">更新日志</a>
  </p>

  <p>
    <a href="https://github.com/tedburner/kapibala/actions/workflows/verify-main.yml"><img src="https://github.com/tedburner/kapibala/actions/workflows/verify-main.yml/badge.svg?branch=main" alt="Verify main" /></a>
    <a href="https://github.com/tedburner/kapibala/releases/latest"><img src="https://img.shields.io/github/v/release/tedburner/kapibala?label=release&color=0969da" alt="GitHub Release" /></a>
    <a href="https://www.npmjs.com/package/@kiturone/kapibala-cli"><img src="https://img.shields.io/npm/v/@kiturone/kapibala-cli?label=cli&color=0969da" alt="CLI Version" /></a>
    <a href="https://www.npmjs.com/package/@kiturone/kapibala"><img src="https://img.shields.io/npm/v/@kiturone/kapibala?label=core%20sdk&color=0969da" alt="Core SDK Version" /></a>
    <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-2da44e" alt="Supported platforms: macOS, Windows, and Linux" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8250df" alt="MIT License" /></a>
  </p>

</div>

---

**Kapibala**（命令行入口 `kpbl`）是面向桌面与终端的开源多代理编码工作台。打开桌面客户端，在同一个界面里既能直接驱动本机已经安装登录的外部编码代理（Claude Code、Codex、Pi、Antigravity、OpenCode 以及任意兼容 ACP 的 CLI），也能运行内置的零依赖多协议 Agent 引擎，流式查看思考过程、工具操作、任务清单与变更证据，就地完成风险审批。

外部代理直接复用你本机已有的订阅和登录态（比如 `claude auth login`、`codex login`、`agy acp --login`），不转售 Token，也不在应用内重复保管第三方明文密钥。你熟悉哪个代理就用哪个，需要切模型或换代理时不用离开当前工作区。

## 客户端核心体验

### 一个窗口统管所有本地代理

宿主层内置 `claude-cli`、`codex-app-server`、`pi-rpc` 与通用 `acp` 四套零外部 SDK 的原生管道。新建对话与本地、外部历史会话共用统一三栏选择器，可按代理浏览或搜索模型、按具体模型联动筛选推理强度（Effort）与运行模式（切换在下一轮发送时生效，不打断在途生成；跨代理切换自动携带当前对话上下文接力新建会话）。设置页提供全图形化的「外部代理」中心，支持一键握手探测、手动刷新本地模型缓存、从官方 ACP 模板填充参数、按变量名透传环境变量（`envFrom`），并在子进程空闲回收或重启后保留有界脱敏只读快照，打开历史会话不会白屏。

### 流式工作台、富内容预览与证据看板

对话正文基于 `streamdown` 构建，支持按需全语言代码高亮（自适应明暗双主题）、代码块折行开关、沙箱化 HTML/SVG 预览、Mermaid 图表与 KaTeX 公式；工作区内 `write_file` 生成的图片产物会自动投影到右侧抽屉预览。连续同类工具调用自动收拢为紧凑执行组，轮次结束后自动折叠过程细节；右侧抽屉内置**会话证据看板**，实时汇总真实持久化的文件增删行数、跨会话引用溯源、MCP 调用次数与委派任务状态。

### 可续聊委派、跨会话引用与后台条件监视

需要拆分长任务时，除了后台子代理任务树（`spawn_agent`），还可以派发用户可见、终态后可随时续聊的独立委派会话（`/delegate`）。通过 `/quote` 可以把同项目其他会话或历史分支的片段作为带溯源头的脱敏冻结快照引入当前对话。内置会话级条件监视（`watch_start` / `/watches`），监听工作区文件变更或本地端口就绪，触发后自动落盘背景通知并在空闲时唤醒续跑，省掉模型轮询等待。

### 桌面、终端与本地守护进程同源

Electron 桌面客户端、交互式终端 `kpbl` 与本地守护进程 `kpbl daemon` 共享同一套私有宿主层与 `~/.kapibala/` 配置。每个内置会话保存为独立的 Schema v2 JSONL 因果树，支持回答级无损重试、任意历史节点分叉（`/branch` / `/fork`）、`↑/↓` 历史问句召回与跨项目全文检索，千条长会话通过虚拟列表保持顺滑滚动。

### 风险分级权限与跨信任域审批隔离

内置引擎提供 `Approval`、`Plan`、`Auto`、`FullAccess` 四档权限，Shell 命令经词法分析划分为 7 类风险（干净工作区内的构建测试在 `Auto` 下直接放行，未跟踪或已改动的本地脚本绑定内容摘要重审），`.git/hooks`、`.git/config`、`.env*` 与 `.kapibala/**` 设为硬禁区直接拒绝写入。外部代理发起敏感操作时，消息流底部会弹出带倒计时的内联审批卡，本地的 `Auto` 与 `FullAccess` 绝不跨信任域自动放行外部代理请求。

### 受控 MCP 与跨工具技能导入

内置 Stdio 与 Streamable HTTP 双传输 MCP 客户端，每次启动服务绑定完整配置摘要逐个批准，配置一旦改动即重新待批。图形界面与 CLI 均支持从 Claude Desktop、Claude Code、Codex、Cursor、OpenCode 一键扫描脱敏预览，将已有的技能包（`SKILL.md`）与 MCP 服务配置一次性导入自有目录。

**开箱即用的细节：**

- **原生多协议与场景路由**：内置 **8 家厂商 / 20 款模型**，原生实现 Anthropic Messages、OpenAI Responses 与 Chat Completions 兼容层，支持按 `default / planning / execution / fast / summary` 角色路由不同模型，同厂商自动共用单份密钥。
- **输入框 `@` 文件补全、`/` 技能直发与逐轮元信息尾栏**：在桌面与终端输入 `@` 即时检索沙箱内文件，输入 `/skill <名称>` 回车即可运行技能；已完成任务清单在新轮次自动收起，每轮回答正文尾部常驻显示当轮实际使用的代理、模型、推理强度与 Token 消耗。
- **确定性事务闭合与两级上下文压缩**：`tool_use` 与 `tool_result` 强制成对落盘，崩溃重启只补写 `OUTCOME_UNKNOWN` 占位而不重放写操作；长对话先剪裁旧读取结果，再做增量滚动摘要。
- **Windows 无 Shell 安全解包与进程树回收**：全程 `shell: false`，自动探测 GUI 受限 `PATH` 常见目录并静态解包 `.cmd` 垫片；关闭或超时取消时先走 `stdin.end()` 优雅收尾，超时自动升级进程树强杀，不留孤儿进程。
- **失焦通知与校验更新**：后台会话完成、失败或待审批时自动发送系统通知，设置页支持检查 GitHub Releases 新版本并校验 `SHA256SUMS.txt` 后下载。

---

## 支持的外部代理与模型生态

本机终端能跑的编码代理，都能直接接入 Kapibala（未安装的内置预设默认保持停用，不污染选择菜单）：

<p>
  <kbd>Claude Code</kbd> &nbsp;
  <kbd>Codex</kbd> &nbsp;
  <kbd>Pi Coding Agent</kbd> &nbsp;
  <kbd>Antigravity (agy)</kbd> &nbsp;
  <kbd>OpenCode</kbd> &nbsp;
  <kbd>DeepSeek Harness</kbd> &nbsp;
  <kbd>Oh My Pi (OMP)</kbd> &nbsp;
  <kbd>Gemini CLI</kbd> &nbsp;
  <kbd>Qwen Code</kbd> &nbsp;
  <kbd>Qoder / Qoder CN</kbd> &nbsp;
  <kbd>TRAE / TRAE CN</kbd> &nbsp;
  <kbd>GitHub Copilot CLI</kbd> &nbsp;
  <kbd>Cursor Agent</kbd> &nbsp;
  <kbd>Cline</kbd> &nbsp;
  <kbd>Kimi Code</kbd> &nbsp;
  <kbd>Goose</kbd> &nbsp;
  <kbd>Mistral Vibe</kbd> &nbsp;
  <kbd>Auggie</kbd> &nbsp;
  <kbd>+ 任意本地 ACP 命令</kbd>
</p>

内置自研 Harness 原生对接 **DeepSeek**、**OpenAI**、**Anthropic**、**Google Gemini**、**通义千问**、**Kimi**、**智谱 GLM**、**本地 Ollama** 及任意自定义网关。

---

## 安装与快速开始

运行环境（CLI 与 SDK）：Node.js 20+。桌面客户端自带运行时，开箱即用。

### 1. 桌面客户端（推荐）

前往 [GitHub Releases](https://github.com/tedburner/kapibala/releases/latest) 下载对应平台安装包（macOS Apple Silicon / Intel、Windows x64、Linux AppImage），打开后宿主进程随应用自动启动。

> [!NOTE]
> **关于预构建桌面测试包**：GitHub Releases 当前附带四平台**未签名个人自用测试包**，不含商业代码签名、Apple 公证与静默自动安装。macOS 首次打开需右键打开或执行 `xattr -dr com.apple.quarantine`，Windows 首次运行会弹出 SmartScreen 提示。校验方式与发布边界见 [桌面发布说明](docs/desktop-release.md)。

### 2. 命令行与守护进程

在终端免安装体验或全局安装 `kpbl`：

```bash
# 免安装直接启动（首次运行若无可用密钥会自动进入两步配置向导）
npx @kiturone/kapibala-cli

# 或全局安装后在任意项目目录运行
npm install -g @kiturone/kapibala-cli
kpbl
```

桌面客户端里能做的事，在终端里同样顺手：

```bash
kpbl                                         # 启动交互式会话终端
kpbl -p "梳理当前仓库的模块依赖与入口"          # 免交互单次问答并退出
kpbl --continue                              # 接续当前项目最近一次会话
kpbl -m claude-sonnet-5 --role planning      # 指定模型与场景角色启动
kpbl daemon start                            # 启动本地受控守护进程（支持 kpbl connect 接入）
```

在交互终端内可直接管理外部代理、委派任务与条件监视（完整 40+ 条命令见 [CLI 使用指南](docs/cli.md)）：

```text
/external harnesses                          # 查看内置与自定义外部代理状态
/external harness test                       # 对已启用代理执行真实握手与版本探测
/external start --model gpt-6.1-sol codex 检查并修复失败单测
/external config <sessionId> mode plan       # 空闲态切换外部代理模式或模型
/delegate 巡检 docs/ 链接完整性 --name 文档巡检
/quote --search "权限裁决"                    # 检索并跨会话挂载脱敏历史片段
/watches                                     # 查看文件变化与本地端口就绪监视
```

### 3. 登录外部代理或配置模型密钥

- **使用外部代理**：确保本机已安装至少一款代理 CLI 并完成其自有登录（如 `claude auth login`、`codex login`、`pi` 内 `/login` 或 `agy acp --login`），打开 Kapibala 即可在输入框选用。
- **使用内置自研引擎**：首次启动按向导填入任一厂商 API Key，或直接设置环境变量（`DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY` 等）。

---

## Headless SDK

核心包 `@kiturone/kapibala` 保持 **0 外部运行时依赖**，不绑定任何终端或 GUI，可直接嵌入评测流水线、后端服务或自定义前端：

```bash
npm install @kiturone/kapibala          # 零运行时依赖 Headless Core
npm install @kiturone/kapibala-mcp      # 可选：MCP 协议扩展包（CLI 与桌面端已内置）
```

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
  workspaceRoot: process.cwd(),
  defaultProfile: profile,
  defaultProvider: new OpenAICompatibleProvider({
    baseURL: profile.baseURL,
    apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    modelName: profile.modelName,
  }),
});

for (const tool of builtinTools) session.tools.register(tool);

try {
  await session.init();
  for await (const event of session.run('请梳理当前目录下的模块入口')) {
    if (event.type === 'text_delta') process.stdout.write(event.text);
  }
} finally {
  await session.destroy();
}
```

自定义工具（`defineTool`）、生命周期钩子（`HookRegistry`）与原生多协议接入见 [SDK 使用指南](docs/sdk.md)，公开导出兼容承诺见 [SDK 兼容性说明](docs/sdk-compatibility.md)。

---

## 架构与本地开发

仓库采用 pnpm workspace 管理，包边界与进程隔离由门禁脚本（`check-architecture`、`check-desktop`、`check-protocol-contract`、`check-public-api`）静态强制：

| 路径 | 包名 | 发布形态 | 职责边界 |
|---|---|---|---|
| `packages/desktop` | `@kiturone/kapibala-desktop` | GitHub Release | Electron 桌面工作台：Main / Preload / `utilityProcess` Agent Host / 沙箱 Renderer 四层隔离 |
| `packages/cli` | [`@kiturone/kapibala-cli`](https://www.npmjs.com/package/@kiturone/kapibala-cli) | npm 公共包 | 命令行工具 `kpbl`：交互式 REPL、40+ Slash 命令、本地守护进程与客户端子路径出口 |
| `packages/host` | `@kiturone/kapibala-host` | 私有共享层 | 跨端宿主真源：Wire v2 协议、0 Node 依赖纯 `ViewModel`、受管会话装配、外部代理编排与监视 |
| `packages/core` | [`@kiturone/kapibala`](https://www.npmjs.com/package/@kiturone/kapibala) | npm 公共包 | Headless 核心：Agent 循环、工具与风险权限裁决、JSONL 因果会话、两级压缩与多协议 Provider（0 依赖） |
| `packages/mcp` | [`@kiturone/kapibala-mcp`](https://www.npmjs.com/package/@kiturone/kapibala-mcp) | npm 公共包 | MCP 客户端插件：Stdio / Streamable HTTP 传输、进程树回收与受控 Prompt |

从源码启动开发或运行完整门禁：

```bash
git clone https://github.com/tedburner/kapibala.git
cd kapibala

pnpm dev:desktop     # 启动桌面客户端开发模式（热重载）
pnpm try:desktop     # 打包测试版桌面应用并以隔离临时目录启动（不触碰个人 ~/.kapibala）
pnpm dev             # 依赖自愈 → 全包构建 → 门禁校验 → 启动 CLI 交互终端
pnpm verify          # 全仓门禁：typecheck → build + vitest → 架构/协议/密钥/Biome 检查
pnpm verify:desktop  # 桌面完整门禁：生产构建 → 产物边界检查 → 桌面单测 → Playwright 真 Electron E2E
```

---

## 文档与路线图

每个版本的详细特性速览与分组变更记录见 **[GitHub Releases 更新日志](https://github.com/tedburner/kapibala/releases)**。

| 文档 | 内容 |
|---|---|
| [版本发布与路线图](docs/RELEASES.md) | 历次版本交付明细与后续规划（`v0.1.6` Git Worktree 并行隔离、文件检查点回滚与 UI 2.0 多标签工作台） |
| [桌面开发指南](docs/desktop-development.md) | 桌面四进程边界、开发调试与 [桌面发布流程](docs/desktop-release.md) |
| [CLI 使用指南](docs/cli.md) | 命令行参数、全量 Slash 命令与终端快捷键 |
| [配置系统](docs/configuration.md) | 配置文件层级、`$schema` 补全、内置模型目录与自动迁移 |
| [本地宿主与协议](docs/local-host.md) | `daemon` / `connect` / `serve --stdio` 与 [Wire v2 协议规范](docs/local-protocol.md) |
| [MCP 使用指南](docs/mcp.md) | MCP 服务器配置、逐服务配置摘要批准与跨工具导入 |
| [技能体系](docs/skills.md) | `SKILL.md` 规范、信任边界、按需加载与跨工具导入诊断 |
| [架构设计](docs/architecture.md) | 核心六领域分层、工具事务闭合不变量与宿主复用边界 |
| [SDK 使用指南](docs/sdk.md) | Headless 接入、自定义工具、Hooks 与 [SDK 兼容性说明](docs/sdk-compatibility.md) |

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
