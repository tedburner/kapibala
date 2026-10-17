# Proposal: v0.0.8 终端客户端与跨端展示

## Why

现有终端输出将流式事件、ANSI、过程缓存和指标混在一个渲染器中，readline 输入及命令直接输出也不足以支持稳定的历史重绘、过程展开和后台任务观测。v0.0.8 需要在现有 CLI 包内交付产品级 TUI，并沉淀未来 GUI 可复用的纯展示模型，同时保留 Headless Core 和文本输出兼容性。

## What Changes

- 保留三个工作区发布包和 `kpbl` 命令，在 CLI 内建立 Host / ViewModel / TUI 分层，提供无 Node/DOM/React 依赖的 `@kiturone/kapibala-cli/view-model` 子路径。
- 新增 `--ui auto|tui|text`，通过依赖准入选择终端渲染组合；保持 Node >=20，优先验证 Ink 6.8.0 / React 19.2.4，不把库声明当作已完成的平台验收。
- 统一启动输入交接、编辑、菜单、秘密输入、审批、命令输出和终端模式所有权；任务取消、正常关闭与致命异常分别处理。
- 建立流式暂存与 canonical 历史对齐的展示投影，隔离会话/分支代次；运行结果与清理解锁分别展示，保留既有消息落盘及工具事务规则。
- `/` 面板聚合内置命令、用户可调用 Skill、MCP Prompt，提供稳定匹配、三行滚动窗口、参数编辑和按实际调用参数计算的 busy 提示。
- 交付备用屏会话视窗、流式 Markdown、思考/工具折叠、键盘历史浏览、动态行窗口与布局预算；复用 Ink 输入/同步输出/限帧能力，按实测补缺口。
- 增加后台任务变化订阅、来源过滤、待收集提示和真实状态栏指标，继续显式 collect，不改变父模型唤醒或审批权限。
- 补齐浏览器入口、架构边界、tarball、Node/平台交互、文本兼容及性能验收。

本版不新增 GUI、Daemon、wire RPC、鼠标点击增强、自动结果投递、审批冒泡、Worktree 或树级计费；不自动提交、打标签或发布。

## Capabilities

### New Capabilities

- `terminal-client-lifecycle`: UI 模式选择、单一终端资源所有权、取消/关闭/致命异常和文本降级。
- `terminal-input-coordination`: 编辑与焦点、完整按键/粘贴、问答/秘密/审批及统一宿主输出。
- `client-presentation-projection`: 无端展示模型、流式与历史对齐、身份/代次、折叠规则及独立浏览器入口。
- `terminal-command-palette`: 三来源命令目录、稳定匹配、参数级执行门与面板交互。
- `terminal-conversation-viewport`: Markdown、历史/过程浏览、动态行窗口、布局缓存与帧合并。
- `terminal-task-observation`: 后台任务订阅、分支来源与投递状态、可组合状态栏及真实指标。

### Modified Capabilities

无。当前主 specs 目录尚无持久 capability；已有版本 change 的 canonical、权限和取消约束继续遵守，本变更不撤销它们。

## Impact

- CLI：`index.ts` / `repl.ts` / `oneshot.ts`、输入协调器、命令目录与 dispatcher、MCP/诊断接线，新增 `host/`、`view-model/`、`tui/`。
- Core：仅补通用任务变化订阅等必要公共接点，保持零外部运行时依赖，不加入终端格式或 GUI 逻辑。
- 工程：CLI 依赖与构建子路径、TSX 测试/类型配置、展示层架构门禁、安装和终端验收脚本、迁移与验证文档；发布包数量和版本推演真源保持不变。
- 设计依据：[已审阅技术方案](../../../docs/superpowers/specs/2026-10-17-v0-0-8-terminal-experience-design.md)。后续进度以本 change 的 tasks 为准，验收证据与功能完成分别记录。
