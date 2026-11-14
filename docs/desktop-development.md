# v0.1.0 桌面开发指南

> 状态：阶段 A 共享层与阶段 B 桌面最小闭环已实现并通过本地自动验收。功能和架构决策以 [004 设计](design/004-v0.1.0-desktop-harness.md)为准；本文记录已落地入口及后续顺序；阶段 C 的会话体验及本地门禁已落地，创建项目与双层信任弹窗已接入；D1 已提供本机测试打包与安装副本验证入口，阶段 E 完成界面统一、断连修复与候选发布工程；视觉层的当前档位见 [006 视觉精修](design/006-desktop-visual-refinement.md)。跨平台安装、签名和正式发布仍待完成。详见[阶段 C 验收](verification/v0.1.0-stage-c.md)、[D1 验收](verification/v0.1.0-stage-d1.md)与[阶段 E 验收](verification/v0.1.0-stage-e.md)。

从共享宿主抽取开始，再接入 Electron。每一步都保持现有 CLI、Core SDK、MCP 和本地协议可独立使用；不要先复制 CLI 装配，再长期维护两套执行逻辑。

## 1. 开工与命令

先阅读根 `AGENTS.md`、[本地宿主](local-host.md)、[本地协议](local-protocol.md)及 [SDK 兼容性说明](sdk-compatibility.md)。日常开发使用分支，保留已有工作区改动，不自动暂存、提交或推送。

当前可用的入口：

```sh
node --version
pnpm --version
pnpm dev:build
pnpm verify
```

`dev:build` 走现有依赖、链接、构建与校验流程，不启动 REPL。首次安装及这些命令可能执行依赖脚本，按仓库现有规则处理；不要为了运行桌面包关闭 pnpm 的安装脚本许可控制。CLI/Core 的 Node 20 支持与 Electron 内嵌 Node 分别验收。

阶段 B 已增加下列开发入口；桌面开发工具链要求 Node >= 22.12（建议 Node 24），Core、MCP 和 CLI 的最低运行时仍为 Node 20：

| 目标命令 | 实施要求 |
|---|---|
| `pnpm dev:desktop` | 构建 Core、MCP、CLI `/host` 与 `/view-model` 后启动 Electron；共享源码变化触发依赖重建和受控重启，不能继续运行旧 dist |
| `pnpm verify:desktop` | 依次构建共享层和桌面、分入口类型检查、源码与 Preload 产物边界、桌面单测、真实 Electron E2E；隔离 homeDirectory、userData、项目和环境凭证 |
| `pnpm build:desktop` | 构建共享层及四个桌面入口，不启动窗口 |
| `pnpm check-desktop --artifacts` | 检查源码进程边界、Kumo/Tailwind/主题契约，以及已构建的 CJS Preload 和入口完整性 |
| `pnpm pack:desktop` | 验证桌面后生成当前平台测试包，检查生产依赖闭包、启动安装副本并输出校验和与许可附件；不签发正式候选、不发布 |

首次安装执行 `pnpm install --frozen-lockfile`。锁定的 Electron 45 使用显式运行时安装入口：`pnpm --filter @kiturone/kapibala-desktop exec install-electron`，随后运行 `pnpm dev:desktop`。不关闭下载校验，也不把桌面 Node 要求传到 CLI 的 engines。

根 `pnpm build` 保持三包构建，不调用 Electron/Vite；`pnpm verify` 纳入桌面类型、纯逻辑测试及源码边界，真实 GUI 回归单独走 `verify:desktop`。CI 新增 macOS/Windows 桌面任务，与 Node 20 的 CLI/SDK 门禁分开。

`dev:desktop` 使用 `packages/desktop/scripts/dev.mjs`：先构建共享产物，启动仅绑定 loopback 的 Vite Renderer，再通过私有父子 IPC 请求 Main 正常退出，等待工具清理、Host 正常退出及 guard 清除后才重建并启动。源码内容指纹过滤构建器产生的元数据事件；Renderer 更新走 Vite，不以强杀 Host 换取热更新。清理失败停止重启，保留 guard。该开发 IPC 仅在非打包、Node 父子 IPC 和随机开发令牌同时存在时启用，不暴露给 Renderer。macOS 开发入口会在 `.workbuddy/desktop-dev-runtime/` 缓存独立的 Electron 应用包副本，将菜单栏与 Dock 名称设为 Kapibala 并重新签名；不修改依赖中的 Electron 包。

不要只启动 electron-vite 就宣称共享代码已更新。开发重启同样要经过取消和清理；清理失败保留异常 guard，不能靠热更新跳过执行阻断。Renderer 的普通视图更新不重启 Host。

**启动环境分两层，别绕过。** 根 `pnpm build` / `build:desktop` / `dev:desktop` 实际是 `scripts/build.mjs` 与 `scripts/dev-desktop.mjs`：它们先用 `scripts/process-env.mjs` 的 `toolchainEnv()` 摘掉宿主注入的 `--require` / `--import` 与 `ELECTRON_RUN_AS_NODE`，再拉起下一层命令 —— 否则宿主的删除守卫会把打包器清 `out/` 当成批量删除拦下，报错指向无关的 `.js.map`，看起来像打包器坏了。启动 Electron 本身则走 `packages/desktop/scripts/launch-env.mjs` 的 `desktopLaunchEnv()` 白名单。

