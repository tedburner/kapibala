# AGENTS.md — Kapibala Agent 工作约定

## 定位与跨包边界

- Kapibala（CLI 命令 `kpbl`）：从零构建的 TypeScript AI Agent Harness + 交互式 CLI。
- pnpm monorepo：`packages/core`（`@kiturone/kapibala`，运行时 0 依赖，保持 Headless 禁读写终端与 `process.cwd()`）+ `packages/host`（`@kiturone/kapibala-host`，私有可复用宿主层，不进 npm 发布集；协议/视图模型/传输/客户端/装配唯一真源，CLI 同名子路径仅做兼容转发 barrel）+ `packages/cli`（bin: `kpbl`）+ `packages/desktop`（Electron 桌面端）。各子目录细则由对应 `AGENTS.md` 按需自动加载。
- 设计基线：`docs/design/001-agent-framework-design.md`（**用户本人维护，勿擅改章节编号与交叉引用**）。

## 开发与验证门禁

- **一键入口：`pnpm dev`**（= `node scripts/dev.mjs`，跨平台唯一真源；`scripts/dev.sh` 与 `scripts/dev.cmd` 仅薄壳转发）：按需装依赖 → 工作区链接自愈 → 编译 → 校验 → 启动 REPL。只构建校验不启动用 `pnpm dev:build`；更多参数查 `node scripts/dev.mjs --help`。
- `pnpm dev:cli` 是 `tsup --watch`，**只监听重建、不启动 REPL**；启动请用 `pnpm dev` 或 `node packages/cli/dist/bin.js`。
- **完成门禁：`pnpm verify`**（= `typecheck → test → lint`，`--verify-only` 必须与之同源，防静默漏掉 lint 与密钥扫描）。注意 tsup/esbuild 不做类型检查，`pnpm build` 绿 ≠ 类型通过；`pnpm test` 自带前置构建以保鲜桌面集成测试依赖的 dist 制品。桌面改动额外跑 `pnpm verify:desktop`。
- 密钥扫描 `pnpm check-secrets` 已并入 lint 流程，严禁提交真实 API Key。
- 根构建入口 `pnpm build` / `build:desktop` / `dev:desktop` 分别是 `scripts/build.mjs` 与 `scripts/dev-desktop.mjs`，它们在清洗过的环境里再拉起下一层命令 —— 否则宿主删除守卫会把打包器清理 dist 当成批量删除拦下（报错指向无关的 `.js.map`，看起来像打包器坏了）。

### 已知环境坑（Windows 与宿主进程）

- **workspace 软链会退化成空目录**：本机 pnpm 为 workspace 依赖（如 `@kiturone/kapibala`）创建链接时「成功」返回，但产物是空目录而非真实链接，运行时表现为 `ERR_MODULE_NOT_FOUND`。普通（非 workspace）依赖不受影响；**跑一次 `pnpm dev` 即可用 junction 自愈**（无需管理员权限）。
- **`.cmd` 必须保持纯 ASCII**：cmd.exe 在 `chcp` 生效前按 OEM 代码页（zh-CN 下为 GBK）解析文件，任何非 ASCII 字节都会破坏语法。
- ⚠️ **Windows 项目路径身份统一走 `fs.realpathSync.native`**：JS `realpathSync` 保留 8.3 短名，与 `normalizeProjectPath` 的长路径信任身份失配（v0.0.4 指令目录、v0.0.5 项目信任各踩中一次）。新增任何与信任/项目根比较的路径解析都必须用 native 语义。
- **子进程环境禁全量继承 `process.env`**：宿主会注入 `NODE_OPTIONS` 与 `ELECTRON_RUN_AS_NODE=1` 导致 Electron 崩溃或退化为纯 Node；启动 Electron 走 `desktopLaunchEnv()` 白名单，运行工具链走 `toolchainEnv()` 过滤（详见 `packages/desktop/AGENTS.md` 与 `scripts/AGENTS.md`）。

## 提交、分支与发布红线

