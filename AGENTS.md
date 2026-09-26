# AGENTS.md — Kapibala Agent 工作约定

## 定位

Kapibala（CLI 命令 `kpbl`）：从零构建的 TypeScript AI Agent Harness + 交互式 CLI。
pnpm monorepo：`packages/core`（`@kiturone/kapibala`，运行时 0 依赖）+ `packages/cli`（bin: `kpbl`）。
设计基线：`docs/design/001-agent-framework-design.md`（**用户本人维护，勿擅改章节编号与交叉引用**）。

## 怎么跑

- **一键入口：`pnpm dev`**（= `node scripts/dev.mjs`）→ 依赖安装(按需) → 工作区链接自愈 → 编译 → 校验 → 启动 REPL。
  该脚本是跨平台唯一真源；`scripts/dev.sh`（mac/Linux/Git Bash）与 `scripts/dev.cmd`（Windows，可双击）只是转发参数的薄壳。
  常用参数：`--no-verify`（跳过校验）、`--no-build`、`--clean`、`--no-start`（构建+校验后不启动，= `pnpm dev:build`）、
  `--verify-only`（只跑校验，等价于 `pnpm verify`）、`-p "问题"`（单次问答）、`--global`（注册 kpbl）。详见 `node scripts/dev.mjs --help`。
- ⚠️ **`--verify-only` 必须与 `pnpm verify` 同源**（typecheck → test → lint，含 check-secrets）。
  早前该分支只跑 typecheck + test 却输出「校验全部通过」，会漏掉 lint 错误与密钥泄露 —— 修过一次，别再退化。
- `pnpm dev:cli` 是 `tsup --watch`，**只监听重建、不启动 REPL**；启动请用 `pnpm dev` 或直接 `node packages/cli/dist/bin.js`。
- **验证门禁：`pnpm verify` = typecheck → test → lint**。注意 tsup/esbuild 不做类型检查，`pnpm build` 绿 ≠ 类型没问题。
- 密钥扫描 `pnpm check-secrets` 已并入 lint 流程，严禁提交真实 API Key。

### 已知环境坑（Windows）

- **workspace 软链会退化成空目录**：本机 pnpm 为 workspace 依赖（如 `@kiturone/kapibala`）创建链接时「成功」返回，但产物是空目录而非真实链接，
  运行时表现为 `ERR_MODULE_NOT_FOUND`。普通（非 workspace）依赖的链接不受影响。
  `scripts/dev.mjs` 的「工作区链接」步骤会检测这种空目录并用 junction 重建（无需管理员权限），因此**跑一次 `pnpm dev` 即可自愈**。
- **`.cmd` 必须保持纯 ASCII**：cmd.exe 在 `chcp` 生效前按 OEM 代码页（zh-CN 下为 GBK）解析文件，任何非 ASCII 字节都会破坏语法。

## 核心不变量

- **历史必须闭合**：assistant 的 `tool_use` 一旦进入历史，对应 `tool_result` 必须紧跟其后（设计文档 §4.3 / §4.4）。loop 内任何 `break` / `throw` 必须发生在该不变量满足之后。
- 落盘是**消息级**：user / assistant / tool_result 三类消息都要经 `MessageStore.append` 落盘。
- 消费者提前结束事件迭代时，必须取消并等待在途工具清理、闭合并落盘工具事务后再释放 Session 锁；已完成的工具保留真实结果。
- **Core 必须保持 Headless**：`packages/core/src` 不得依赖 CLI、直接读写终端或包含 ANSI/UI 渲染；所有宿主通过 `AgentSession` / `SessionEvent` 复用同一 Agent Harness。`pnpm check-architecture` 已并入 lint，新增宿主能力不得绕过该门禁。

## 约定

- 品牌拼写只允许 **`Kapibala`**（禁止少一个 i 的旧拼法）；配置目录 **`.kapibala`**；错误基类 `KapibalaError`；默认 `agentName` 为 `'Kapibala'`。
- `/model` 的厂商族推断统一走 `packages/cli/src/settings.ts` 的 `detectProviderFamily`，不要在命令层另写启发式；密钥解析走同族回退（`FAMILY_KEY_ENV`），不做跨厂商兜底。
- **密钥按厂商族共用（一个厂商只需配一次）**：分组键统一走 `credentialGroup()` —— 可识别厂商按 family 归组，`unknown` 退化到按端点 host 隔离（否则多个自建网关会串用同一把 key）；分组展示名走 `describeCredentialGroup()`。
- 同一分组内**只保留一份密钥**：读取走 `resolveApiKeyDetailed(profile, settings)`（第 2 级即"同厂商族已存密钥"），写入走 `updateProfileApiKey()`（自动清理同组冗余副本）。新增任何密钥读取/写入入口都不要绕过这两个函数，否则会出现「更新了 A 的密钥、B 仍在用旧密钥」的静默不一致。
- **不自动 git add / commit**，改动保留在工作区由用户审核后手动提交。

