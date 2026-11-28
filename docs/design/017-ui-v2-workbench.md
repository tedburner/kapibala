# 017 · Kapibala UI 2.0 工作台架构与重构规范（墨工坊 Ink Atelier）

> **状态**：**已全量落地**（2026-11-26 定稿，2026-11-28 在 `v0.1.6` 分支完成五阶段全量实施与门禁收口）。
> **边界与继承**：完整保留 [004 桌面宿主设计](004-v0.1.0-desktop-harness.md) 的四进程安全隔离（`main` / `preload` / `agent-host` / `shared`、`contextIsolation: true`、`sandbox: true`、`kpbl-preview://` 独立源沙箱、`desktopLaunchEnv()` 环境白名单）与 `@kiturone/kapibala-host/view-model` 共享纯展示契约；**推翻重塑 `packages/desktop/src/renderer/` 全量视图、样式、组件与状态层**，同步对齐 `packages/cli/src/ui/` 终端主题出口，并在收口阶段彻底卸载 `@cloudflare/kumo`。
> **承接关系**：自 `v0.1.6` 起取代 [006 桌面视觉精修](006-desktop-visual-refinement.md) 的单抽屉骨架、Kumo 桥接变量、全屏模态审批与全屏模态设置；直接作为 [RELEASES.md](../RELEASES.md) 中 `v0.1.6`（并排多标签右侧工作台、Git Worktree 并行隔离、Shadow Git 检查点 Diff、桌面委派可见化、`@` 跨会话引用弹层、模型请求自动重试）与 `v0.1.7`（多模态输入托盘、缓存计费看板、三级权限规则页）的统一界面底座。

---

## 0. 一句话定义与五条宪法级设计铁律

Kapibala UI 2.0（代号 **「墨工坊 Ink Atelier」**）= **「思考时安静如纸，动手时展开如精密仪器」的多代理编码工作台**。当设计或实现细节出现取舍冲突时，严格按以下五条铁律顺序裁决：

1. **双态自适应舞台（Calm Reading ⇄ Split Engineering）**：纯对话推理时保持 `760px` 居中无干扰阅读轴；一旦检视变更 Diff、HTML/SVG/图片产物、工作区文件、运行证据或会话终端，右侧无缝推开**可调宽多标签工作台（Workbench Stage）**，对话列自动左移自适应，废除遮挡视线的窄抽屉。
2. **单一会话流协议（One Stream, Any Harness）**：自研 Core 会话、本地 `/delegate` 委派子会话，以及 13+ 种外部代理会话（`acp` / `claude-cli` / `codex-app-server` / `pi-rpc`）经 `UnifiedThread` 适配层归一，**100% 共用同一套单行页头、轮次流、工具执行组、内联审批卡与全能输入坞**；差异仅由「代理身份胶囊」与能力位驱动。
3. **就地非阻断交互 + 壳内整页设置（Inline Dock & In-Shell Settings）**：工具审批、子代理冒泡审批、任务进度、监视状态、自动重试与阻断提示全部收敛进底部**全能输入坞（Composer Dock）**就地处理；设置与外部代理中心改为**壳内主舞台整页视图（In-Shell View）**，彻底消灭「弹窗套弹窗」。原生模态 `<dialog>` 仅限三类场景：**破坏性确认、目录信任授权、`⌘K` 全局命令面板**（及设置页内部单层新建/编辑子表单）。
4. **宣石暖纸 / 曜石墨 + 碳素主控 + 水豚琥珀脉搏（`≤ 5%`）**：常规控件（主按钮、开启态开关、激活项）一律采用高对比碳素墨色，**零蓝色/多色控件噪音**；全界面唯一暖色「水豚琥珀（Capybara Amber）」严格限制在 `≤ 5%` 面积，专供**运行中心跳点、待人工审批呼吸灯与品牌插画时刻**。
5. **零外部样式库自治（Zero-Kumo Native Primitives）**：依托 Electron 45（Chromium 156）原生 `<dialog>`、`[popover]`、CSS `@layer` 与 `light-dark()` 自建 `src/renderer/ui/` 20 个纯净原语组件；渲染层单文件硬上限 **`≤ 450` 行**，源码 `0` 处 `!important`（`prefers-reduced-motion` 总闸除外）、`0` 处硬编码色值。

---

## 1. 现状量化诊断与推翻依据

`004` 与 `006` 面向 `v0.1.0` 单会话聊天形态设计，演进至 `v0.1.5` 后已在四个工程维度触顶，局部修补收益为负：

| 维度 | `v0.1.5` 现状核实 | 推翻重构目标 |
|---|---|---|
| **空间骨架** | 右侧仅有 `360px` 单槽位 `DetailsDrawer`，工具详情、证据看板、图片产物互斥抢位，无法容纳 `v0.1.6` 并排 Diff / 文件 / 预览 / 终端多标签工作台 | 可拖拽分栏双画布（`SplitPane`），右侧 `WorkbenchStage` 原生多标签按会话记忆 |
| **双轨视图分裂** | `App.tsx`（2,905 行）与 `external-session-view.tsx`（629 行）分裂为两套页头、消息流与审批交互（本地阻断模态暴露临时路径与 UUID，外部为内联卡片；侧栏外部标题被挤成单字母） | `unified-thread.ts` 归一投影 + 唯一 `SessionStage` 与内联 `ApprovalDeck` |
| **组件库反噬** | `@cloudflare/kumo` 强绑云后台样式：深色按钮写死 `!text-white` 逼出 `!important` 覆盖；`Switch` 硬刷亮蓝色；`LayerCard` 形成灰卡套白卡；`theme-kapibala.css` 堆积 **1,403 行 / 209 个选择器 / 14 种圆角值** | 卸载 `@cloudflare/kumo`；`styles/` 5 文件级联 + `ui/` 20 个原生原语；圆角收敛为 **5 档** |
| **状态与巨石文件** | 4 个巨石文件（`App` 2,905 + `settings-dialog` 2,609 + `message-list` 1,293 + `external-settings-panel` 1,106 = **7,913 行**）散落 46 个 `useState`；深色代码块普通标识符对比度失效 | 4 个 Zustand 领域 Store + 模块化 `surfaces/`（单文件 `≤ 450` 行）+ 双主题 Shiki 变量映射 |

---

## 2. 应用壳与响应式空间拓扑（App Shell）

### 2.1 顶层布局结构