⚠️ 不要在 IDE 内嵌终端里跑 `pnpm dev:desktop`。那里的进程已处于系统沙箱内，Chromium 再初始化自己的进程级沙箱会被内核拒绝（`sandbox initialization failed` → GPU `exit_code=6` → 主进程 SIGTRAP），退出时来不及清 guard，下次打开就是「上次执行未确认完成清理」。用系统「终端」（Terminal.app）启动。

### 1.1 本机测试打包（D1）

```sh
pnpm pack:desktop
pnpm pack:desktop --native-dmg # macOS 显式使用系统 hdiutil 封装测试 DMG
pnpm pack:desktop --dir        # 仅应用目录，不作为系统安装器验收
```

默认先运行 `verify:desktop`。`--no-verify` 仍构建，但记录 `verification=skipped`，仅用于调试。每次输出到独立的 `.workbuddy/desktop-pack/<version>-<os>-<arch>-<uuid>/`；不要把脏工作区的测试包当作某个提交的正式候选。`--candidate` 仅接受固定仓库的签名 CI、干净提交和完整签名身份；缺证书返回 `SIGNING_REQUIRED`，普通本机环境返回 `CANDIDATE_CI_REQUIRED`。入口与证据格式见[桌面发布流程](desktop-release.md)。

打包使用锁定的 electron-builder 26.18.0 和已安装的 Electron 45.0.0，不另下载 Node 或调用系统 kpbl。`pnpm deploy --legacy --prod --offline --ignore-scripts` 生成独立生产树；离线失败时先正常完成冻结锁文件安装，不关闭供应链检查。只清理确实指向本次源桌面包的 legacy 辅助自链接，将同版本内部 `workspace:` 改成精确版本；改写清单用临时文件加 rename，避免硬链接污染源码。所有其它外部链接、缺失依赖或遗留工作区协议均阻断。

Renderer 和 Preload 构建按实际模块生成许可附件，上游预打包代码同时解析来源版本，通过精确版本的许可补充文件匹配；无法确认则保留 UNKNOWN/缺失，不借用当前安装版本。补充文件保留 npm tarball 地址与完整性值，Kumo 升级后须重新生成并审核，版本不匹配阻断构建。附件合并到生产依赖许可清单，并附 Electron 的 LICENSE 与 Chromium notices；附件保留原文与缺失标记，`licenseReviewPending=true` 始终表示仍需人工审阅，不能据自动生成宣称许可审核完成。测试包工具只继承必要环境，不继承模型、签名、发布凭证或 NODE_OPTIONS。

产品名、文件名和 About 均标明测试构建。`test-build.json` 记录完整源码 SHA、dirty、平台/架构、版本、验证状态、容器后端和逐文件 SHA256。当前版本沿用工作区 0.0.10，不提前升版。macOS 仅 ad hoc 签名，无 Developer ID、公证或 Gatekeeper 验收；`--native-dmg` 先由 builder 生成应用，再由系统封装 DMG，清单明确记录 `containerBackend=hdiutil`，不是默认 builder DMG 后端通过的证据。

macOS 打包后只读挂载 DMG，复制应用到临时安装目录，保留 framework 相对链接并拒绝副本外链；启动副本的实际二进制，使用隔离 home/userData 和受限 GUI PATH，执行审批后的真实文件工具，退出后移除应用副本并确认配置/历史仍在。Windows/Linux 当前只定义原生目标与副本 smoke，NSIS 安装/升级/卸载、AppImage 环境和其它架构均需对应平台实测；副本移除不等于系统卸载通过。命令不会安装到系统 Applications、上传或发布。

## 2. 先抽取哪些现有代码

| 当前入口 | 实施动作 | 必须保留的语义 |
|---|---|---|
| [local-host/resources.ts](../packages/cli/src/local-host/resources.ts)、[subagent-runner.ts](../packages/cli/src/subagent-runner.ts) | 抽取装配到 `host/managed-session.ts`，贯通父子会话的全部用户路径，保留延迟 MCP 挂载、取消和销毁 | 配置/信任检查先于历史句柄；失败装配也清理；runtime 和 session 清理成功后才释放句柄 |
| [host/presentation-store.ts](../packages/cli/src/host/presentation-store.ts) | 新增有序事件订阅，保留现有状态变化订阅 | 只发布 reducer 接受的事件；reload 推进代次；观察者异常不能中断工具事务 |
| [host/history-projection.ts](../packages/cli/src/host/history-projection.ts)、[host/session-presentation.ts](../packages/cli/src/host/session-presentation.ts) | 共用历史与实时身份、工具关联和公共脱敏 | 不从卡片标题猜 callId，不把最终消息再追加成重复卡片 |
| [host/task-observation.ts](../packages/cli/src/host/task-observation.ts)、[host/status-facts.ts](../packages/cli/src/host/status-facts.ts) | 对接会话观察快照及变化通知 | 父会话过滤、未知投递状态、未知用量保留；只读观察不执行收集 |
| [settings.ts](../packages/cli/src/settings.ts)、[model-bindings.ts](../packages/cli/src/model-bindings.ts) | 增加共享配置事务和窄服务出口 | 从原始全局配置写回，保留同组单份凭证、目录迁移和模型绑定规则 |
| [local-host/redaction.ts](../packages/cli/src/local-host/redaction.ts) | 抽取到 `host/redaction.ts`，让本地宿主和桌面共用 | 不导出原始凭证；流式跨块匹配与完整消息脱敏结果一致 |
| [Core 会话目录](../packages/core/src/context) | 贯通可选 maxReadBytes，包括元数据、升级、尾恢复与重载；增加 SessionManager 的精确根策略 | 超限不是尾损坏；拒绝前不改原文件；工具事务闭合仍可落盘；旧调用保留 Git 分桶行为 |