- **不自动 git add / commit**，改动保留在工作区由用户审核后手动提交。
- **版本分支开发（2026-11-16 起的约定）**：**一个版本一个分支，分支命名固定 `v<版本号>`**（如 `v0.1.3`）；该版本的所有需求默认都在对应版本分支上开发，**不按单个需求切分支**，除非用户明确要求新开分支。建分支用 `pnpm flow branch v<版本号>`；`pnpm flow feat <topic>`（支持 `fix` / `chore` / `docs`，topic 省略时自动生成「日期-时分」名）仅在用户明确要求按需求切分支时使用。合并回主干用 `git merge --no-ff v<版本号>`，main 始终保持可发布。
- **发布统一走 `pnpm release [version]`**（= `pnpm flow release`）：要求在 main 且工作区干净、不落后远端。默认仅递增补丁段（2026-10-21 约定：`0.0.9 → 0.0.10`，不逢十自动向次版本进位），次版本/主版本由显式参数选择；同步七处版本号（根、Core、MCP、CLI、host、desktop 的 6 个 package.json + `CLI_VERSION`）、跑 `pnpm verify`，**交互确认后**创建发布提交（`:bookmark: 发布 v<版本号>`，内容仅限版本号与既有发布文档，是「不自动 commit」约定的唯一例外）与附注标签。发布说明须先写好 `docs/releases/v<版本号>.md`（缺失时 `pnpm flow release --scaffold` 生成骨架，补全后手动提交）；执行发布或排障重试前读 `docs/releases/publishing.md`。
- **推送永远手动**：先 `git push origin main` 并等 main 的 Verify 工作流通过，再 `git push origin refs/tags/v<版本号>`（提前暴露门禁失败，避免移动已推送的标签；因版本分支与标签同名，须显式带 `refs/tags/` 消除 refspec 歧义）；tag 推送触发 Actions（verify → npm trusted publishing → GitHub Release）。
- **发布门禁分两层**：自动门禁（`pnpm verify` + `verify` 工作流全矩阵 + PR soak 冒烟 10 轮 + 三包 registry 安装 smoke）始终强制；release/nightly 档长跑自 2026-11-20 起退出发布路径，仅由 Soak 工作流定时或手动运行并归档证据，不再阻断发布；人工验收证据（`pnpm verify:release-evidence` 的六类专项与桌面专项）自 2026-11-14 起**默认跳过**，工作流只打印 warning，`KPBL_RELEASE_STRICT=true` 即恢复同 SHA 审核清单强制校验。桌面附件默认不附带，`KPBL_DESKTOP_RELEASE=true` 恢复严格附件流程。跳过不等于通过：文档与 Release 不得宣称人工专项、签名或跨平台安装验收已完成，禁止伪造通过证据。口径见 `docs/release-evidence.md` 与 `docs/desktop-release.md`。

## 编码约定

- **注释约定（强制，禁「复述腔」）**：所有导出符号（class / function / interface / type / const / enum）、重要公开方法、易误解字段与复杂私有逻辑块必须随实现同步配简体中文 JSDoc，写清**前置约束、失败边界与设计取舍**；改行为必同步改注释（注释与代码语义不符按 bug 处理），禁止引用 review/PR/日期。
  - **NO**：`/** 更新模型 API 密钥。 */`
  - **OK**：`/** 写入模型密钥并清理同 credentialGroup 冗余副本；原始全局配置损坏时抛错中止，防回写合并结果物化内置模型。 */`
- 品牌拼写只允许 **`Kapibala`**（禁止少一个 i 的旧拼法）；配置目录 **`.kapibala`**；错误基类 `KapibalaError`；默认 `agentName` 为 `'Kapibala'`。

## 按需阅读索引（触发对应任务时必读）

- **当前基线与版本路线图**：当前最新已发布版本为 `v0.1.4`（本地 wire `PROTOCOL_VERSION = 2`）；查历史版本交付范围或后续排期时读 `docs/RELEASES.md`，开发 `v0.1.5` 第三方 ACP 接入时读 `docs/design/015-v0.1.5-acp-external-harness.md`。
- **契约与子系统文档**：改 Core/MCP/CLI 公共导出时读 `docs/sdk-compatibility.md` 与 `scripts/fixtures/public-api/migration.json`；改本地客户端协议时读 `docs/local-protocol.md`；改技能体系时读 `docs/skills.md`。
- **跨包高危联动**：从任意包修改内置模型目录、厂商元数据、API Key 读写或全局配置持久化前，必读 `packages/host/AGENTS.md`；修改品牌 SVG/PNG 或 README 双主题抬头图前，必读 `assets/AGENTS.md`。