```text
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ [● ● ●] 豚 Kapibala          [+] │ kapibala / 重构权限网关 [Claude·CLI] [⎇ wt/auth] [+42 -15] [分栏 ⌘J] [···] │
│ [⌕ 搜索会话或命令…          ⌘K] ├────────────────────────────────────────────┬───────────┤
│ ─────────────────────────────── │                                            │ [Diff] [Preview] [Files] [Terminal] [Inspector] [×] │
│ 运行收件箱 (仅活动时显示)        │                 [用户消息气泡]             ├───────────┤
│  ● 重构权限网关        [待审批] │                                            │           │
│  ● 核查 Windows 垫片    Codex   │  ▸ 思考过程 · 1.1s                         │  可调宽   │
│ ─────────────────────────────── │  ✓ 已执行 3 步文件与检查操作        840ms  │  多标签   │
│ 工作区                          │    ✓ 读取 packages/core/src/agent.ts  ↗    │  工作台   │
│  ▾ kapibala                   3 │    ✓ 编辑 packages/core/src/gate.ts +42 ↗  │           │
│    重构权限网关            刚刚 │                                            │  Diff /   │
│     ⎇ wt/auth · +42 -15         │  正文结论与双主题高对比代码块...           │  Preview /│
│    ↳ 补齐沙箱单测        ✓ 完成 │                                            │  Files /  │
│    评审 015 外部代理     2小时前 │ ░░░░░░░░░░░ 20px 底部渐隐遮罩 ░░░░░░░░░░░░ │  Terminal │
│  ▸ docs-site                  5 │  ┌─ ┃ 请求运行验证命令 [workspace-write] ┐ │  Inspector│
│                                 │  │ pnpm test gate   [拒绝] [本会话] [批准]│ │           │
│                                 │  └────────────────────────────────────────┘ │           │
│                                 │  ◎ 清单 2/3 · 跑回归   👁 :5173   14k (7%)  │           │
│ ─────────────────────────────── │  ┌─ Omni-Composer ────────────────────────┐ │           │
│ ⚙ 设置与代理                ⌘,  │  │ [Claude·Sonnet ▾] [✋ 变更前确认 ▾] [↑]│ │           │
└─────────────────────────────────┴──┴────────────────────────────────────────┴─┴───────────┘
  左栏 Navigation Rail (248 / 52)     左画布 Conversation Pane (min 420 / 居中 760)   右画布 Workbench (360 ~ 60%)
```

### 2.2 视口断点矩阵（四组基准窗口零横向滚动）

| 视口区间 | 左栏 `NavigationRail` | 主画布 `ConversationPane` | 右画布 `WorkbenchStage` |
|---|---|---|---|
| **`≥ 1280px`（桌面标准态）** | `248px` 常驻展开（`⌘B` 收起至 `52px` 图标轨） | 无右栏时 `max-width: 760px` 居中；开右栏时占剩余宽度（`min 440px`） | 并排推挤分栏，默认占主舞台 `45%`（可拖拽 `360px` 至 `60%`，双击分隔条复位） |
| **`1024px – 1279px`（紧凑横屏）** | 自动收起为 `52px` 图标轨；点击展开按钮或悬停触发 `248px` 浮层面板 | 弹性自适应（`min 420px`） | 并排推挤分栏（默认 `400px`） |
| **`800px – 1023px`（最小窗口门禁）** | `52px` 图标轨；展开态以带轻遮罩抽屉覆盖 | 独占主区宽度（`748px`），输入坞自适应不溢出 | 自动转为右侧覆盖浮层（`width: min(500px, 86vw)`，`Esc` 或遮罩点击关闭） |

### 2.3 全局键盘快捷键契约

| 快捷键（macOS / Win·Linux） | 行为 | 作用域 |
|---|---|---|
| `⌘K` / `Ctrl+K` | 打开全局命令面板（检索会话、启动外部代理、执行动作、跳转设置） | 全局 |
| `⌘,` / `Ctrl+,` | 切换「壳内设置与代理中心」与当前活跃会话视图 | 全局 |
| `⌘B` / `Ctrl+B` | 展开 / 收起左侧导航栏 | 全局 |
| `⌘J` / `Ctrl+J` | 展开 / 收起右侧多标签工作台（记住上次激活标签） | 会话舞台 |
| `⌘N` / `Ctrl+N` | 在当前活跃工作区进入新建对话启动台（Launchpad） | 全局 |
| `⌘1`..`⌘5` / `Ctrl+1`..`Ctrl+5` | 右侧工作台已展开时直接切换 `Diff / Preview / Files / Terminal / Inspector` 标签 | 会话舞台 |
| `Y` / `S` / `N`（焦点不在输入框时） | 当前会话顶层内联审批卡快捷「批准本次 / 本会话允许 / 拒绝」 | 待审批态 |
| `Esc` | 按栈顶优先级依次关闭：Popover/Menu → 命令面板/模态框 → 窄屏覆盖工作台 → 壳内设置返回会话 | 全局 |

---

## 3. 样式级联架构与三层设计令牌（CSS `@layer` & Tokens）

废除单文件 `theme-kapibala.css`，建立 `packages/desktop/src/renderer/styles/` 五文件体系，并在 `styles/index.css` 首行固定级联顺序：

```css
@import "tailwindcss";
@import "katex/dist/katex.min.css";

@layer reset, tokens, base, prose, shiki, primitives, workbench, utilities;
```

### 3.1 色彩语义令牌（`styles/tokens.css` 唯一真源）

根节点固定 `<meta name="color-scheme" content="light dark">`（首帧 `boot-theme.js` 按偏好写入 `:root[data-mode="light" | "dark"]` 并同步 `color-scheme: only light` / `only dark`），令牌层统一用原生 `light-dark()` 定义，禁止在业务组件出现任何 `#hex` / `rgb()` / `hsl()` / `oklch()` 字面量：

