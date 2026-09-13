# AGENTS.md — Kapibala Agent 工作约定

## 定位

Kapibala（CLI 命令 `kpbl`）：从零构建的 TypeScript AI Agent Harness + 交互式 CLI。
pnpm monorepo：`packages/core`（`@kiturone/kapibala`，运行时 0 依赖）+ `packages/cli`（bin: `kpbl`）。
设计基线：`docs/design/001-agent-framework-design.md`（**用户本人维护，勿擅改章节编号与交叉引用**）。

## 怎么跑

- `pnpm install && pnpm build` 后 `pnpm dev:cli` 进入 REPL；`pnpm link:cli` 全局注册 `kpbl`。
- **验证门禁：`pnpm verify` = typecheck → test → lint**。注意 tsup/esbuild 不做类型检查，`pnpm build` 绿 ≠ 类型没问题。
- 密钥扫描 `pnpm check-secrets` 已并入 lint 流程，严禁提交真实 API Key。

## 核心不变量

- **历史必须闭合**：assistant 的 `tool_use` 一旦进入历史，对应 `tool_result` 必须紧跟其后（设计文档 §4.3 / §4.4）。loop 内任何 `break` / `throw` 必须发生在该不变量满足之后。
- 落盘是**消息级**：user / assistant / tool_result 三类消息都要经 `MessageStore.append` 落盘。

## 约定

- 品牌拼写只允许 **`Kapibala`**（禁止少一个 i 的旧拼法）；配置目录 **`.kapibala`**；错误基类 `KapibalaError`；默认 `agentName` 为 `'Kapibala'`。
- `/model` 的厂商族推断统一走 `packages/cli/src/settings.ts` 的 `detectProviderFamily`，不要在命令层另写启发式；密钥解析走同族回退（`FAMILY_KEY_ENV`），不做跨厂商兜底。
- **不自动 git add / commit**，改动保留在工作区由用户审核后手动提交。

## 标识资源（assets/）

- **单一真源 `assets/capybara.svg`**（贴纸风头像，640×600）。`logo / logo-dark / icon / logo-sign` 四个 SVG 由 `.workbuddy/build-assets.py` 从它派生，`.workbuddy/render.sh` 用 headless Chrome 出 PNG（`.workbuddy/` 已 gitignore，生成脚本不入库）。**改造型只改真源再重跑两个脚本，不要直接改派生文件。**
- 造型铁律：口鼻必须是"上窄下宽"的钝形深色块（水豚最关键辨识特征）；不要大面积奶油色口鼻斑（会读成泰迪熊）；头不要撑满画面（会读成河马）。
- README 抬头 `<picture>` + `prefers-color-scheme` 双主题（dark 版仅字标换暖白 `#F0E4D6`）；tagline 固定：**心如止水，稳定如初 —— AI Agent Harness**。

## 当前状态（2026-09-13）

- v0.0.1 已完成：核心骨架 + 交互 CLI + 冷启动向导 + PathSandbox 沙箱 + 崩溃历史自愈 + 场景模型路由契约；42 tests passed / 2 skipped。
- 路线图 v0.2+：Anthropic 原生协议、路由落地、Skills / MCP / 记忆压缩 / 子代理（详见 README 路线图表）。
