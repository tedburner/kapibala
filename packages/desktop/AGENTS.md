# AGENTS.md — `@kiturone/kapibala-desktop` 桌面端约束

- **分层准入（`pnpm check-desktop` 拦截）**：`renderer` / `shared` / `preload` 只允许导入 `@kiturone/kapibala-host/view-model`（禁 Node 内置模块、禁直接依赖 `core`/`cli`/`electron`）；`agent-host` 只允许 `@kiturone/kapibala-host/{host,view-model,internal}` 与 `@kiturone/kapibala-cli/commands`（唯一 CLI 反向依赖例外）；`main` 禁引入任何 `@kiturone/*` 执行域模块。桌面专项门禁为 `pnpm verify:desktop`。
- **UI 2.0 零外部组件库与硬架构门禁（`pnpm check-desktop` 强制拦截）**：`@cloudflare/kumo` 已彻底退役，渲染层统一复用 `src/renderer/ui/` 自建原生原语（`<dialog>`、`popover="auto"`、语义化原生表单控件），图标唯一入口为 `src/renderer/ui/icon.tsx`（`src/renderer/surfaces/**` 禁止直接导入 `@phosphor-icons/react`）。强制红线：① `src/renderer/` 下任意 `.ts`/`.tsx` 单文件严格 `≤ 450` 行；② 颜色只走 `src/renderer/styles/tokens.css`（`--kpbl-*`）语义变量（禁源码与组件 CSS 硬编码 `#hex` / `rgb()` / `hsl()` / `oklch()`）；③ 禁止 `transition-all`、`@keyframes`、`!important`、`dangerouslySetInnerHTML` 与 `localStorage`/`sessionStorage`；④ `node-pty` 仅在 `agent-host` 惰性 `import()` 并配置 `asarUnpack`，`@xterm/*` 仅在 `TerminalTab` 按需动态加载。规范详见 `docs/design/017-ui-v2-workbench.md` 与 `docs/design/018-v0.1.6-version-design.md`。
- **UI 可访问名与文案是桌面 e2e 的选择器契约**：改 `aria-label` / 按钮文案必须同步
  `packages/desktop/e2e`（`getByRole(name)` 精确匹配），否则 CI 在 click/断言处 30s 超时。
  v0.1.3 设置页「关闭设置」→「返回应用」踩中过一次；新增命令（如 `/delegate`）也要检查
  命令补全用例的输入前缀是否产生歧义。
- **进程启动环境必须显式构造，禁止全量继承 `process.env`**：宿主（IDE / 沙箱包装器）会注入
  `NODE_OPTIONS=--require=<vendor shim>` 与 `ELECTRON_RUN_AS_NODE=1`，前者把宿主的原生模块塞进
  Electron 主进程（GPU 进程反复崩溃直至 SIGTRAP），后者让 GUI 二进制退化成纯 Node（启动即报
  `does not provide an export named 'BrowserWindow'`）。启动 Electron 走
  `packages/desktop/scripts/launch-env.mjs` 的 `desktopLaunchEnv()` 白名单（不枚举黑名单，天然免疫
  未来新增的注入变量）；运行构建工具链走 `scripts/process-env.mjs` 的 `toolchainEnv()` 过滤
  （只摘外部预加载钩子，保留 `--max-old-space-size` 与 HOME）。`pnpm check-desktop` 会拦截
  `env: { ...process.env }` 与缺省用白名单的桌面启动脚本。