| 语义变量 | Light（宣石暖纸） | Dark（曜石墨） | 用途与硬约束 |
|---|---|---|---|
| `--kpbl-bg-rail` | `#F0EFEA` | `#111214` | 左栏导航底色；深色严禁退化为 `#000000` 纯黑 |
| `--kpbl-bg-canvas` | `#F7F6F3` | `#15171A` | 右侧工作台底色、壳内设置底色、代码块与内嵌详情底色 |
| `--kpbl-bg-surface` | `#FFFFFF` | `#1A1D21` | 主对话阅读面、设置分组列表面、工作台内容面板 |
| `--kpbl-bg-elevated` | `#FFFFFF` | `#22262C` | Omni-Composer 卡、内联审批卡、菜单 Popover、模态 `<dialog>` |
| `--kpbl-bg-subtle` | `color-mix(in oklab, #181816 4.8%, transparent)` | `color-mix(in oklab, #F4F3EE 6%, transparent)` | 用户消息气泡、行内代码胶囊、悬停底、次级胶囊 |
| `--kpbl-bg-active` | `color-mix(in oklab, #181816 8.5%, transparent)` | `color-mix(in oklab, #F4F3EE 10.5%, transparent)` | 左栏当前会话选中底、分段控制器与工作台激活标签底 |
| `--kpbl-ink-strong` | `#141413` | `#F4F3EE` | 标题、关键数值、选中项文案（对比度 `> 14:1`） |
| `--kpbl-ink-default` | `#262523` | `#E2E0DA` | 对话正文、常规按钮与表单输入文案（对比度 `> 11:1`） |
| `--kpbl-ink-subtle` | `#66645E` | `#96948D` | 思考摘要、工具行描述、表单辅助说明（对比度 `≥ 4.8:1`） |
| `--kpbl-ink-faint` | `#949189` | `#66645E` | 相对时间、Token 统计、代码块行号、禁用态文案 |
| `--kpbl-control-solid` | `#181816` | `#ECEAE4` | Primary 主按钮、**开启态 `Switch`**、圆形发送钮（彻底消灭蓝色控件） |
| `--kpbl-control-on-solid` | `#FFFFFF` | `#141413` | `control-solid` 上的反转文字与图标 |
| `--kpbl-pulse` | `#C26B33` | `#E58B52` | **水豚琥珀脉搏**：仅用于运行中心跳点、待审批状态与活跃环（占比 `≤ 5%`） |
| `--kpbl-pulse-soft` | `color-mix(in oklab, #C26B33 12%, transparent)` | `color-mix(in oklab, #E58B52 16%, transparent)` | 待审批胶囊柔光底 |
| `--kpbl-line-subtle` | `color-mix(in oklab, #181816 7.5%, transparent)` | `color-mix(in oklab, #F4F3EE 7.5%, transparent)` | 栏间分隔线、列表行内分隔、代码块顶栏下沿 |
| `--kpbl-line-default` | `color-mix(in oklab, #181816 13%, transparent)` | `color-mix(in oklab, #F4F3EE 13%, transparent)` | 卡片、输入框、次级按钮、设置分组外框 |
| `--kpbl-line-strong` | `color-mix(in oklab, #181816 28%, transparent)` | `color-mix(in oklab, #F4F3EE 28%, transparent)` | `:focus-visible` 2px 焦点环、输入坞聚焦态外框 |
| `--kpbl-status-success` | `#16794B` | `#4CC38A` | 工具成功、探针就绪、Diff 新增行文本 |
| `--kpbl-status-success-soft` | `color-mix(in oklab, #16794B 10%, transparent)` | `color-mix(in oklab, #4CC38A 13%, transparent)` | Diff 新增行底色与成功胶囊底 |
| `--kpbl-status-warning` | `#B45309` | `#F0B35C` | 自动重试退避、只读历史归档提示、已取消任务 |
| `--kpbl-status-danger` | `#C92A2A` | `#FF7B72` | 工具失败、高危命令标签、危险删除按钮、Diff 删除行文本 |
| `--kpbl-status-danger-soft` | `color-mix(in oklab, #C92A2A 10%, transparent)` | `color-mix(in oklab, #FF7B72 13%, transparent)` | Diff 删除行底色与错误横幅底 |
| `--kpbl-status-info` | `#2B6CB0` | `#79C0FF` | Git Worktree 分支胶囊、跨会话引用溯源标记 |

### 3.2 双主题代码高亮令牌（`styles/shiki.css`）

`@streamdown/code` 与工作台 `Files` / `Diff` 视图统一绑定 CSS 变量语法主题，根治深色模式下默认标识符与深色底同色不可读缺陷：

| 语法令牌 | Light 值 | Dark 值 | 覆盖范围 |
|---|---|---|---|
| `--kpbl-code-fg` | `#262523` | `#E2E0DA` | 默认标识符、变量、括号与运算符（对比度 `> 11:1`） |
| `--kpbl-code-keyword` | `#9E2A8B` | `#D2A8FF` | 控制流与声明关键字 |
| `--kpbl-code-function` | `#235A9F` | `#79C0FF` | 函数与方法调用 |
| `--kpbl-code-string` | `#156E43` | `#7EE787` | 字符串与模板字面量 |
| `--kpbl-code-type` | `#9A5612` | `#FFA657` | 类型、接口、类名与枚举 |
| `--kpbl-code-number` | `#1E6B7B` | `#A5D6FF` | 数值、常量与布尔字面量 |
| `--kpbl-code-comment` | `#7A776E` | `#8B8982` | 注释（斜体禁用，保证中文注释清晰度，对比度 `≥ 4.5:1`） |

### 3.3 形状、字阶、高度与动效标尺

- **圆角严格 5 档**：`--kpbl-r-xs: 4px`（行内代码/`kbd`）、`--kpbl-r-sm: 6px`（按钮/输入框/导航行/胶囊）、`--kpbl-r-md: 10px`（代码块/内联审批卡/Popover/设置分组框）、`--kpbl-r-lg: 14px`（Omni-Composer 输入卡/模态 `<dialog>`）、`--kpbl-r-full: 9999px`（状态圆点/圆形发送钮/Switch 轨道）。
- **字阶严格 6 档**：`11px`（快捷键/徽标）· `12px`（标签栏/元信息/表格头）· `13px`（左栏行/工具行/按钮/状态条）· `14px`（设置与表单正文）· `15px`（对话阅读流，行高 `1.72`）· `18px`（设置页与模态框一级标题）；仅 Launchpad 空态主问候允许 `20px`。所有数字统计列强制 `font-variant-numeric: tabular-nums`。
- **控件高度 4 档**：`24px`（紧凑胶囊钮）· `28px`（页头/输入坞工具栏按钮）· `32px`（左栏行/标准按钮）· `36px`（单行文本输入框）。
- **间距网格**：`4 / 8 / 12 / 16 / 20 / 24 / 32px`。用户消息气泡至下方助手过程层固定 `14px`；轮次之间固定 `28px`。
- **动效纪律**：仅允许显式属性过渡（`120ms` 悬停/按压，`180ms` 面板开合，`cubic-bezier(0.2, 0, 0, 1)`）；禁止 `transition: all`；`@media (prefers-reduced-motion: reduce)` 下所有过渡与脉冲动画归零。

---

## 4. 零外部样式库原语层（`src/renderer/ui/`）

所有业务视图（`surfaces/*`）只允许从 `src/renderer/ui/` 导入基础控件。组件全部基于 Chromium 156 原生语义元素构建：