抽取后的 `/host` 导入本身不读终端、不注册全局监听、不创建 Session、不启动 MCP。显式传入已确定的绝对工作区根、homeDirectory、审批通道和同一个宿主级协调器；会话所有者负责资源释放，调用方不能拿到原始 Session 或 Provider 再绕开受管入口。

homeDirectory 统一派生父子会话的 `userInstructionsPath=<homeDirectory>/.kapibala/AGENTS.md`、`loggingDirectory=<homeDirectory>/.kapibala` 和 `auditRecoveryDirectory=<homeDirectory>/.kapibala/audit`，并与设置、历史、全局 Skill/MCP 的用户目录保持一致。现有 AgentSession 不会因 SessionManager 收到 homeDirectory 就自动获得这些路径，子代理执行器也必须新增传递；自定义 eventLogger 时仍显式指定审计恢复目录。不可用时失败，不回退到真实 home，不通过修改 HOME/cwd 补救。

原 `SessionManager` 即使收到 workspaceRoot 也会向上探测 Git 根；阶段 A 已按 004 第 3.2 节新增 `projectRootMode` 与解析函数的策略参数，共享装配使用 `exact`，本地协议适配器先保留原项目根检测。默认空间不走 Git 提升；列表、新建、打开与子会话沿用同一身份。该公开参数与 `/host` 一起纳入声明和兼容验证，不复制 projectKey 算法或迁移旧桶。

不要直接把 resources.ts 中的 wire `publicHistory` 作为桌面快照。它是既有协议的简化投影，不能提供桌面工具卡片所需的完整关联字段。本地 wire 1.0 适配器保留，桌面使用展示模型和自己的 DTO。

配置写路径至少核对 `saveGlobalSettings`、`trustProject`、`migrateGlobalSettingsCatalog`、`persistDefaultModel`、`persistModelRole`、向导和命令处理器。检索函数的所有引用及别名调用，不能只修改桌面设置页。锁内执行短同步变更，交互、网络请求和等待全部留在锁外。

### 2.1 阶段 A 的可用服务

`pnpm build` 现在包含 CLI `build:host`；`pnpm check-host` 检查独立产物、声明、终端依赖及隔离进程导入副作用，已加入 lint。完整构建后可运行下列 Node 装配（工作区和用户目录必须存在且为绝对路径，模型需已配置）：

```ts
import { WorkspaceLeaseCoordinator } from '@kiturone/kapibala';
import { createManagedSession } from '@kiturone/kapibala-cli/host';

const hostLeaseCoordinator = new WorkspaceLeaseCoordinator();
const host = await createManagedSession({
  workspaceRoot,
  homeDirectory,
  approvalChannel,
  leaseCoordinator: hostLeaseCoordinator, // 由宿主统一创建并注入全部父子会话
  maxReadBytes: 64 * 1024 * 1024,
});
const unsubscribe = host.subscribeEvents(onPresentationEvent);
const initial = host.snapshot(); // 同步建立订阅与快照水位
try {
  await host.run(input);
} finally {
  unsubscribe();
  await host.dispose();
}
```

`run` 完整消费 Core 事件并返回 Promise；外部只能读取已脱敏的 `snapshot()`、有序事件及 `status()`。`configure({ profileId, role, mode })` 只在空闲时接受，临时选择不写全局默认。`cancel()` 等待父子任务清理；`dispose()` 失败保留存储锁，可重试，不能把取消请求成功等同于进程已退出。

配置修改使用 `mutateGlobalSettings(draft => { ... }, { homeDir })`；回调只提交本次字段，不传旧表单整份快照。它会重读原始全局配置，且不物化整个内置模型目录。`SETTINGS_BUSY` 的错误包含锁路径：只有确认所有配置写入进程退出后才可人工处理遗留锁，不按时间或 PID 自动抢占。旧 CLI 和外部编辑器不参与新锁，勿同时编辑。

本地协议适配器保留 wire 1.0 的历史格式。上例没有实现桌面 DTO、IPC 队列、快照分块或审批界面，阶段 B 的 `packages/desktop/src/agent-host` 与 `shared` 已实现桌面适配，不改变 wire 1.0。阶段 A 的命令、回归和当前平台限制见 [验收记录](verification/v0.1.0-stage-a.md)。

## 3. 目录与依赖边界

```text
packages/desktop/
  src/main/          窗口、原生入口、发送者验证、Host 监督和 guard
  src/preload/       命名 API、订阅封装与内部传输，单文件 CJS
  src/agent-host/    会话、配置、审批、脱敏、展示传输
  src/shared/        DTO、运行时 schema、固定预算，无 Node/Electron 导入
  src/renderer/      React 页面、纯 ViewModel 与公开 DTO
  src/renderer/ui/   无现成 Kumo 组件时的领域组合
  src/renderer/stores/  presentation 展示状态与 ui 易失视图状态
  src/renderer/theme-kapibala.css  Kumo 语义 token 覆盖
  src/renderer/index.css           样式入口与导入顺序
  tests/            契约、状态、配置和生命周期单测
  e2e/              确定性 Provider、真实窗口和故障夹具
```