## 内置模型清单（`packages/cli/src/settings.ts`）

- `BUILTIN_PROFILES` 是唯一的内置模型真源（现为 8 家厂商 / 20 个模型），默认模型 `DEFAULT_MODEL_ID = 'deepseek-flash'`。
  厂商展示元数据（名称 / 描述 / 索要密钥的提示语）在 `packages/cli/src/providers.ts`，**`/model` 菜单与冷启动向导都从这里取**，
  不要在命令层或向导里再硬编码一份模型 id 清单 —— 那会退化成模型换代后 `BUILTIN_PROFILES.find(...)!` 的运行时崩溃（已发生过一次）。
- ⚠️ **改动 `BUILTIN_PROFILES` 必须同步两件事**：
  1. `BUILTIN_CATALOG_VERSION` **+1**（不加版本号，`migrateBuiltinCatalog` 不会触发，老用户菜单里会一直挂着已退役的模型）；
  2. 每个被删掉的 id 都要在 `LEGACY_PROFILE_REDIRECT` 里补一条重定向。
- ⚠️ `loadSettings` 是「**全局覆盖内置**」的浅合并：只改 `BUILTIN_PROFILES` **不会影响**已经落盘的 `~/.kapibala/settings.json`。
  存量配置靠启动时的 `migrateGlobalSettingsCatalog()` 升级（见 `packages/cli/src/index.ts` 步骤 0，失败不阻断启动）。
- ⚠️ **「读全局 → 改一处 → 写回」必须用 `loadGlobalSettingsForWrite()`，不能用 `loadSettings()`**。
  `loadSettings` 的返回值已与内置清单合并，整份写回会把用户从未启用过的内置模型物化进配置文件（实测 profile 数 9 → 10）。
  `loadGlobalSettingsForWrite()` 在文件不存在时使用不含内置 profile 的 `createUserSettingsSkeleton()`，文件损坏或非法时中止写入；`readRawGlobalSettings()` 仅用于迁移等允许自行处理缺失/非法状态的只读流程。
- `migrateBuiltinCatalog()` 是纯函数，只做三件事：**重定向**旧 id（密钥一并带过去，绝不丢）、**同步**已存 profile 的目录字段（`apiKey` 原样保留）、
  **重映射** `defaultModel` / `modelRouting` 里的旧引用。它**刻意不新增**内置 profile —— 内置模型由代码侧提供，写进用户文件只会得到一份过期的快照。

## 标识资源（assets/）

- **单一真源 `assets/capybara.svg`**（贴纸风头像，640×600）。`logo / logo-dark / icon / logo-sign` 四个 SVG 由 `.workbuddy/build-assets.py` 从它派生，`.workbuddy/render.sh` 用 headless Chrome 出 PNG（`.workbuddy/` 已 gitignore，生成脚本不入库）。**改造型只改真源再重跑两个脚本，不要直接改派生文件。**
- 造型铁律：口鼻必须是"上窄下宽"的钝形深色块（水豚最关键辨识特征）；不要大面积奶油色口鼻斑（会读成泰迪熊）；头不要撑满画面（会读成河马）。
- README 抬头 `<picture>` + `prefers-color-scheme` 双主题（dark 版仅字标换暖白 `#F0E4D6`）；tagline 固定：**心如止水，稳定如初 —— AI Agent Harness**。

## 当前状态（2026-09-26）

- 版本号采用十进制位进位：补丁位只使用 `0–9`，`v0.0.9` 之后为 `v0.1.0`（不使用 `v0.0.10`）；后续同理。
- v0.0.1 既有能力与后续路线图见 `docs/RELEASES.md`，不在规则文件重复维护能力清单。
- 工作区版本为 v0.0.2：默认结构化运行日志与逐工具审计、四态权限、结构化工具错误、多层项目指令、默认注册的跨平台 `run_command` 已实现。接入与执行边界见 `docs/migration/v0.0.2.md`；版本是否发布以 GitHub Release 和 npm registry 为准。
- 本机 Windows 构建与验证通过：**38 test files / 284 passed | 3 skipped**；Linux/WSL 隔离副本 **287 passed**，Git Bash 真实命令验收 **21 passed**。远端 CI 发布门禁见 `openspec/changes/v0-0-2-trusted-execution/tasks.md` 第 7.3 项；不要把本地验证当作发布完成。
- v0.0.3 前置待办：在压缩历史前定义**失败轮次、连续同角色消息与完整工具事务**的 canonical 规范化规则；当前 OpenAI 兼容 Provider 已在 wire 层合并连续 user 并跳过空 assistant。v0.0.4 Anthropic 原生 Provider 必须消费该合法序列。