| 模块文件 | 导出组件 | 核心 DOM / ARIA 与平台特性契约 |
|---|---|---|
| `button.tsx` | `Button`, `IconButton` | 原生 `<button type="button">`；`variant: 'solid' \| 'outline' \| 'ghost' \| 'danger'`，`size: 'xs' \| 'sm' \| 'md'`；`IconButton` 强制要求必填 `aria-label: string`（类型层拦截无名图标钮） |
| `fields.tsx` | `TextField`, `TextArea`, `SearchField`, `SecretField` | 原生 `<input>` / `<textarea>`；内置 `id` 与 `<label>` / `aria-describedby` 自动关联；`SecretField` 支持显隐切换与已配置凭证占位提示 |
| `switch.tsx` | `Switch` | `<button type="button" role="switch" aria-checked={checked}>`；开启态使用 `--kpbl-control-solid` 碳素墨轨道，彻底替代蓝色开关 |
| `segmented.tsx` | `Segmented` | 单选分段控件（用于外观主题切换、Diff 视图 Unified/Split 切换） |
| `dialog.tsx` | `ModalDialog` | 封装原生 `<dialog>` + `ref.showModal()` + `closedby` 属性；**不手动添加冗余 `role="dialog"` / `aria-modal`**；配齐 `dialog:modal` 与 `dialog::backdrop` 的 `overscroll-behavior: contain`；破坏性确认默认 `autofocus` 落在「取消」安全按钮 |
| `popover.tsx` | `AnchoredPopover`, `ActionMenu` | 封装原生 `popover="auto"` + `useId()` 显式 `--anchor-*` 锚点定位（`position-area` + `position-try-fallbacks: flip-block, flip-inline` 边缘自动翻转）；`ActionMenu` 实现完整 `role="menu"` 上下方向键、Home/End 与首字母焦点巡航，纯按钮组弹层则不滥标 `role="menu"` |
| `select.tsx` | `Select`, `Combobox` | 基于 `AnchoredPopover` 构建的可搜索下拉选择器（承载模型/代理双栏选择、场景路由选择） |
| `badges.tsx` | `Badge`, `HarnessBadge`, `StatusDot`, `Kbd` | `StatusDot` 内置状态词无障碍文本，绝不仅靠颜色表达状态；`HarnessBadge` 统一渲染本地/外部代理身份胶囊 |
| `truncate.tsx` | `MiddleTruncate` | 针对文件路径与长命令保留首段与末尾文件名，溢出时挂载原生延迟 `Tooltip` 展示完整字符串 |
| `split-pane.tsx` | `SplitPane` | 主舞台左右分栏容器：支持指针拖拽（`setPointerCapture`）、键盘左右方向键微调（`role="separator" aria-valuenow`）与双击复位 |
| `settings-kit.tsx` | `SettingSection`, `SettingRow`, `EmptyState` | 单层细框分组与左文右控标准行，从结构上禁止「卡片套卡片」 |
| `toast.tsx` | `ToastViewport` | 右上角非模态轻量通知栈（`error` 走 `role="alert"`，其余走 `role="status"`，按通知 `id` 独立计时收起） |
| `icon.tsx` | `Icon`, `BrandMark` | 全应用 UI 图标唯一出口：封装 `@phosphor-icons/react`（默认 `16px` `regular`）；`BrandMark` 仅用于 Win/Linux 左栏顶带、Launchpad 与关于页，移除普通导航按钮上的常驻 `rAF` 动态图标引擎 |
| `activity-glyph.tsx`（含 `activity-glyph-frames.ts` / `activity-glyph-clock.ts`） | `AgentActivityGlyph`, `resolveToolActivityKind` | 8 态 SVG 墨线智能体运行微动效原语（`thinking / reading / searching / writing / checking / sending / on_hold / waiting`）：消费 `--kpbl-ink-faint` 静默轨道与 `--kpbl-pulse` 焦点；全局单时钟按需驱动，空闲/隐藏标签页 0 CPU，`prefers-reduced-motion: reduce` 渲染清晰静帧，零 CSS `@keyframes` |

---

## 5. 状态分层与会话归一架构（Stores & Adapter）

### 5.1 Zustand 四域切片（`src/renderer/stores/`）

严守「Host / Main 是业务与持久事实唯一真源，Renderer Store 仅管易失 UI 状态与 Host 快照镜像」原则，拆解原 `App.tsx` 与 `settings-dialog.tsx` 的 46 个散落状态：

1. **`shell-store.ts`**：管理 `activeSurface: 'workspace' | 'settings'`、`settingsTab`、`railOpen`、`commandPaletteOpen`、按 `sessionKey` 索引的右侧工作台状态 `{ open: boolean; widthRatio: number; tabs: WorkbenchTab[]; activeTabId: string }`，并在会话关闭、归档或删除时通过 `clearSessionWorkbench(sessionKey)`（联动 `clearSessionTerminals(sessionKey)`）主动清理易失缓存防无界增长。
2. **`workspace-store.ts`**：同步 `spaces`、各空间历史会话分页、`runtime` 快照与 `external.list` 清单；提供派生选择器 `selectInboxItems()`（聚合全空间待审批、运行中、监视触发项）。
3. **`session-store.ts`**：封装 `ViewClient` 与 `external.*` IPC 订阅，管理当前打开会话句柄、按 `sessionKey` 隔离的输入框草稿/附件/引用快照与滚动跟随位置。
4. **`settings-store.ts`**：管理桌面本地常规偏好（`themeMode: 'system' | 'light' | 'dark'`、`localePreference: 'system' | 'zh-CN' | 'en'`、`resolvedLocale: 'zh-CN' | 'en'`、`typography` 字体/字号/连字配置、`general` 发送快捷键/时间格式/折行/桌面通知开关，以及删除/归档/关终端确认开关 `confirmations`）、`settings.read` 模型目录、`external.harnesses` 列表与探针状态、MCP/技能诊断与跨工具导入状态、版本更新下载状态。

### 5.2 本地与外部会话统一投影（`src/renderer/adapters/unified-thread.ts`）

将本地 Core 会话（`Opened` + `ViewState`）与外部代理会话（`ExternalSessionSnapshot`）映射为单一 `UnifiedThreadViewModel`，消除两套会话组件树：

```ts
/** 归一后的会话来源身份；决定页头胶囊文案与输入坞暴露的控制项能力。 */
export interface ThreadHarnessIdentity {
  readonly kind: 'native' | 'external';
  readonly id: string;
  readonly label: string;
  readonly transportLabel?: 'ACP' | 'CLI' | 'App-Server' | 'RPC';
  readonly resumable: boolean;
  readonly worktreeBranch?: string;
}

/** 本地与外部代理共用的内联审批单展示结构；底层协议响应由 session-store 按 kind 分发。 */
export interface UnifiedApprovalItem {
  readonly id: string;
  readonly source: 'native' | 'delegation' | 'external';
  readonly title: string;
  readonly riskLabel?: string;
  readonly summaryCode: string;
  readonly relativeCwd?: string;
  readonly expiresAt?: number;
  readonly actions: readonly {
    readonly id: string;
    readonly label: string;
    readonly intent: 'primary' | 'secondary' | 'danger';
    readonly shortcutHint?: 'Y' | 'S' | 'N';
  }[];
  /** 原始绝对路径、会话/运行 ID 与完整 JSON 参数仅在点击「环境详情」时送入右侧 Inspector。 */
  readonly inspectorPayload: Readonly<Record<string, unknown>>;
}

/** 驱动 SessionStage、ComposerDock 与 WorkbenchStage 的唯一只读视图模型。 */
export interface UnifiedThreadViewModel {
  readonly sessionKey: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly title: string;
  readonly phase: 'idle' | 'starting' | 'running' | 'waiting_approval' | 'cancelling' | 'failed' | 'ended';
  readonly harness: ThreadHarnessIdentity;
  readonly turns: readonly UnifiedTurn[];
  readonly approvals: readonly UnifiedApprovalItem[];
  readonly todos?: ViewTodoState;
  readonly activeWatchesCount: number;
  readonly diffSummary?: { readonly additions: number; readonly deletions: number };
  readonly evidence?: ViewEvidence;
  readonly capabilities: {
    readonly canSwitchRole: boolean;
    readonly canSwitchPermissionMode: boolean;
    readonly canForkOrCheckpoint: boolean;
    readonly externalConfigCategories: readonly ViewExternalConfigCategory[];
  };
}
```

### 5.3 桌面端常规偏好、动态字体排版与零依赖双语架构（`preferences.ts` & `src/shared/i18n/` · 2026-11-27 增补）

为支持桌面客户端「常规（General）」页的主题、中英文（`zh-CN` / `en`）、字体与字号及高频交互偏好无刷新实时生效，同时严守零外部 UI/i18n 依赖、四视口（最小 `800×600`）零溢出与 E2E 选择器稳定契约，采用以下统一设计：