阶段 B 的实际模块为 `main/{index,supervisor,guard,preferences}.ts`、`agent-host/{index,desktop-host,workspaces,settings-service}.ts`、`shared/{contracts,rpc,transport,snapshots}.ts`，以及 Renderer 的 `App.tsx`、`settings-dialog.tsx`、`view-client.ts`、`ui-state.ts`。后续按领域增长再拆分，不为目录骨架复制状态。阶段 C 新增 `main/native-notices.ts`、`agent-host/latest-snapshot.ts`、`shared/observations.ts` 与 `renderer/{workspace-sidebar,message-list,message-markdown,details-drawer}.tsx` 与 `renderer/history-list-client.ts`，共享只读投影位于 CLI `host/inspection.ts`。

Main、Preload、Renderer、Agent Host 是四个构建入口。Preload 的有限 Electron require 不等于完整 Node；schema 依赖打包进单文件，不在运行时加载任意 npm 模块。类型检查分别使用各自 tsconfig，Renderer 不注入 Node 类型。

Renderer 的样式入口按 [004 第 6.1 节](design/004-v0.1.0-desktop-harness.md#61-确定的技术栈)固定顺序：`@source` 扫描 Kumo 产物，Kumo 样式先于 Tailwind 导入，主题文件覆盖语义变量，根元素 `isolation: isolate`，主题通过 `data-mode` 切换。这个顺序和 Kumo 版本一起构成 UI 启动契约，不能按个人习惯调整。

| 调用方 | 可以依赖 | 不允许的捷径 |
|---|---|---|
| Renderer | CLI `/view-model`、shared、命名桌面 API、Kumo、Phosphor、Zustand、`@tanstack/react-virtual`、react-markdown、remark-gfm | `/host`、Core、MCP、fs、Electron、`dist/*` 深路径、直连 `@base-ui/react` |
| Preload | 内联 shared、有限 Electron IPC API | CLI、Core、文件系统、向页面暴露端口或任意 channel |
| Main | Electron、shared、原生生命周期代码 | 执行工具循环、加载配置明文密钥、解析原始历史 |
| Agent Host | CLI `/host`、shared、受管装配 | CLI bin/index 启动入口、菜单、REPL、终端渲染器 |

UI 依赖按角色唯一，阶段 B 的基础断言集中在 `scripts/check-desktop.ts`；阶段 C 已补充应用动效约束、真实按钮状态对比度与减少动效断言：

| 角色 | 允许 | 禁止 |
|---|---|---|
| 组件与交互原语 | Kumo 及其导出的 primitives | Radix、shadcn/ui、MUI、Ant Design、Chakra、自写 focus trap 或 portal 管理 |
| 图标 | `@phosphor-icons/react` | lucide、heroicons、font-awesome、手写图标路径（品牌 logo 除外） |
| 动画 | Kumo 内置过渡，含 Sidebar 布局过渡；自写时使用同主版本 Motion 且仅动画 transform/opacity | 直装 framer-motion、react-spring、GSAP、Anime.js；应用源码新增 `transition: all` 或叠加同属性动画 |
| 布局与拖拽 | Kumo Sidebar、CSS Grid/Flex | 首版引入 react-resizable-panels 或 dnd-kit（无对应需求） |
| 状态 | Zustand 5（仅易失 UI 状态）、现有 ViewModel | 在 Zustand 复制消息、运行、审批或持久偏好，使用 `persist` |
| Markdown 与高亮 | react-markdown、remark-gfm、Kumo `CodeHighlighted` | 自写 Markdown 解析、Prism、highlight.js、直装 Shiki |
| 色值与形状 | `theme-kapibala.css` 中的 Kumo token，主操作底色与文字强调色分开 | 应用组件内十六进制色值、原始调色板类、`dark:` 变体、自定义圆角档位；依赖与高亮生成样式不按此源码规则误报 |

边界检查同时检查源码导入和实际 bundle 的依赖闭包，覆盖别名、动态导入和转导出。新增 `/host` 的声明与 JS 一起构建，并通过三包隔离安装验证；桌面安装包额外验证资源内的 utility Host 和 CJS Preload 可加载，不能依赖开发机 workspace 软链。

所有新增导出符号按根规则附简体中文 JSDoc，说明约束、失败边界和调用方责任。Core 不新增桌面依赖，不放宽现有架构门禁。

## 4. 契约先于界面

### 4.1 身份和回执

shared 先定义业务请求/响应、业务错误和通知的运行时 schema，然后由 Host 服务实现，再由 Preload 封装。类型声明只帮助编译，不代替 Main 的 sender/frame/source 校验和 Host 的资源归属检查。

| 标识 | 用途 |
|---|---|
| requestId | 关联本次传输请求与回复；超时不表示操作没有执行 |
| operationId | 一次明确发送的 run.start 去重；和载荷一起校验，超时后查询而不重发 |
| hostInstanceId / controlEpoch | 区分 Host 生命期与控制连接代次；旧控制请求无副作用 |
| workspaceId / sessionId / runId | Host 登记的资源归属，不能只校验字符串格式 |
| conversationId / branchId / viewEpoch / sequence | 展示身份和顺序，不能充当授权凭证 |
| transportSequence | 当前连接的传输接收确认，不能充当展示已安装的证明 |

首帧主题使用受限的 `initialTheme()` 引导：Preload 只同步取得 Main 内存中的 `light/dark` 枚举，Main 仍校验 sender、主 frame 和固定页面 URL；HTML 的外部启动脚本在模块与样式生效前应用枚举。普通业务全部走异步命名 RPC。此方式使保存深色后 reload 不再沿用旧 URL query 的浅色状态。

错误 DTO 使用稳定业务码、脱敏说明和可选定位 ID，不发送 Error 对象、stack 或 Provider 私有状态。`SETTINGS_BUSY` 表示锁未取得，`SETTINGS_CONFLICT` 表示确认内容已变化；两者均不自动覆盖重试。

64 个在途请求中为控制保留 16 个槽，普通业务最多占 48 个；接收 ACK 与业务完成分离，因此一个 `session.close` 等待清理时，不占住其它会话 `run.status` 的控制接收链。

`run.cancel` 返回已受理，settled 才表示清理完成。`session.close` 合并针对同一句柄的并发关闭，清理失败只重试未完成步骤；普通请求超时不释放执行门或会话锁。其它写操作超时也不能由通用 RPC 层自动重试，设置保存须重新读取事实确认结果。

### 4.2 快照、ACK 与独立停止

在注册增量缓冲与捕获快照水位的同一同步边界开始订阅。Renderer 暂存快照时不替换当前可见状态；完整校验后一次安装，再应用高于水位的连续增量。

传输协议需要分别表达接收与安装：

1. 接收分块后校验连接身份、snapshotId、块序号、编码字节数和累计预算。
2. 按连续 transportSequence 确认接收，释放该跳发送额度；Main 与 Preload 的转发队列同样受限。
3. 所有块完整且 DTO 校验通过后安装快照，再确认展示水位。
4. 缺块、溢出或代次改变时丢弃暂存，失效旧订阅并 resync；不重启 run。

必须用 5 至 8 MiB 快照验证 4 MiB 发送窗口能持续推进，不能等整份安装后才 ACK。预算按编码字节计算，覆盖中文和 emoji；不是按 JS 字符数或消息条数估计。

完整快照超限时禁用新发送，保留独立的 run.status 和取消入口。连续无效快照不得触发无限自动 resync；相同超限状态等待用户处理或重新订阅。Renderer 停止 ACK 时，Host 仍能取消工具并落盘。

### 4.3 观察、设置和信任

`session.inspect` 返回状态事实、Skill/MCP 诊断和当前父会话的直接子任务摘要，`session.inspectionChanged` 返回带递增 revision 的新快照。页面先订阅通知再读取初始快照，按 revision 丢弃旧数据，避免读取与订阅之间遗漏变化。观察订阅绑定展示订阅的生命周期；重复订阅不能累积监听器。

侧栏与全局状态使用独立的 `session.runtimeSubscribe/runtimeUnsubscribe` 和 `session.runtimeChanged`，不依赖上述详细展示订阅。初始快照与订阅在同一同步边界建立，后续完整快照按控制身份和 revision 替换；合并允许跳号，不套用展示 delta 的连续序号检查。每个控制连接只有一个此订阅，至多 8 个已打开会话、每份至多 64 KiB、仅保留一份待发最新快照。字段限于资源定位、runId、阶段、结果、审批数量及清理状态，不承载正文；切换空间、关闭详情或退订旧消息列表均不影响它。失效时标记状态未知并重新订阅，不能显示旧的可信空闲状态。

该接口只读当前已知状态，不能为了填充“在线”启动 MCP 或探测进程。子任务来源分支和投递状态沿用 TaskObservation；关闭订阅不执行收集、ACK 通知发件箱或取消任务。观察摘要可标记截断，原始历史不能因此改写。

设置页从现有模型目录和厂商元数据生成，不硬编码第二份清单。协议、端点或 apiKeyEnv 改动另存 Profile；预览确认令牌由 Host 持有相关原始值，Renderer 只持有随机令牌和公开元数据。同组密钥值被替换但来源标签不变，也必须返回冲突；无关字段更新则按字段合并。

阶段 B 的确认对话框展示配置 URL 与实际生效 URL 的区别、目标分组及来源；用户明确选择复用、新输入密钥或免鉴权后才提交。令牌仅存在当前 Host 控制对象中，30 秒过期、最多 64 个，绑定草稿、实际环境端点、相关密钥与当前项目配置。`editId` 不授权覆盖另一个已存在的目标 ID；另存的新 ID 不继承原端点内联密钥。新密钥确认明确说明同组替换影响。侧栏标题脱敏同时纳入当前项目和全局凭证。

工作区 ID 绑定规范化根目录，信任确认、会话打开和 run 受理时复核 native realpath。选目录与授信分开；未信任前不应用项目配置或启动项目 MCP。GUI PATH 缺少命令时给出具体诊断，不自动运行登录脚本或安装工具。

`workspace.openDefault` 不接受路径，由 Host 按显式 homeDirectory 创建约定目录，返回与项目空间相同的登记信息和信任状态。默认目录的创建、重定向拒绝、共享文件边界及会话归属规则以 [004 第 2.1 节](design/004-v0.1.0-desktop-harness.md#21-空间与会话归属)为准；执行前同样登记 guard。默认空间在首次创建时把信任写入全局记录（与 CLI 共用 trustedProjects），因此登记为已信任而无需再次确认；这是同一份全局信任语义，不是绕过检查。不要把当前项目失效变成默认空间中的一次自动发送。

### 4.4 UI 落地约束

布局、尺寸和主题 token 统一取 [004 第 6.3 节](design/004-v0.1.0-desktop-harness.md#63-对话式-ui-与交互)，不另维护一份 UI 方案。阶段 B 先做白底两栏对话、空间入口与紧凑工具状态；阶段 C 补完整分组、按需详情抽屉、状态观察，以及主题对比度与减少动效完整验收。右侧抽屉初始关闭，长内容在抽屉内滚动，不通过扩大主页面解决。

界面层级与留白节奏的增量约定见 [006 桌面视觉精修](design/006-desktop-visual-refinement.md)：它在不改 004 章节编号与布局骨架的前提下细化 token 档位、轮聚合、执行组、composer 单卡和设置左导航。两者冲突时以 004 的结构决策为准，006 只解释执行细节。

写任何界面前先查 Kumo 是否已有对应组件或 primitive；有现成实现时禁止自写等价行为，尤其是焦点约束、Escape/外部点击关闭、portal 层级、滚动锁定、组合框过滤、Toast 队列和复制反馈。没有现成组件时才在 `renderer/ui/` 组合领域组件，并在文件头注释写明缺口。主题只改 `theme-kapibala.css`，不在组件内写色值。

“添加项目”先打开“创建项目”表单：项目名称（1–80 字符，不含控制字符）、只读设备“此电脑”、原生源文件夹选择区、取消与创建按钮。名称仅作为客户端显示别名，不改目录名；目录物理根仍是唯一身份，同根最近项目复用稳定入口。选择目录不写最近项目、不读取项目配置、不创建会话。点击创建时刷新信任状态；未信任目录再打开“信任此文件夹吗？”对话框，展示最终物理根与权限说明。取消信任返回原表单，保留名称与目录；明确同意后才由 Host 校验 token、登记信任并保存项目入口。已被 CLI 撤销的信任不得凭旧 UI 状态恢复。打开最近项目或重载时恢复别名，不自动请求模型。双层弹窗的焦点、Escape 与滚动仍由 Kumo LayerDialog 管理。

工具选择只保存当前 workspaceId、sessionId 和 callId；会话切换关闭旧详情，迟到通知仍按完整身份处理。草稿和滚动位置按会话暂存于 Renderer 内存，关闭详情不销毁会话。审批提示不依赖抽屉打开，模态设置与覆盖抽屉提供焦点约束、Escape 关闭和焦点返回，这些行为来自 Kumo 原语，不在页面里重写。

详情并排时使用 Dialog 的 `modal={false}`、`disablePointerDismissal={true}`，点击或 Tab 到输入框不关闭；覆盖时使用 `modal={true}`、`disablePointerDismissal={false}`，允许遮罩点击关闭。两者均保留 Escape、关闭按钮和焦点返回；跨断点只更新界面策略，保持会话、详情身份与草稿。审批的会话级选项显示为“本会话允许相同调用”，只在 `sessionAllowed=true` 时提供；Host 再次校验，不能把它实现成永久授权。

已打开会话的行菜单提供“关闭运行时”，运行中则提供“停止并关闭”；关闭等待完整清理，失败保留占用并提供重试。达到 8 个句柄时显示已用数量和空闲会话列表，由用户明确选择关闭，不自动驱逐；关闭句柄保留历史，重新打开仍走装配检查。

primary 按钮沿用 Kumo 固定白字，按参考截图采用黑色底色；深色主题用灰白文字与焦点表达强调。危险按钮采用 `secondary-destructive`；所有 Kumo 按钮复用主题文件中的 `kapibala-action` 类，以 focus token 补统一的 2px outline 和 2px offset，不依赖库内部选择器或另写交互。测试实际普通、悬停、焦点和按下状态的对比度，不能只算原始 token。应用自写动画限于 transform/opacity，Kumo Sidebar 内置尺寸过渡按明确例外保留；减少动效时将其 `animationDuration` 设为 0。静态检查只限制应用源码新增实现，不因依赖内置渐变、布局过渡或高亮生成色值误报。

`preferences.read/update` 由 Main 处理，主题只保存 `light/dark/system`，缺省 `light`；Main 同步 nativeTheme 和窗口初始背景，Renderer 在首帧前写入 `data-mode`。最近空间重新登记，不复用旧 workspaceId。全部七类弹窗采用 440/500/600px 三档宽度，长内容限高 560px 并内部滚动；在 800px 最窄、600px 最低及组合窗口下检查可用性。模型设置保存后，下次 run 刷新当前绑定的配置和凭证，保留该运行时会话选中的模型与角色，不被新全局默认覆盖。文案按 004 第 6.3.4 节的术语与句式写，按钮动词开头，错误写原因和下一步。


### 4.5 阶段 C 的实际行为

空间按 Main 登记身份聚合，默认置顶，项目按最近使用顺序排列；同名项目以 `recentId` 区分并显示父路径。历史每页 50 项，后台刷新保留各空间当前页，迟到列表回复不能覆盖新选择；运行中的未落标题会话也可定位。草稿和阅读位置以 `workspaceId:conversationId` 存于 Renderer 内存；打开句柄 ID 改变不丢草稿，刷新不承诺恢复草稿。显式关闭保留历史，清理失败保留句柄占用并禁止再次运行、配置或重新打开，需重试清理。

`session.configure` 返回 Host 实际生效的 Profile、角色与模式；页面不根据所点角色猜测模型。`session.inspect` 及其变化通知只观察已有状态，每类列表至多 32 项、文本有界净化与脱敏，超额显式标记；订阅随展示订阅释放。后台摘要每个控制连接独立一份，通过数据通道发送，控制通道仍保留停止容量。两类观察收到失效后丢弃迟到快照，仅新订阅可恢复。

TanStack Virtual 渲染可见消息；向上阅读停止跟随，返回底部恢复。Markdown 使用 GFM，禁用 HTML 与远程图片加载，代码高亮及复制由 Kumo 提供，不运行代码。仅受校验的主页面允许 `clipboard-sanitized-write`，拒绝剪贴板读取和其它浏览器权限。详情大于等于 1200 宽时并排、非模态，点击或 Tab 到输入区保持打开；窄窗口覆盖并锁定焦点，遮罩/Escape 关闭。触发工具行卸载后焦点回到稳定的消息滚动区。

状态、Skill/MCP 与直接子任务全部来自共享宿主，观察不会启动 MCP、收集子任务或确认投递。当前运行累计只汇总明确的 Provider usage；任何请求缺失用量时显示未提供，明确返回零仍保留零；上下文估算标记独立显示。

通知只在窗口后台时显示通用完成/待审批说明，不包含空间路径、工具参数或会话正文。点击仅唤回窗口；关闭句柄、审批过期或控制期更换后旧回调失效，不发送审批决定或重放任务。macOS 通过 Dock 恢复；Windows/Linux 尝试创建托盘；Windows 创建成功后关窗隐藏，失败时确认退出。Linux 不能仅凭 Tray 对象确认系统展示了入口，因此关窗始终先确认清理退出。退出必须等待 Host 清理，失败保留 guard 和应用入口。

About 读取实际应用/运行时版本、平台与通知/托盘支持状态，复制诊断不包含配置、凭证、原始错误栈或进程输出。主题保存 light/dark/system，真实窗口检查 Kumo 主按钮正常/悬停/键盘焦点/按下状态；主按钮边界使用语义 focus token。减少动效时覆盖库默认动画/过渡时长为 0，静态门禁只检查应用源码，不将依赖实现误判为应用新增动画。

## 5. 生命周期实现顺序

应用取得单实例锁后先检查 guard。不存在 guard 才按正常启动创建；已有、损坏或不可读的 guard 都进入恢复提示，不能将其视为可重置的 UI 偏好。

| 触发 | 必须完成的动作 | 不能作出的结论 |
|---|---|---|
| 用户停止 | 取消父 run 与活跃子任务，等待工具清理和工具结果落盘 | cancel 受理就表示已停止 |
| Renderer 崩溃/控制断连 | 撤销控制代次和审批，Host 继续清理；新页面重新订阅事实 | 页面重建可以重发旧用户输入 |
| 关闭会话 | 关闭 runtime、销毁 session，前两者成功后释放历史句柄 | 关闭 UI 卡片等于释放独占锁 |
| 应用退出 | 停止受理、撤销审批、清理全部资源、确认 Host 正常退出，再清除 guard | 10 秒提示阈值可以当作清理成功 |
| Host 崩溃/强制退出 | 保留未知状态和 guard，要求人工核查；明确确认后才创建新 Host | Host 进程退出证明所有后代已退出 |

正常隐藏、最小化和切换项目不销毁控制连接。Main 监督代码集中处理退出事件和清理承诺，避免菜单、托盘、窗口 close、Cmd+Q 各实现一套退出逻辑。

生产 Host 显式使用 `stdio: 'ignore'`；可见诊断经过 Host 的公共脱敏出口。不把原始 stdout/stderr、配置解析异常或请求头转存为“诊断日志”。隐藏推理和签名不进入 Renderer。

## 6. 开发批次与验证

按 004 的 A 至 D 阶段推进，每批在正常路径之外覆盖一个真实失败分支。下面列出持续验证要求；已执行的本地结果见阶段 A/B/C 验收，平台 pending 不视为通过。

| 批次 | 交付与验证重点 | 对应门禁 |
|---|---|---|
| A：共享宿主 | 导入无副作用、失败装配释放顺序、父子会话显式用户路径、CLI 配置写路径、两进程更新、历史超限、exact 根与旧 Git 分桶回归 | pnpm verify、公共 API、兼容验证、隔离安装；真实用户目录无访问断言 |
| B：最小闭环 | 默认空间与项目空间的真实信任/设置/新建/恢复/发送/审批/取消；白底两栏对话；四入口可构建；Tailwind v4 与 Kumo 的扫描、导入顺序和首帧主题；guard 与全部基础传输预算同时交付 | G-DESKTOP-FLOW、IPC、STATE、CONFIG、LIFECYCLE 的基础用例；UI 依赖检查 |
| C：完整体验 | 后台摘要与句柄回收、空间并行、两种详情策略、草稿、任务观察、长列表、输入法、三态主题与通知；状态对比度、减少动效、持续恢复及拥塞下取消 | D01 至 D13；RENDER 与 SOAK 夹具；主题与依赖唯一性门禁 |
| D：平台交付 | 安装包依赖闭包、原生入口启动、签名、公证、卸载保留数据、最终候选附件审核 | PACKAGE、桌面 SOAK、原六类发布证据 |

优先建立以下回归夹具：

- 一个短脚本启动两进程更新隔离配置：不同字段都保留；同组密钥预览失效；锁、临时文件和 rename 失败不覆盖旧文件。
- 可控传输模拟逐跳暂停 ACK、重复/越界 ACK、乱序、迟到旧代次消息；再用真实 Electron MessagePort 验证 5 至 8 MiB 快照与停止通道。
- 工具夹具记录开始、完成、取消和清理，并生成真实子进程树；取消后检查历史事务闭合，完成工具保留成功结果。
- 在真实 Electron 中分别终止 Renderer 与 Host，覆盖 guard 损坏、重启和强制退出，不靠 mock 的 exit 回调证明后代清理。
- 三个模型协议的确定性本地 Provider，覆盖正文、思考、工具、拒绝、断流、迟到事件和写盘失败。夹具服务只用于测试，不进入生产桌面架构。
- 隔离 home 设为 Git 仓库：默认根、projectKey、历史头、执行 cwd 和租约保持约定目录，列表与重新打开不漂移；另测不可写、文件占位、符号链接/目录联接重定向和拒绝信任。默认空间两会话共用文件，项目空间不混入其历史；旧 CLI/SDK 的分桶测试保持不变。
- 真实窗口覆盖 1280 × 800、最小宽度、最小高度及 800 × 600 组合，以及 960/1200 断点两侧：初始无详情空列，打开/关闭抽屉不影响运行，切会话不串工具，审批提示仍可达。输入法、长路径与代码、草稿、滚动、焦点返回一并检查。
- 主题覆盖首次白底、显式深色、跟随系统、运行中系统切换和冷启动恢复；同时验证全局默认变更不替换已打开会话模型，新会话使用生效默认，项目覆盖有来源提示。
- 父子会话创建、运行、审计恢复和清理均使用显式隔离目录；通过文件访问记录断言真实用户的 `.kapibala` 与 `.agents` 未被读取或写入，不能仅靠测试前后文件哈希相同证明没有读取。
- 并排详情打开后点击和 Tab 到输入框仍保留详情；覆盖详情能点遮罩、Escape 关闭并返回焦点。分别测试 sessionAllowed 的真假、精确相同调用缓存、句柄关闭后授权失效及伪造会话级批准。
- 退订后台会话详细展示后使其完成、失败或等待审批，侧栏仍更新；摘要 revision 合并跳号不误触发缺口恢复。打开 8 个句柄后第 9 个被拒绝，显式关闭空闲句柄可继续打开，清理失败不能释放占用。
- UI 静态门禁检查应用源码的依赖、样式导入、色值、`dark:` 变体及新增动画，不扫描依赖或高亮生成样式来判定此类违规；实际 bundle 仍检查依赖闭包。真实渲染覆盖 240px 侧栏、57px 图标列、360px 抽屉，实测主按钮各状态文字至少 4.5:1、焦点至少 3:1，并验证减少动效时 Sidebar 不执行尺寸动画。

E2E 在 app ready 前设置隔离 Electron userData，在任何 Host、Session 或日志器创建前注入隔离 homeDirectory 及其全部派生用户路径，各测试使用独立临时项目。清除或替换真实 Provider 环境凭证，隔离全局指令、Skill/MCP 配置、日志和审计恢复；本地夹具不访问付费 API。真实用户目录的无访问断言覆盖父会话、子代理和异常清理，不靠替换进程 HOME 或只隔离 SessionManager 通过。测试结束关闭窗口、Host、工具后代和订阅，失败时也执行清理并保留证据。

根 `pnpm verify` 仍按 typecheck → test → lint 执行，补入桌面静态检查和单测；Vitest 排除 Playwright 用例。E2E 与安装后 smoke 单列，避免将无界面 CI 的通过当成桌面交付完成。Windows、macOS、Linux 在各自平台运行，Linux 使用图形测试环境，不能添加 `--no-sandbox` 消除启动错误。

## 7. 提交前与正式交付

开发提交前核对本批改动、CLI 回归、公共导出声明、桌面入口和实际失败路径。只改文档时检查相对链接、术语及待实现标记即可，不将文档静态检查记作产品验收。

新增依赖只进入需要它的包；`packages/*` 已被 workspace 覆盖，不额外修改 glob。Renderer 新增任何依赖前先确认 Kumo 是否已覆盖该角色，然后更新 004 第 6.1 节选型表并审许可证、包体与运行时影响；同一角色出现第二个库即停止并回到设计。不把库源码复制进仓库，确需修上游缺陷时只用 `pnpm patch`，同时记录 upstream issue 与移除条件。Electron 下载/安装脚本按 pnpm allowBuilds 单独授权；不要全局允许依赖构建。具体版本在实施时核对支持范围并锁定，本指南不预写未验证版本号。打包时生成第三方许可证清单，并确认没有把 Kumo 的 Cloudflare 品牌组件、示例页或演示资源打进应用。

正式发布继续使用 [发布证据](release-evidence.md)和 004 第 11 节流程：升版提交完整 SHA → 人工推送 main 并等待 Verify → 候选签名构建 → 逐平台安装验收及哈希审核 → 人工推送标签 → 验证并发布同一批附件。Release 不重新构建桌面包，desktop 保持 private，npm 仍只有原三包。

实施时同步 SDK 兼容性、迁移说明、验收记录和发布说明，明确旧 CLI 不参与新配置锁、CLI 与桌面无跨进程工作区租约、异常退出后需要人工检查。未完成的平台、签名或长跑项目保留 pending，不能用文档勾选代替证据。

参考机制与固定源码提交见 [004 第 12 节](design/004-v0.1.0-desktop-harness.md#12-开源参考与取舍依据)。Electron 的 [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process) 默认继承标准输出流；[MessagePort 文档](https://www.electronjs.org/docs/latest/tutorial/message-ports)说明端口传递与关闭语义，应用仍需自行实现本指南中的预算与确认机制。
