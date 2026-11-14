# Design

## Context

- CLI 命令系统现成：`commands/dispatcher.ts` 的 `dispatch(raw, ctx) → boolean`（false = 非命令）+ `getDefinitions()`（补全数据源）+ 19 个命令；`CommandContext` 字段已全部可选化（session/settings/output/onExit 必填，question/select/readSecret/renderEvent/runSkill/runPreparedTask 等回调注入）。
- 桌面执行链：renderer `run.start` → desktop-host → 托管会话；审批已有「请求事件 → 对话框 → `approval.reply`」的请求-应答模式可复用于命令交互。
- 命令输出：`CommandOutput { log/error/write }`（`command-output.ts`），`resolveCommandOutput(context)` 缺省走 stdout——桌面适配器注入自定义 output 即可接管全部命令文本。
- `@` 语义前提：core 的 read 工具已有完整授权/沙箱链路；`run.start` 纯文本路径不需要任何改动。

## Goals / Non-Goals

**Goals**
- 桌面与 CLI 单一命令真源：桌面只做适配器，不复制任何命令实现
- composer 触发符基建共享：`/` 与 `@` 一套识别 + 补全面板 + 键盘导航
- `@` 零授权面变化：纯文本语义，枚举只出路径

**Non-Goals**
- 不新增命令（目录复用 CLI）；不做 `@` 内容注入；不做运行中会话的命令热插拔语义变更；`/` 与 `@` 不做 CLI 侧同步改造（CLI 已有 `/`，`@` 两端共享留待后续）

## Decisions

### D1：命令分发器在 desktop-host 进程内直跑，不进宿主层包

`CommandDispatcher` 及命令实现留在 `packages/cli/src/commands/`（CLI 应用层），desktop-host 直接 import 装配——desktop 本就是工作区私有包，依赖 cli 合法。备选「把 commands 下移宿主层」被否：命令语义与 CLI 交互深度绑定（settings/向导/REPL 端口），下移会造成大片迁移且 `internal` 门面膨胀；真源唯一性靠「desktop 只 import、不复制」保证。

### D2：`run.command` RPC + CommandContext 适配器

renderer `/` 输入 → `run.command(session, input)` → desktop-host 用当前托管会话构造 `CommandContext`：`session`=托管会话、`settings`=宿主层 loadSettings、`output`=收集为命令反馈事件回传 renderer、`onModelSwitched`/`onCredentialsUpdated` 等回调接 SettingsService 既有行为、`onExit`=空操作（桌面无退出概念）、`controller`/`renderEvent` 等按 availability 注入。返回 `{ handled, output }`；`handled=false` 仅为防御路径（renderer 已拦截非 `/` 输入）。命令产生的会话事件（如 `/skill` 的执行流）走既有 presentation 通道渲染——`/skill` 特殊处理：dispatcher 的 `context.runSkill` 注入托管会话 runSkill，事件流复用 run 通道。

### D3：交互应答复用审批面板模式

新增 `interaction.requested`（会话级请求：select/question/readSecret 三形态）→ renderer 弹对话框（复用审批面板的聚焦/排队交互）→ `interaction.reply(requestId, value)` 应答；desktop-host 的 CommandContext 注入 `question/select/readSecret` 实现（Promise 挂起直到 reply/超时/关闭）。超时与关闭 MUST resolve 为取消而非挂起——与审批超时语义对齐。`readSecret` 的值不进事件流与日志（同审批 reply 的脱敏处理）。

### D4：首批命令面 = 非交互命令 + `/skill`，交互命令按对话框落地分批接入

命令目录按「是否需要 question/select/readSecret」静态分级：无需交互的命令首版全量可用；需要交互的命令待 D3 对话框接入后解锁。分级用命令定义上新增的元数据声明（CLI 侧标注，桌面消费），避免桌面硬编码命令名单——CLI 新增命令时桌面自动可见。

### D5：`@` 枚举走 `workspace.listFiles`，前端过滤

新 RPC 返回有界文件清单（相对路径数组；预算：深度 ≤ 16、条目 ≤ 5_000，忽略 node_modules/.git/dist 等通用目录名），desktop-host 侧用 core 既有 fs 枚举实现 + 沙箱根约束；模糊匹配/前缀过滤在 renderer 内存中做（清单刷新时机：打开工作区 + 手动刷新），不做按击键的服务端搜索。理由：枚举一次成本可控，按键搜索会产生高频 RPC；`gitignore` 语义不做（枚举不是读取授权，模型读文件仍走工具审批），仅做通用忽略目录。

### D6：composer 触发基建一套两用

renderer 抽取共享的补全面板组件（数据源接口：`{ id, label, detail }[]`）+ 触发状态机（`/` 命令态 / `@` 文件态 / 无态），键盘导航与确认/Esc 行为一致；两个触发符的状态互斥（同一时刻只有一种面板）。

## Risks / Trade-offs

- [命令实现依赖 CLI 全局态（settings 向导等）在桌面环境行为异常] → 首批只解锁无交互命令；交互命令逐个验收后才标注可用；适配器单测覆盖每个解锁命令
- [`/skill` 事件流与普通 run 通道的编排复杂度] → 复用 run 通道现有事件渲染，命令反馈消息与会话事件流分容器展示
- [枚举大工作区慢] → 预算硬上限 + 忽略目录 + 打开工作区时后台预热一次；超预算截断并明示
- [`@` 轻量语义与用户预期差（以为会自动附内容）] → 面板与文档明示「引用仅为路径提示，模型按需读取」；注入式留作后续可选语义（core 基建已支持）

## Migration Plan

纯增量：`run.start` 路径不变，`/` 拦截仅在 renderer 侧（CLI/协议无感）；回滚 = 还原提交。命令分级元数据为 CLI 命令定义的可选字段，旧命令定义缺省视为「需交互」——桌面保守降级。

## Open Questions

- 命令反馈消息在会话历史中的呈现形态（独立消息类型 vs 本地通知条）——实现时按 renderer 既有消息组件对齐，不影响规格。