1. **词典真源与编译期对齐**：
   - 位于 `packages/desktop/src/shared/i18n/{types.ts,zh-CN.ts,en.ts,index.ts}`（主进程菜单/托盘/通知与渲染进程全界面共用，零 Node 内置依赖）。
   - 以 `zh-CN.ts` 的键集合推导 `TranslationKey` 类型，`en.ts` 显式声明 `satisfies Record<TranslationKey, string>`，任何新增词条若漏翻英文在 `pnpm typecheck` 阶段直接报错拦截；提供轻量 `t(key, params?)` 纯函数与渲染层 `useI18n()` Hook。
2. **本地常规偏好持久化契约（`desktop-state.json`）**：
   - 仅作用域桌面客户端（CLI `kpbl` 保持终端自身配置不耦合，不污染 `~/.kapibala/settings.json`），在主进程 `Preferences`（`packages/desktop/src/main/preferences.ts`）通过 Zod `.default()` 无损扩展：
     - `locale: 'system' | 'zh-CN' | 'en'`（默认 `'system'`；`locale === 'system'` 时按 `app.getLocale()` / `navigator.language` 将 `zh*` 映射为 `'zh-CN'`，其余映射为 `'en'`；**`KPBL_DESKTOP_E2E=1` 且未显式指定语言时固定回退 `'zh-CN'`**，保障全量既有中文 E2E 在英文 CI Runner 上零回归绿灯）；
     - `typography`（字体与字号）：
       - `uiFontFamily: string`（默认 `'system'`；可选预设或自定义本机无衬线字体名，经 CSS 字体名转义后前置拼入 `:root` `--kpbl-font-sans` 回退栈）；
       - `codeFontFamily: string`（默认 `'system'`；内置 `系统等宽`、`JetBrains Mono`、`Cascadia Mono`、`Fira Code`、`SF Mono` 预设及自定义本机等宽字体输入，统一驱动 `:root` `--kpbl-font-mono`、Streamdown/Shiki 代码块、`FilesTab` / `DiffTab` 与 `@xterm/xterm` `fontFamily`）；
       - `chatFontSize: number`（默认 `15`，整数受控范围 `13..18` px，驱动 `:root` `--kpbl-text-prose` 并按差值联动代码块字号；左栏导航与顶栏结构字阶固定 `11–13px` 不随正文放大，确保 `800×600` 最小窗口门禁永不横向溢出）；
       - `terminalFontSize: number`（默认 `13`，整数受控范围 `11..18` px，实时同步右侧工作台 `@xterm/xterm` `options.fontSize` 并触发 `FitAddon.fit()` 重算终端行列）；
       - `codeLigatures: boolean`（默认 `false`，切换 `html[data-code-ligatures]` 控制代码块与差异视图 `font-variant-ligatures: contextual / none`）。
     - `general`（显示与交互常规项）：
       - `timeFormat: 'system' | 'relative' | '24h' | '12h'`（默认 `'relative'`，对标 T3 Code「时间格式」，统一左栏尾槽与消息时间戳渲染）；
       - `sendShortcut: 'enter' | 'mod-enter'`（默认 `'enter'`：`Enter` 发送 / `Shift+Enter` 换行；`'mod-enter'` 下 `⌘/Ctrl+Enter` 发送、`Enter` 换行，IME `isComposing` 选词期间始终拦截防误发）；
       - `codeWordWrap: boolean`（默认 `false`，控制对话代码块与工作台只读代码视图默认是否自动折行）；
       - `desktopNotifications: boolean`（默认 `true`，控制窗口失焦时待审批、任务完成/失败与监视触发的系统级通知总开关）。
     - `confirmations: { deleteSession: boolean; archiveSession: boolean; closeActiveTerminal: boolean }`（默认值分别为 `true`、`false`、`true`）。
3. **首帧零闪烁注入与全链路即时同步**：
   - 首帧 `boot-theme.js` 与预加载初始化同步写入 `document.documentElement.dataset.theme`、`lang`（`'zh-CN'` | `'en'`）及 `--kpbl-font-sans`、`--kpbl-font-mono`、`--kpbl-text-prose`、`data-code-ligatures`、`data-code-wrap`，消除冷启动主题、字体与字号跳变；
   - 用户在「常规」页修改任意项或点击「恢复默认设置」时，Zustand `settings-store` 立即更新 DOM 令牌与活跃终端实例，并通过 `preferences.update` IPC 同步持久化及刷新 macOS/Win/Linux 原生应用菜单、系统托盘菜单与后台通知门闩。

---

## 6. 八大核心界面详细规范（Surfaces）

### 6.1 左栏（`NavigationRail`）

- **顶带（`42px`）**：macOS（`titleBarStyle: 'hiddenInset'`）下隐藏左栏品牌图标与字标，留出 `padding-left: 84px` 与 `.kpbl-drag` 原生窗口拖拽呼吸区并将 `新建对话` / `展开或收起侧栏` 按钮靠右对齐；Windows/Linux 无左侧红绿灯偏移，保留 `BrandMark(20px)` + `Kapibala` 字标与右侧操作按钮。下方紧接全宽 `28px` 高 `⌘K` 搜索与命令触发钮（删除旧版顶部 `70px` 空白与死板横线）。
- **动态运行收件箱（`InboxSection`）**：`selectInboxItems()` 非空时渲染，按「待审批（琥珀呼吸点 + `待审批` 胶囊）→ 运行中 → 监视已触发」排序；空闲时整区 `null` 不占位。
- **工作区与层级会话树（`WorkspaceTree`）**：
  - 空分组（如无条目的「临时对话」）整组隐藏，禁止渲染「暂无临时对话」。
  - 会话行固定 `grid-template-columns: 16px minmax(0, 1fr) auto`：中列标题单行省略，右列**单一尾槽**（常态显示状态胶囊或相对时间，悬停/键盘聚焦内部时切换为 `···` 操作菜单触发器），彻底杜绝标题与多个徽标互挤截断成单字母。
  - 本地 `/delegate` 子会话缩进挂载于父会话下方（前缀 `↳`）；关联独立 Worktree 的会话展示次级行 `⎇ <branch>`。

### 6.2 统一单行页头（`SessionHeader` · `42px`）

- 左侧：`[展开或收起侧栏 IconButton]` · `空间名 /` · `会话标题（点击原地编辑）` · `HarnessBadge`（外部代理必显，如 `Claude Code · CLI`；本地默认会话可省以减噪） · `⎇ 分支胶囊`（如有）。
- 右侧：`[变更统计按钮 +A −D]`（`diffSummary` 非零时显示，点击直接激活右侧工作台 `Diff` 标签；彻底移除原阅读列左上角悬空芯片） · `[展开或收起工作台按钮 ⌘J]` · `[会话操作菜单 ···]`（重命名、置顶、分叉、归档、关闭会话）。

### 6.3 对话与执行流（`VirtualTurnList`）

- 继续采用 `@tanstack/react-virtual` 虚拟滚动（显式保持 Streamdown 容器 `content-visibility: visible` 防测量跳动）。
- **轮次节奏**：用户消息居右（`--kpbl-bg-subtle`，最大宽 `82%`）→ 间隔 `14px` → 助手过程层（左缘与助手正文严格共线）→ 正文 Streamdown 卡片流 → 轮次尾栏（悬停或聚焦显露 `复制正文`、`重试`、后续 `还原检查点`，右侧常驻弱化 Token/缓存命中摘要）。
- **执行组、语义运行态与工作台联动**：工具行结构固定为 `[状态图标] [中文动作词] [等宽目标路径/命令] [+A −D] [耗时]`；运行中的工具行、流式思考头与对话底部运行状态条按当前工具/阶段展示 8 态 `AgentActivityGlyph`（结束后即刻切回静态 `Icon`）；同会话多条 `<session-reference>` 合并为单枚 `@标题 · N` 徽标；点击文件编辑行打开右侧工作台 `Diff` 标签，点击 HTML/SVG/图片产物行打开 `Preview` 标签，点击普通命令/MCP 行打开 `Inspector` 标签并定位到该 `callId`。
- **回到底部**：偏离底部时在输入坞正上方居中浮现 `28px` 高轻量胶囊按钮 `↓ 返回底部`。

### 6.4 全能输入坞（`ComposerDock`）

自上而下三层同宽堆叠（与当前对话列同宽，坞顶带 `20px` 线性渐隐遮罩）：

1. **`ApprovalDeck`（内联审批叠卡）**：取代原全屏审批模态框。左缘 `3px` `--kpbl-pulse` 琥珀色条；首行展示可读动作标题 + 016 风险分级胶囊 + 倒计时/队列序号；中段等宽框展示**相对路径**与命令或变更预览；底栏提供 `拒绝`、`本会话允许相同调用`、`批准一次`（Primary）及 `环境详情`（跳转右侧 `Inspector` 查看完整路径与会话 ID）。当前会话不在前台时，由左栏收件箱徽标与右上角可点击跳转 Toast 触达。
2. **`LiveStatusStrip`（单行状态条）**：按需聚合 `任务进度 pill`（点击向上弹出 `AnchoredPopover` 清单）、`活跃监视 pill`、自动重试退避进度，右侧弱化显示 `上下文占用%`。全部为空时整行不渲染。
3. **`OmniComposer`（输入主卡）**：顶部预留附件与 `@引用` 快照胶囊托盘；中部无框自适应 `textarea`（支持 `/` 命令菜单与 `@` 引用补全弹层）；底部单行控制栏放置 `ModelHarnessPicker`（本地模型 + 已启用外部代理双栏检索）、角色/模式下拉（按 `capabilities` 显隐）与圆形发送/停止按钮。空间未信任或无可用模型时，在卡内底栏下方以细线分隔渲染一行就地引导条。

### 6.5 右侧多标签工作台（`WorkbenchStage`）

取代 `DetailsDrawer`，按 `sessionKey` 维护已打开标签栈：
- **`Diff` 标签**：左/上文件选择器 + 单文件变更对比视图（支持 Unified 视图；`v0.1.6` 接入 Shadow Git 检查点后扩展整轮真实文件 Diff 与一键回滚入口）。
- **`Preview` 标签**：复用主进程 `kpbl-preview://` 独立源沙箱（`sandbox="allow-scripts"`、禁外网连接）与 `preview.file()` 受控图片通道，并排承载 HTML、SVG 与生成位图预览，不再把大块 iframe 塞进对话流。
- **`Files` 标签**：工作区受控文件模糊检索与带行号只读代码预览。
- **`Terminal` 标签**：预留会话级保活终端容器槽位，供 `v0.1.6` 终端子系统直接挂载。
- **`Inspector` 标签**：上部展示单次工具调用的完整入参、标准输出/错误与耗时；下部承载会话四维证据看板（变更明细、跨会话引用来源、MCP 调用统计、派生委派任务）及底层运行事实（实际工作目录完整路径、原生会话 ID）。

### 6.6 启动台（`LaunchpadView`）

未打开具体历史会话时，将 `BrandMark`、一句简短标题、`OmniComposer` 输入卡（含工作区选择与 `v0.1.6` Worktree 开关槽位）以及 3 张场景/外部代理快捷起手卡作为**单一紧凑垂直组居中放置在主舞台黄金视觉中心**，彻底消除旧版首页中部 `300px` 空白断层。

### 6.7 壳内设置与代理中心（`SettingsStage`）与首栏「常规（General）」页

- 作为主舞台一级视图（与会话工作台同级切换），左侧 `196px` 分组导航轨顶部为 `← 返回工作台`，下方 **8 个一级分组（将原「外观与应用」合并升级并置顶为第 1 项「常规」，不单拆独立外观页）**：
  1. **常规（`general`，图标 `sliders`，兼容旧别名 `'appearance'`）**
  2. 模型与服务商（`providers`）
  3. 默认模型与路由（`routing`）
  4. 外部代理（`external`）
  5. 权限审批（`permissions`）
  6. 资源管理（`resources`）
  7. 会话归档（`archives`）
  8. 诊断（`diagnostics`）
  右侧独立滚动内容区（常规表单页 `max-width: 660px`，模型与外部代理复合页 `max-width: 960px`）。
- 标题固定 `18px/600` + `13px` 灰字说明，移除旧版 `28px` 标题与装饰图标框；全部采用单层 `SettingSection` + `SettingRow`。**「常规」页头右侧对标 T3 Code 提供轻量 `恢复默认设置` 按钮**（弹出 `ModalDialog` 确认后仅重置「常规」页的外观、语言、字体字号与交互偏好，不清空模型密钥、项目信任或会话数据）。
- **首栏「常规（`GeneralPage.tsx`）」六大分组（完整覆盖外观、双语、字体字号与高频交互）**：
  1. **配色模式（Color Mode）**：采用 **T3 Code 式三列微缩窗口预览选择卡**（`role="radiogroup" aria-label="配色模式"`，纯 CSS/SVG 绘制左轨、气泡与输入坞微缩骨架）：分别为 **跟随系统**（左宣石暖纸 / 右曜石墨分栏微缩图）、**浅色**（宣石暖纸微缩图）、**深色**（曜石墨微缩图）；选中卡片使用 `2px` `--kpbl-line-strong` 碳素墨框高亮，不引入蓝色边框。
  2. **语言与显示（Language & Display）**：
     - **界面语言**：下拉框（`Select<'system' | 'zh-CN' | 'en'>`：`跟随系统` / `简体中文` / `English`），切换后全界面、窗口原生菜单与系统托盘即时生效，无需重启；
     - **时间显示格式**：下拉框（`跟随系统` / `相对时间` / `24 小时制` / `12 小时制`，对标 T3 Code「显示 → 时间格式」，统一左栏会话时间与轮次时间戳）。
  3. **字体与字号（Typography & Font Size）**：
     - **界面与正文字体（`uiFontFamily`）**：提供 `系统默认` 预设与可选本机字体名输入（实时更新 `:root` `--kpbl-font-sans` 并附一行中英文排版预览句）；
     - **代码与终端等宽字体（`codeFontFamily`）**：提供 `系统等宽`、`JetBrains Mono`、`Cascadia Mono`、`Fira Code`、`SF Mono` 预设及自定义等宽字体输入，同步驱动代码块、`FilesTab` / `DiffTab` 与工作台 `@xterm/xterm` 终端字体；
     - **对话阅读字号（`chatFontSize`）**：受控步进控制（`13px–18px`，默认 `15px`），实时驱动 `--kpbl-text-prose` 与代码块字号（左轨与顶栏保持紧凑标尺不溢出）；
     - **终端字号（`terminalFontSize`）**：受控步进控制（`11px–18px`，默认 `13px`），实时同步保活终端并自动重算行列；
     - **代码连字（`codeLigatures`）** 与 **代码块默认折行（`codeWordWrap`）**：碳素墨 `Switch` 开关。
  4. **输入与通知（Input & Notifications）**：
     - **发送消息快捷键（`sendShortcut`）**：单选下拉（默认 `Enter 发送 / Shift+Enter 换行` vs `⌘/Ctrl+Enter 发送 / Enter 换行`）；
     - **后台桌面通知（`desktopNotifications`）**：碳素墨 `Switch` 开关（控制窗口失焦时待审批、运行完成/失败或监视触发的系统通知）。
  5. **确认操作（Confirmation Prompts）**：碳素墨 `Switch` 开关组——**删除会话确认**（默认开启：永久删除会话前弹窗确认）、**归档会话确认**（默认关闭：开启后归档需二次确认）、**关闭运行中终端确认**（默认开启：关闭仍有活跃进程的会话工作台终端前询问）。
  6. **终端环境与版本更新（Terminal & Updates）**：保留首选交互 Shell 选择下拉框，以及未签名 GitHub Releases 手动检查更新、SHA-256 摘要校验下载与 macOS `xattr` 放行指引。
- **外部代理列表重排**：每行固定双层左列（代理名 + 传输协议胶囊 + 检测状态点 / 次行等宽命令中段省略）+ 右侧紧凑操作组（`检测连接`、`配置覆盖`、碳素墨 `Switch`）；点击「配置覆盖」在该行下方手风琴式展开路径、参数与 `envFrom` 编辑区。

### 6.8 全局命令面板（`CommandPalette`）与 CLI 终端同构（`packages/cli/src/ui/theme.ts`）

- **`⌘K` 命令面板**：基于 `ModalDialog`（`closedby="any"`）实现，顶部搜索框 + 分组结果列表（最近/运行中会话、快速新建指定外部代理会话、工作台与权限快捷指令、跳转指定设置分组）。
- **CLI 语义主题对齐**：在 `packages/cli/src/ui/theme.ts` 建立终端唯一 ANSI 着色与字形出口，收拢 `events.ts`、`approval.ts`、`select.ts` 中散写的 `\x1b[...m`：
  - 语义函数：`theme.strong`（粗体）、`theme.subtle`（暗灰 90）、`theme.pulse`（256 色琥珀 `208` / 16 色回退黄 `33`）、`theme.success`（绿 `32`）、`theme.danger`（红 `31`）、`theme.warning`（黄 `33`）、`theme.info`（青 `36`）。
  - 统一状态字形：`●` 运行中、`◆` 待审批、`✓` 成功、`✗` 失败、`○` 待办、`⎇` 分支/Worktree、`↳` 工具结果/子代理。
  - 当 `process.env.NO_COLOR !== undefined` 或 `!isTTY` 时自动输出纯文本零转义序列。

---

## 7. 桌面 E2E 可访问名契约迁移表

UI 可访问名是 `packages/desktop/e2e/*.spec.ts` 的精确选择器契约。重构执行时严禁静默改名，必须按以下对照表同步更新组件与对应测试断言：

| 交互区域 | 保持不变的稳定可访问名 | 随架构升级显式迁移的选择器（阶段对应同步 E2E） |
|---|---|---|
| **左栏导航** | `complementary[name="空间与会话"]`、`button[name="新建对话"]`、`button[name="展开或收起侧栏"]`、`button[name="打开设置"]` | 顶部搜索框升级为 `button[name="搜索或运行命令"]`（唤起 `dialog[name="命令面板"]` 内的 `searchbox[name="搜索会话或命令"]`） |
| **输入坞** | `textbox[name="发送消息"]`、`button[name="发送"]`、`button[name="停止"]`、`button[name="任务清单"]` | 空间与模型选择统一收敛至 `OmniComposer` 底栏按钮（保留 `/会话空间：|选择空间/` 与模型按钮可访问名） |
| **人工审批** | `button[name="批准一次"]`、`button[name="拒绝"]` | 原阻断模态 `dialog[name="待处理审批"]` 迁移为输入坞内联区域 `region[name="待处理审批"]`（不再断言模态遮罩宽度） |
| **右侧工作台** | `button[name="查看详情"]`、`button[name="预览 HTML"]` | 原 `dialog[name="工具详情" \| "会话证据" \| "产物预览"]` 统一迁移为 `complementary[name="工作台面板"]` 及其内部 `tab[name="变更" \| "预览" \| "文件" \| "终端" \| "详情与证据"]` |
| **设置中心与双语** | 其余分组名称（`模型与服务商`、`外部代理`、`权限审批`、`资源管理`、`会话归档`、`诊断`） | 原 `tab[name="外观与应用"]` 合并升级为左轨首项 `tab[name="常规"]`（`normalizeSettingsTab` 保留 `'appearance' → 'general'` 兼容）；原全屏模态 `dialog[name="设置"]` + `button[name="返回应用"]` 迁移为壳内视图 `region[name="设置中心"]` + `button[name="返回工作台"]`；`KPBL_DESKTOP_E2E=1` 默认回退 `'zh-CN'` 保持全量中文 E2E 稳定，另立专项用例断言切换 `'en'` 及修改字体/字号/快捷键后的实时联动 |
| **保留模态框** | `dialog[name="创建项目"]`、`dialog[name="信任此文件夹吗？"]`、`dialog[name="启用完全访问？"]` | 底层实现切换为原生 `<dialog>`，可访问名与内部确认/取消按钮文案 100% 保持不变 |

---

## 8. 静态架构门禁升级（`scripts/check-desktop.ts`）

在阶段 5 切换完成后，同步收紧静态门禁以锁死重构成果：

1. **移除 Kumo 依赖**：从 `packages/desktop/package.json` 及 `scripts/check-desktop.ts` 白名单删除 `@cloudflare/kumo`，拦截任何第三方预设样式组件库导入。
2. **业务层 UI 进口收束**：`packages/desktop/src/renderer/surfaces/**` 禁止直接导入 `@phosphor-icons/react`（必须经 `ui/icon.tsx` 统一出口），禁止使用非语义颜色字面量与内联像素圆角。
3. **文件体积防线与双语对齐**：`packages/desktop/src/renderer/` 下除自动生成/静态数据表外，任意 `.ts` / `.tsx` 源文件行数 `> 450` 直接报错（`packages/desktop/src/shared/i18n/{zh-CN,en}.ts` 纯静态词典表豁免行数上限，并由 TypeScript 编译期强制锁死双语键集合 100% 对齐），防止巨石组件复发。
4. **CLI 主题收束**：`scripts/check-cli-boundary.ts` 增加规则——`packages/cli/src/ui/` 下除 `theme.ts` 外禁止直接书写 `\x1b[` ANSI SGR 颜色转义（光标移动控制集中在 `tui/` 与 `events.ts` 锚点层除外）。

---

## 9. 五阶段可执行重构计划（`v0.1.6` 实施路线）

> **执行纪律**：在 `v0.1.5` 合并发布并切出 `v0.1.6` 分支后按顺序推进；**每一阶段结束必须独立跑通 `pnpm verify` 与 `pnpm verify:desktop`**，禁止跨多阶段攒批修测试。

### 阶段 1：样式级联底座、原语库与统一投影层（零界面破坏并存期）

- **新建文件**：
  - `packages/desktop/src/renderer/styles/{tokens.css,base.css,prose.css,shiki.css,index.css}`
  - `packages/desktop/src/renderer/ui/{button.tsx,fields.tsx,switch.tsx,segmented.tsx,dialog.tsx,popover.tsx,select.tsx,badges.tsx,truncate.tsx,split-pane.tsx,settings-kit.tsx,toast.tsx,icon.tsx,index.ts}`
  - `packages/desktop/src/renderer/adapters/unified-thread.ts`
  - `packages/desktop/src/renderer/stores/{shell-store.ts,workspace-store.ts,session-store.ts,settings-store.ts}`
  - 单元测试：`packages/desktop/tests/{unified-thread.test.ts,ui-primitives.test.ts}`
- **阶段门禁**：单测验证本地 `ViewState` 与四类外部代理 `ExternalSessionSnapshot` 经 `unified-thread.ts` 转换后的标题、轮次、工具组、内联审批单与能力位完全一致；新双主题令牌下深色代码块对比度达标；既有桌面 E2E 全绿。

### 阶段 2：新应用壳、左栏运行收件箱、居中启动台与 `⌘K` 命令面板

- **新建与替换**：
  - `packages/desktop/src/renderer/surfaces/shell/{AppShell.tsx,NavigationRail.tsx,InboxSection.tsx,WorkspaceTree.tsx,CommandPalette.tsx}`
  - `packages/desktop/src/renderer/surfaces/launchpad/LaunchpadView.tsx`
  - 重写 `packages/desktop/src/renderer/project-dialog.tsx` 与 `session-actions.tsx` 为 `ui/ModalDialog`
- **同步更新 E2E**：更新 `visual-matrix.spec.ts` 与 `dev-brand.spec.ts` 中左栏宽度（`248px` / `52px`）与搜索/命令面板入口断言。
- **阶段门禁**：1280×800、800×800、1280×600、800×600 四视口无横向溢出；空分组自动隐藏；长外部会话标题不再截断错位。

### 阶段 3：单一会话流合并与全内联输入坞（退役 `external-session-view.tsx` 与模态审批）

- **新建与删除**：
  - 新建 `packages/desktop/src/renderer/surfaces/thread/{SessionStage.tsx,SessionHeader.tsx,VirtualTurnList.tsx,TurnItem.tsx,ProcessGroup.tsx}`
  - 新建 `packages/desktop/src/renderer/surfaces/composer/{ComposerDock.tsx,ApprovalDeck.tsx,LiveStatusStrip.tsx,OmniComposer.tsx,ModelHarnessPicker.tsx}`
  - 删除 `packages/desktop/src/renderer/external-session-view.tsx`、`composer-model-picker.tsx`、`task-panel.tsx`、`message-list.tsx`
- **同步更新 E2E**：将 `desktop.spec.ts`、`external-panel.spec.ts`、`composer.spec.ts`、`markdown.spec.ts`、`watch-and-retry.spec.ts` 中的审批断言统一迁至内联 `region[name="待处理审批"]`。
- **阶段门禁**：本地会话与外部 ACP/CLI 会话走同一 `SessionStage`；审批首屏零绝对路径与零原始 UUID；用户气泡至过程层间距收紧至 `14px`。

### 阶段 4：并排可调宽多标签工作台（退役 `DetailsDrawer`，打通 `v0.1.6` 右侧工作台）

- **新建与删除**：
  - 新建 `packages/desktop/src/renderer/surfaces/workbench/{WorkbenchStage.tsx,DiffTab.tsx,PreviewTab.tsx,FilesTab.tsx,TerminalTab.tsx,InspectorTab.tsx}`
  - 删除 `packages/desktop/src/renderer/details-drawer.tsx`
- **同步更新 E2E**：更新 `desktop.spec.ts` 工具详情、证据看板与图片/HTML 产物预览断言至 `WorkbenchStage` 标签页，验证按会话切换记住标签状态与 `SplitPane` 拖拽边界。
- **阶段门禁**：`Diff`、`Preview`（`kpbl-preview://` 沙箱）、`Files`、`Inspector` 四标签全部跑通，`Terminal` 保活槽位就绪。

### 阶段 5：壳内设置中心（含首栏「常规」与客户端中英双语）、卸载 `@cloudflare/kumo`、CLI 主题对齐与静态门禁锁死

- **新建、删除与收口（待前序并行功能收尾后统一实施）**：
  - 新建桌面端零依赖强类型双语词典 `packages/desktop/src/shared/i18n/{types.ts,zh-CN.ts,en.ts,index.ts}`，扩展主进程 `preferences.ts` 支持 `locale`、`typography`（界面/代码字体、对话/终端字号、连字）、`general`（时间格式、发送快捷键、折行、后台通知）、`confirmations` 持久化、恢复默认值及菜单/托盘语言同步
  - 新建/收口 `packages/desktop/src/renderer/surfaces/settings/{SettingsStage.tsx,GeneralPage.tsx,ProvidersPage.tsx,RoutingPage.tsx,ExternalHarnessesPage.tsx,PermissionsPage.tsx,ResourcesPage.tsx,ArchivesPage.tsx,DiagnosticsPage.tsx}`（由 `GeneralPage.tsx` 合并替换原 `AppearancePage.tsx` 并置顶为第 1 项「常规」）
  - 删除 `packages/desktop/src/renderer/settings-dialog.tsx`、`external-settings-panel.tsx`、`theme-kapibala.css` 及未再引用的动态图标脚本
  - 精简 `packages/desktop/src/renderer/App.tsx` 至 `< 150` 行纯顶层装配入口
  - 从 `packages/desktop/package.json` 移除 `@cloudflare/kumo`
  - 新建 `packages/cli/src/ui/theme.ts` 并重构 `events.ts`、`approval.ts`、`select.ts` 的 ANSI 输出，补齐 `NO_COLOR=1` 单测
  - 按 §8 升级 `scripts/check-desktop.ts` 与 `scripts/check-cli-boundary.ts`
- **最终验收门禁**：
  1. `pnpm verify`（`typecheck → test → lint`，含升级后的 `check-desktop`、`check-cli-boundary`、`check-secrets` 及双语键集合编译期对齐）全绿；
  2. `pnpm verify:desktop` 全量 Playwright E2E（含中英文实时切换、字体/字号/快捷键联动专项断言）与四视口浅/深视觉矩阵全绿；
  3. `packages/desktop/src/renderer/` 下最大单文件 `≤ 450` 行，`@cloudflare/kumo` 零残留，全应用零蓝色异常控件、深色代码块全语法高亮清晰可读。
