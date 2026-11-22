# 📝 版本发布与路线图 (RELEASES)

> 本文档承载 Kapibala 的版本号规则、各版本既有能力增强明细与版本路线图；
> README 只保留入口链接。版本规则于 2026-10-21 按用户要求调整：三段版本均允许多位非负整数，
> 不允许前导零；默认只递增补丁段，`v0.0.9 → v0.0.10 → v0.0.11`，不逢十进位。
> 稳定整合版由原规划 v0.1.0 调整为 **v0.0.10**，Electron 桌面客户端由原规划 v0.1.1 调整为 **v0.1.0**；
> 次版本/主版本通过发布命令显式选择。已发布版本与历史验收记录不重命名。
> 2026-11-01 确认规划：双主题补丁位版本（桌面端 v0.1.0 之后）——跨会话消息引用与上下文复用、多任务派发（后者见 [设计 005](design/005-v0.1.1-multi-task-delegation.md)）。
> 2026-11-15 调整：v0.1.1 让位给 v0.1.0 的桌面四平台打包修复，v0.1.2 让位给 Windows 安装副本连接挂死修复（8.3 短名 ~ 的 URL 编码不一致，见 v0.1.2 发布说明）；双主题规划**顺延为 v0.1.3**；设计 005 的文件名与文内版本号不改名，避免破坏交叉引用。

---

## ✅ v0.0.1 既有能力增强（已完成）

以下工作已作为 v0.0.1 既有能力增强完成，不占用后续版本的新增能力范围：

- **请求与会话指标**：统一请求结束底栏与 `/status` 的统计口径；默认按 Git 分支、总耗时、上下文占用、本轮 Token、工具次数/耗时排列，`--debug` 追加模型耗时与 TTFT。
- **上下文窗口配置**：`ModelProfile.contextWindow` 支持整数与 `K/M` 简写，缺省按 `1M` 估算展示；内置模型使用目录中配置的真实窗口。
- **工具调用展示**：内置工具映射为面向用户的 `Read` / `Search` / `Write` / `Edit` 动作名，执行状态原地更新、参数脱敏与稳定截断；非 TTY 输出单条无 ANSI 记录。
- **工程加固**：跨平台开发入口、PathSandbox 与扩展底座测试补齐、Headless Core 架构门禁、文档状态约束（“已实现 / 待增强 / 未来版本”严格区分）。

> 上下文压缩状态不在 v0.0.1 伪造占位数据；等 v0.0.3 的压缩机制落地后，再由真实的压缩次数、摘要覆盖范围和最近压缩时间驱动展示。

---

## 🗺️ 版本路线图

| 版本 | 阶段重点 | 核心能力与扩展点 | 交付形态 |
|:---:|---|---|---|
| **v0.0.1** | **核心骨架、交互 CLI 与既有能力收尾**（已完成） | OpenAI 兼容协议、Slash 命令、首次配置向导、PathSandbox、崩溃历史自愈、请求级指标与上下文占用、Headless Core 架构门禁、跨平台一键开发脚本 | CLI (`kpbl`) + Core SDK |
| **v0.0.2** | **可信执行与项目指令**（功能已实现；[发布说明](releases/v0.0.2.md)） | 默认结构化运行日志与逐工具审计、四态 `SessionMode`、执行前授权与人工审批、结构化工具错误、多层 `AGENTS.md`；`run_command` 默认注册，解释器发现只用 `PATH` 与运行时探针（native Bash → WSL → PowerShell 兜底），每条命令仍单独裁决；`FullAccess` 只能在本次会话显式选择 | Core + CLI 增量 |
| **v0.0.3** | **历史会话、消息生命周期与上下文管理**（已发布；[发布说明](releases/v0.0.3.md)，[验收记录](verification/v0.0.3.md)） | 以 Pi 会话投影与滚动摘要为主体：独立版本化 JSONL、稳定 ID、SessionManager、历史列表与分支提示，默认新建及显式恢复；规范完整工具事务；保守读取/搜索结果剪裁 → 增量摘要，借鉴 Codex 恢复一致性，各级先提交后激活；摘要首尾截断与总预算、真实文件操作详情、可恢复失败熔断、稳定序列化与效果实测；完整保护当前任务和最近成功交互，超限停止，任务内部压缩后续再做；Core 六大领域重构及命令统一 | Core + CLI 增量 |
| **v0.0.4** | **多协议与场景模型路由**（已发布；[发布说明](releases/v0.0.4.md)，[验收记录](verification/v0.0.4.md)） | Anthropic 原生 Messages、OpenAI 原生 Responses、现有 Chat Completions 兼容层加固；共享合法历史与完整工具事务，扩展 `default` / `summary` 路由并落地 `fast` / `planning` / `execution` 显式场景选择，提供结构化思考事件基础；小模型意图分类留待后续 | Core + CLI 增量 |
| **v0.0.5** | **技能体系与过程输出折叠**（已发布；[发布说明](releases/v0.0.5.md)，[验收记录](verification/v0.0.5.md)） | 有界 SkillRegistry、按需加载、受控资源、来源落盘与只收紧权限；`/skills` / `/skill`、技能名 Tab、Ctrl+O、完整详情重定向；[迁移说明](migration/v0.0.5.md) | Core + CLI 增量 |
| **v0.0.6** | **MCP 生态扩展**（已发布；[发布说明](releases/v0.0.6.md)，[验收记录](verification/v0.0.6.md)，[迁移说明](migration/v0.0.6.md)） | 独立包接入 Stdio 与 Streamable HTTP；工具按 source 原子上下线、run 稳定声明与即时撤销，启动和调用分别授权；Prompt 可搜索并由固定 `/prompt` 入口调用；缓存压缩专项另行排期 | `@kiturone/kapibala-mcp` |
| **v0.0.7** | **会话增强与多智能体**（已发布；[发布说明](releases/v0.0.7.md)，[验收记录](verification/v0.0.7.md)，[迁移说明](migration/v0.0.7.md)） | 基于 v0.0.3 的独立会话、Envelope 因果 `parentId` 与基本 SessionManager，增强跨项目全文检索、历史分叉（DAG 树）、归档与子代理任务树观测；清理 Core 对全局 `process.cwd()` 的隐式依赖，强制显式 `workspaceRoot`；再接入 `spawn_agent`、父子追踪和角色模型绑定，子代理权限只继承或收紧。Worktree 物理隔离、审批冒泡与任务树 Token 分层账本明确未交付 | Core + 宿主增量 |
| **v0.0.8** | **产品化终端体验**（已发布；[发布说明](releases/v0.0.8.md)，[验收记录](verification/v0.0.8.md)，[迁移说明](migration/v0.0.8.md)） | 现代终端守护（ConPTY/CSI-u 拼包、Bracketed Paste 隔离、异常自愈恢复）、共享前端纯展示模型（`@kiturone/kapibala-cli/view-model` 导出，0 Node 依赖，WeakMap 缓存）、宿主桥接中枢与防抖分发、全量 Slash 命令结构化解耦（CommandOutput 统一输出，check-cli-boundary 门禁）、多任务状态观察（subscribeTaskChanges） | CLI 内部模块增量，不新增包 |
| **v0.0.9** | **本地客户端契约与发布前加固**（已于 2026-10-21 发布；[发布说明](releases/v0.0.9.md)，[验收记录](verification/v0.0.9.md)，[迁移说明](migration/v0.0.9.md)） | 版本化 wire DTO、双向审批与控制信令、本地守护进程和受控本地传输（面向 CLI / Daemon / 桌面 IPC 通用通信契约）；已实现有界快照、审批与宿主隔离；Linux 与 Windows CI 全量门禁已通过，Windows ACL/进程树与 Node 20 等平台验收仍待补齐。桌面/Web/移动多端及远程传输待契约稳定后逐步交付 | Core + 本地宿主适配 |
| **v0.0.10** | **阶段性整合版本**（已于 2026-10-23 发布；[发布说明](releases/v0.0.10.md)，[技术方案](design/003-v0.0.10-stable-integration.md)，[验收记录](verification/v0.0.10.md)，[迁移说明](migration/v0.0.10.md)，[SDK 兼容性说明](sdk-compatibility.md)） | 稳定已交付的 Core 公共 API、事件协议和本地客户端契约：显式工作区身份、宿主级写租约与父子协调器传递、类型化错误与取消语义、按方法具体化的客户端结果与整个连接的恢复单位；新增 `verify:compat` / `verify:platform` / `verify:soak` 三类门禁。不新增客户端类型或运行时子系统；Node 20、Windows 跨用户 ACL/ConPTY、POSIX PTY、双解释器进程树及 release 长跑已在同一发布 SHA 上通过并获维护者审核 | CLI + Core SDK + 扩展包 |
| **v0.1.0** | **桌面 Harness（Electron；2026-11-14 以未签名个人自用版发布，[发布说明](releases/v0.1.0.md)）** | 基于现有 Core、MCP 与共享 ViewModel，采用单个 utilityProcess Agent Host、受控 IPC 与 React 界面；交付项目/模型配置、历史对话、工具展示、审批取消、多会话（重命名/置顶/归档/删除）及 macOS arm64 测试包；签名与公证**不是 v0.1.0 发布前置**（见下节），详见[功能与开发方案](design/004-v0.1.0-desktop-harness.md)与[视觉精修](design/006-desktop-visual-refinement.md) | 私有桌面应用包 `packages/desktop`，不新增 npm 发布包 |
| **v0.1.1** | **桌面四平台自动打包修复**（已于 2026-11-15 发布；[发布说明](releases/v0.1.1.md)） | 未签名测试包改由 `release.yml` 的 `desktop-unsigned` 作业在四个原生 runner 上自动生成并上传同一 Release，另有 `desktop_only` 手动补跑入口；修复三处干净机器才暴露的打包缺陷（`--offline` 解析不了 registry 元数据、工作区成员名单硬编码、Windows e2e 路径断言）。实际交付 mac arm64 / mac x64 / Linux x86_64 三平台，Windows 安装副本 smoke 在全新安装首启时超 30 秒被判死连接（v0.1.2 修复） | 桌面发布链路增量，无新功能 |
| **v0.1.2** | **Windows 安装副本挂死与受限 PATH 阻断修复**（已于 2026-11-15 发布；[发布说明](releases/v0.1.2.md)） | 修复两个确定性失败：① 8.3 短名 `~` 的 URL 编码不一致致控制端口永不投递（`normalizeUrl` 比较前统一规范化）；② 受限 GUI PATH 下 `detectShell` 抛错阻断 `session.create`（宿主 `registerBuiltinTools` 解释器降级为惰性 fallback）。另含冷启动握手兜底 30s→90s、preload 故障投递修正、Release 附件命名简化与 smoke 诊断产物。⚠️ npm 三包在 shell 修复前发布且不可覆盖，Release 四平台安装包已用修复提交重建（tag 前移），修复随 v0.1.3 进 npm | 桌面 + 宿主修复增量 |
| **v0.1.3** | **跨会话引用、可续聊委派与桌面模型管理**（已于 2026-11-20 发布；2026-11-16 按 `aigc` 开源副本逐条核实后重排，见[设计 007 §0](design/007-v0.1.3-cross-session-reference-and-delegation.md)；分支 Verify 全绿，run [44698746827](https://github.com/tedburner/kapibala/actions/runs/44698746827)；Release run [44711148909](https://github.com/tedburner/kapibala/actions/runs/44711148909) 发布 npm 三包与四平台桌面测试包） | 交付分 **MVP + 增强项** 两档：MVP = 引用 CLI 闭环（R0.1–R0.4、R1.1）+ 派发 Core/CLI（D0.1–D0.3、D1.1–D1.2、D2.1、D4.1 最小保留：上限 20 + 手动删除）+ 工具显示名与行结构（U1.1、U1.2；U1.4 无 hover 兜底为准 MVP）；增强项失败只回退该项、不阻塞发布（压缩降级、`branchWithSummary`（可能再次顺延，不作承诺）、桌面 mention、桌面委派可见化、D4.2 LIFO 淘汰与闲置清理）；工具行增强组 U1.3 / U1.5 / U1.6 **整组判定**，未完成则整组顺延 v0.1.4，U1.7 与 D3.2 绑定随后者版本发布。跨会话引用：同项目桶内把其它会话（含本会话其它分支）的历史消息作为冻结快照引入当前会话，宿主经 `runPreparedTask` 注入带溯源头的引用块（源会话 + `recordId` + 角色 + 时间戳 + 正文片段）并随 user 消息落盘，Core 新增只读不取锁的会话读取 API，CLI `/quote` 已交付，桌面端 mention 弹层与 `branchWithSummary` 属增强项、未交付；多任务派发：委派会话升级为用户可见、可续聊的一等会话（`spawn_agent` detached 保留预算、`send_agent` 续聊、requestId 幂等、「委派名 · 父会话名」命名），CLI `/delegate` `/delegations` 用户级派发与委派会话面板已交付，桌面委派可见化（D3.x）未交付；单条/单轮引用预算上限与压缩投影保留溯源头已交付，压缩降级未交付；共享件：工具显示名统一（宿主层 `host/ui/tool-presentation.ts` 显示名表，经 `ViewTool.displayName` 下发，CLI / 桌面 / `/mcp` 同口径，新增内置工具漏登记即门禁失败），并完成工具行信息层级与无 hover 操作兜底（U1.2 / U1.4）；结果预览与失败态、动词加对象 chip、运行耗时与最后活动（U1.3 / U1.5 / U1.6）完成则交付，否则整组顺延 v0.1.4，子代理嵌套内联（U1.7）跟随 D3.2。另携带 v0.1.2 的 shell 兜底修复进 npm（消除 tag/npm 分叉）。跨项目桶引用、活引用、跨 Harness 托管、Worktree 隔离、编排画布明确未交付。另随本版分支交付：设置页厂商分组与模型级启停（测试连接 / 启用停用 / 删除，Ollama 默认停用）、桌面 HTML 预览与 Markdown 图片渲染、会话锁自愈（pid 复用识别与死锁清扫）、host 模型探测、Auto 模式只读命令放行与会话级批准缓存、shell 大输出迁全局受管目录（`~/.kapibala/tool-results/`，项目目录零运行时产物）、沙箱只读豁免、CLI 启动优化与 dev userData 隔离；本地 wire 保持 1.0 | Core + CLI + 桌面增量 |
| **v0.1.4** | **会话级监视、资源管理、右侧信息面板、任务面板与权限重做（七份设计 / 五组）**（已在 v0.1.4 分支实现，未发布；2026-11-22 全量代码评审问题已修复并补回归，历史评审快照见 [评审记录](verification/v0.1.4-code-review-2026-11-22.md)；七主题全量纳入本版，2026-11-20 维护者确认；**版本级设计：[014](design/014-v0.1.4-version-design.md)（定稿）**，七份主题文档已按 014 同步为**终审稿**：[008](design/008-v0.1.4-session-watch.md)、[009](design/009-v0.1.4-skills-management-and-import.md)、[010](design/010-v0.1.4-session-evidence-dashboard.md)、[011](design/011-v0.1.4-mcp-management-and-release-updates.md)、[012](design/012-v0.1.4-artifact-preview.md)、[013](design/013-v0.1.4-task-panel-and-composer-status.md)、[016](design/016-v0.1.4-permission-model-rework.md)；本地 wire 改为整数 `PROTOCOL_VERSION = 2` + 能力集合（旧 `{major,minor}` 客户端握手即失败）；2026-11-16 维护者决策：MCP 管理与分发更新（GitHub Releases 通道，不走签名链路）统一并入本版；2026-11-20 维护者追加右侧产物预览与任务面板；2026-11-20 按推荐全部拍板协议整数版本、监视水位、持久化 diff 事实、MCP 逐服务器批准、预览固定允许根。统一归纳、依赖与推进顺序见下方「v0.1.4 统一规划」） | 主题一「会话级监视」：把「等外部条件」从模型轮询升级为宿主侧监视 + 完成通知驱动续跑——新增全局控制记录 `watch_state`（五处同步、重启可恢复），两类触发源（文件变化 / localhost 端口就绪；设计初稿的「本会话子进程退出」`process_exit` 经评审摘除，v0.1.5 以子进程句柄接线），触发后以 `role: 'user'` 背景消息落盘并自动续跑一轮（空闲投递、每分钟最多 1 次；`watch_state` 存 `lastSeenAt` 水位，恢复只补一条简报，仅持会话单写者锁的宿主投递）；模型侧 `watch_start` / `watch_cancel`，用户侧 `/watches`，协议 `watch/list` / `watch/cancel`。不接入 webhook 与 CI 状态源，不做跨会话唤醒。主题二「技能管理与导入」：技能只从自有根读写，**不做兼容根长期读取**（维护者 2026-11-16 决策）；补技能生命周期事件与 `/skills inspect` 诊断，新增管理界面**从其它 Harness 单个或全部导入**——一次性拷贝进自有目录，导入前预览、默认跳过同名冲突、剥离 `context: fork` / `model` / `hooks` 等不支持字段并诊断、写 `.imported-from.json` 溯源，导入后不自动同步。技能运行时修饰（model / effort / autoinvoke）、`context: fork` 执行、远程分发安装均后置，不承诺版本。主题三「会话看板」：按会话聚合变更行数、引用来源、MCP 调用与委派任务四分区 + 头部摘要行（010，终审稿）。主题四「MCP 管理与分发更新」：`/mcp` 配置增删改与跨 Harness 导入（CLI `/mcp import` 与桌面管理区块）、MCP server 执行改为逐服务器批准 + 配置摘要（配置变更即重新待批，未批准不启动）；未签名口径下的 GitHub Releases 版本检查与手动安装提示（011，终审稿）。另承接 v0.1.3 未完成的工具行增强组（U1.3 / U1.5 / U1.6 整组顺延，含 U1.8 分组汇总评估）。主题五「右侧产物预览」：`write_file` 成功写入图片产物时投影到既有右侧 dock 自动预览一次，工具行保留常驻 chip；路径按固定允许根校验（工作区 / OS 临时目录两根，整根排除 `~/.kapibala` 凭据区；「固定应用目录」因 PathSandbox 限制 `write_file` 于工作区内而不可达，实现为更严子集）；不做多面板 tab 与远程产物（012）。主题六「任务面板与输入区状态」：新增 `todo_write` 会话任务清单（四态含 `cancelled`、历史重算 + 压缩保护、无锁落盘，不落新记录类型），桌面输入框上方任务进度 pill 与浮层、下方状态条（空间 / Git 分支 / 上下文），CLI `/todos` 同口径（013）。主题七「权限模型重做」：三档保留 `Approval` / `Auto` / `FullAccess` 三个预设，内部按「沙箱边界 × 询问策略」两轴组合；命令分级从程序白名单改为风险类别（`read` / `workspace-write` / `vcs-write` / `network` / `destructive` / `escape` / `unknown`），实测 Auto 放行率从 8/27 提升到 ≥17/27；新增 `.git/hooks`、`.git/config`、`.env*`、`.envrc`、`.kapibala/**` 可解析写法硬禁区（直接拒绝、不产生审批），审批记忆扩展为 session / project / global 三级并加 `maxClass` 防前缀跨类越权（三级记忆 + `maxClass` 为 P1 顺延，P0 规则表为精确匹配）。边界采用轻围栏，不做 OS 级沙箱与内核网络隔离（016，2026-11-21 完成专项评审、决议见 016 §13；P0 及 2026-11-22 评审收口已完成，残余限制见 016 §11） | Core + CLI + 桌面增量 |

| **v0.1.5** | **外部 Agent Harness（ACP）与多任务会话**（规划中；**版本设计：[015](design/015-v0.1.5-acp-external-harness.md)**；2026-11-20 维护者定向，A0 执行方案已细化至 015 §12） | 在宿主层新增独立「外部 Agent Harness」会话域：通过 ACP 启动并驱动 Claude Code / Codex 等外部 Agent 进程（首批目标以 A0 实测为准，`agy acp` 为控制组），把消息、工具、计划与审批投影为与本地会话同构的只读视图，支持同一宿主内多任务并行、侧栏任务列表、完成通知与可验证恢复。默认每会话独立进程，不共享 ACP 连接；v1 不做 fork / rollback / 会话导入、ACP `fs/*` / `terminal/*` / elicitation，也不把外部 Agent 纳入 Kapibala 的沙箱或写租约。审批原样透传、超时拒绝，全局 Auto / FullAccess 不自动批准外部审批。wire 由整数 **2** 升至 **3**（能力 `external-session`；版本严格相等 + 能力交集）；Core 零改动、不新增 npm 发布包、默认不引入 ACP SDK。A0 为硬门禁：真实链路未跑通前不宣称对应 Harness 已支持 | Host + CLI + 桌面增量 |

### v0.1.4 统一规划（2026-11-20）

> 本节是 v0.1.4 七份设计的统一归纳，单份细节仍以 design 文档为准。2026-11-20 维护者决策：① 新增右侧产物预览（012）；② 新增任务面板与输入区状态（013，数据源为新增 `todo_write`、本版交付全套）；③ **七主题全量纳入 v0.1.4**——保留各文档 MVP 边界，不设必达 / 弹性分档，出现不可控风险时个别主题再顺延 v0.1.5；④ 新增权限模型重做（016）：三档保留预设、边界用轻围栏、不进 OS 沙箱。011 §5「v0.1.4 不再新增主题」自本节起失效。

**分组**

| 组 | 设计 | 范围 | 状态 / 依赖 |
|:---:|---|---|---|
| 后台运行 | [008](design/008-v0.1.4-session-watch.md) | 会话级监视：`watch_state` 控制记录、两类触发源（`process_exit` 摘除）、空闲投递与自动续跑、`lastSeenAt` 水位与恢复简报、`/watches` | 已实现；依赖 v0.1.3 通知通道 |
| 资源管理 | [009](design/009-v0.1.4-skills-management-and-import.md) | 技能诊断 + 跨 Harness 显式导入 | 终审稿；无外部依赖 |
| 资源管理 | [011](design/011-v0.1.4-mcp-management-and-release-updates.md) | MCP 配置管理（复用既有事务）+ 逐服务器批准；GitHub Releases 轻量更新（不走签名） | 终审稿；M0.2 复用 009 导入框架 |
| 右侧信息面板 | [010](design/010-v0.1.4-session-evidence-dashboard.md) | 会话看板：变更 / 引用 / MCP / 委派四分区 + 摘要行（只读持久化 `facts.diff`） | 终审稿；依赖 U1.8 |
| 右侧信息面板 | [012](design/012-v0.1.4-artifact-preview.md) | 右侧 dock 图片产物自动预览 | 终审稿；与 010 共用 dock |
| 任务与输入区 | [013](design/013-v0.1.4-task-panel-and-composer-status.md) | `todo_write` + 任务浮层 + 进度 pill + 底栏状态条（四态含 `cancelled`、写互斥） | 终审稿（多 `in_progress` 已改 0..N） |
| 执行安全 | [016](design/016-v0.1.4-permission-model-rework.md) | 风险类别分级、三档两轴、硬禁区、三级审批记忆、规则页 | 专项评审已完成（2026-11-21，决议见 016 §13）；P0 及 2026-11-22 评审问题已修复并补回归；三级审批记忆与规则页为 P1 顺延 |
| 承接项 | [007 §6.2](design/007-v0.1.3-cross-session-reference-and-delegation.md) | 工具行增强组 U1.3 / U1.5 / U1.6（整组）+ U1.8 分组汇总 | U1.8 是 010 的前置 |

**共享基础设施（一次做对，多处复用）**

- **wire 一次性改为整数版本 2 + 能力集合**：008 的 `watch/list` / `watch/cancel`、009 的 `resources.inspectSkills` / `resources.importSkills`、010 的 `evidence/read` 与看板字段、012 的 `ViewTool.artifacts`、013 的会话 `todos` 字段同批进入；新增能力名只在有新方法的分组声明：`watch` / `evidence` / `skill-import`（MCP 配置方法若启用则 `mcp-config`），纯字段扩展不单列能力；协议契约快照手工 `--update` 并评审，桌面 preload / schema / results / CLI 客户端握手同步改为整数版本 + 能力集合。**版本严格相等、握手即失败**：桌面 `PresentationStateSchema` 是 `.strict()`，旧 `{major,minor}` 客户端在握手阶段被拒，不承诺「旧客户端忽略新字段」。
- **界面线顺序**：U1.3 / U1.5 / U1.6 → U1.8 → 010 看板；012 与 013 可在 U1.5 后并行，013 的 pill 在 010 E0.2 未落地时降级为只显示任务进度。
- **显示名契约**：`watch_start` / `watch_cancel` / `todo_write` 等新工具必须登记 `BUILTIN_TOOL_DISPLAY`，漏登记门禁失败（U1.1）。
- **桌面 dock**：010 / 012 共用 `DetailsDrawer` 的 wide 非模态模式，v0.1.4 单 dock 单内容，不做多面板 tab。
- **落盘不变量**：仅 008 新增控制记录 `watch_state`（三处类型同步、两处元数据重建；载荷存 `lastSeenAt` / `lastNotifiedAt` 水位）；010 新增 canonical 字段 `ToolResultExecution.facts`（只落盘、不上 wire）；012 / 013 全部从既有历史重算，不落新记录类型；013 只增补一条压缩保护规则。

**推进顺序（2026-11-20 确认全量后）**

1. 界面轨道：U1.3 / U1.5 / U1.6 收口 → U1.8 → 010 → 012 / 013；
2. 资源轨道：009（K0 / K1）→ 011 M0.2；011 的 M0.1 与 U0.x / U1.1 可独立并行；
3. 后台轨道：008 的 Core 工作（W0–W4）与上述并行，投递通道单独收口；
4. 每个主题落地即跑完整 `pnpm verify`，不攒批验证；出现不可控风险时**个别主题**顺延 v0.1.5，不预先砍范围。

**已定口径（2026-11-20 锁定）**

- 范围：七主题全量纳入，各文档 MVP 边界不变；不设必达 / 弹性分档。
- 008：自动续跑默认开启；触发后窗口失焦时发系统级通知、前台仅更新会话徽标；v1 不允许绑定父会话（跨会话唤醒拒绝）；投递判定用 `lastSeenAt` / `lastNotifiedAt` 水位，**不存 `delivered` 布尔值**；恢复只由持会话写租约的宿主补投一条简报。
- 009：来源检测只在打开导入界面时扫描；全部导入默认作用域为全局；导入后默认保持启用。
- 010：接受「变更行数不含 run_command 间接改动」的保守声明；统计只认成功工具，行数只读工具执行时持久化的 `facts.diff`，缺失显示「未记录」，**不做 LCS 兜底、不从入参重算**；单文件超 10 MB 只记 `truncated`；父会话结束时仍在运行的委派标记为已结束。
- 011：未签名更新三平台统一「检查 → 下载 → 手动安装」，macOS 附右键 / xattr 提示；`SHA256SUMS.txt` 缺失或无目标条目即拒绝，不提供跳过开关；摘要只证明完整性、不证明来源，未签名须显式声明；项目级 MCP 写入仅限已信任项目；MCP **执行**需逐服务器批准 + 配置摘要，配置变更即重新待批；当前版本读 `app.getVersion()`。
- 012：v1 只识别 `write_file` 成功终态的位图产物（png / jpg / jpeg / gif / webp / bmp，SVG 不投影）；自动弹按 `(workspaceKey, toolCallId)` 只弹一次、不加设置开关；路径按固定允许根校验（工作区 / OS 临时目录 / 固定应用目录），整根排除 `~/.kapibala`，`realpathSync.native` 后先判边界再判存在，拒绝码 `path_not_allowed` / `file_not_found` 分离。
- 013：pill 仅在有清单时显示；底栏空间名优先、无空间回退「本地」；`todo_write` 在子代理会话注册；四态 `pending / in_progress / completed / cancelled`；进度分母为全部条目、分子为 `completed`；`in_progress` 允许 0..N，第一条为主任务，其余 `+N`；读最近一次成功调用，写入加会话内互斥。
- 009：溯源文件 `.imported-from.json` 为本项目自定格式，不兼容读取 CodeWhale `.installed-from`；溯源拆 `sourceRef` / `installedDigest`，执行导入带 `expectedSourceRef`；导入不执行来源代码、不建工作树；单来源上限 200 个候选 / 64 MiB，超出返回 `partial: true`。
- 008：`lastSeenAt < 事件时间` 即欠一次投递，落盘成功后推进水位；同一监视至多一条通知；忙碌期间多事件按 2s 窗口合并，60s 冷却与每分钟 1 次续跑为硬上限；仅持会话写租约的宿主恢复 watcher；v1 不识别自写路径，文档标注限制。
- 跨主题：013 数据源为新增 `todo_write`（不是 U1.8 派生）；009 不做兼容根长期读取；011 不走签名链路；010 / 012 / 013 不落新记录类型；wire 为整数 2 + 能力集合，版本严格相等，不做旧客户端兼容。

### v0.1.5 外部 Agent Harness 与多任务会话（规划中，2026-11-20）

> 完整方案、领域模型、wire 3 方法与 A0–A4 任务拆解见[设计 015](design/015-v0.1.5-acp-external-harness.md)。本节只记录版本级口径，v0.1.4 不受影响。

**为什么单列一版**：v0.1.4 的七主题是「同一会话工作台」内的监视、资源、看板、预览、任务面板与权限边界；外部 Agent 接入会引入独立进程、独立原生会话、独立审批语义与新的协议版本，放进 v0.1.4 会把 wire 2 的收口与外部域的探索绑死。v0.1.4 发布后再从 main 起 `v0.1.5`，不叠加两次 wire 变更。

**范围**

| 轨道 | 内容 | 不承诺 |
|---|---|---|
| A0 实测门禁 | Claude Code / Codex 的 ACP 启动方式、认证、`session/load`、审批与持久身份四项验证；`agy acp` 控制组（执行方案见 [015 §12](design/015-v0.1.5-acp-external-harness.md)） | 未跑通前不写「已支持」；适配器未安装 / 未登录时明确标注 |
| A1 传输地基 | 内置窄 ACP 编解码、进程监督、环境白名单、事件归一、假 Harness 契约测试 | 不引入官方 SDK、不做共享连接 |
| A2 单会话 | 外部会话服务、配置与预设、wire 3、CLI `/external`、桌面外部视图与审批 | 不做 fork / rollback / 会话导入 |
| A3 多任务 | 跨工作区并行、同工作区默认单外部会话、任务列表、完成通知、退出清理、恢复门禁 | 不做多 Agent 编排、不自动注入父会话 |
| A4 收口 | 计划 / 模式 / 工具展示、设置页、文档、e2e 与真实 Harness 证据 | 未验证平台不宣称通过 |

**边界与风险**

- 外部 Agent 有**自己的权限模型**：Kapibala 只转发 ACP `session/request_permission`，不能保证外部工具先审批；UI 与文档必须常驻「外部代理」标识，不暗示已沙箱或已批准。
- 不复用 `/delegate` 的子代理生命周期：外部会话没有 Core `runId`、`parentId`，也不进入 Core 历史、压缩或 outbox。
- 不实现 ACP `fs/*` / `terminal/*` / elicitation，避免把文件与命令执行搬回宿主绕过 PathSandbox。
- 同工作区默认只允许 1 个运行中的外部会话；本地会话与外部会话之间**没有**跨域写租约，发布说明要写明该限制。
- 恢复只在四项持久身份门禁全部通过时声明 `resumable: true`；否则明确不可恢复，不猜 Native Session / Turn ID。
- 本机 2026-11-20 静态核实：`claude` 2.1.329 / `codex` 0.171.0 原生 CLI 均无 ACP 入口（`codex app-server` 不是 ACP），`agy` 1.5.9 提供 `agy acp` 控制组；官方适配器 `@agentclientprotocol/claude-agent-acp@0.109.0` 与 `@agentclientprotocol/codex-acp@2.8.0` 已存在但本机未安装，Claude OAuth 与 Codex ChatGPT 登录态已在位。A0 执行方案（入口矩阵、S1–S7 场景、判定矩阵、证据模板）已细化到 015 §12；运行实测尚未进行，不能把「适配器存在」等同于「已支持」。

### v0.1.0 桌面发布口径调整（2026-11-14）

维护者决定 v0.1.0 以**未签名个人自用版**发布，桌面签名与人工安装证据不再作为发布前置。改动的只有发布口径，桌面代码与候选流程的能力边界不变：

- `release.yml` 默认跳过 `verify:release-evidence`（prepare 与 publish 各一次，只打印 `::warning::`）：六类专项与桌面证据都不是 v0.1.0 的阻塞项；把仓库变量 `KPBL_RELEASE_STRICT` 设为 `true` 可恢复六类专项的同 SHA 强制校验，阈值与字段不变。
- **自动门禁没有放宽**：`verify` 工作流的 ubuntu/macos/windows 矩阵、Node 20 安装、compat、PR soak 冒烟（10 轮）、`verify:desktop` 的 mac/win e2e 与三包 registry 安装 smoke 仍须全绿，任一失败即不发版（release 档长跑自 2026-11-20 起改为 Soak 工作流手动趋势运行，不再阻断发布）。
- 桌面附件默认附带未签名测试包；把仓库变量 `KPBL_DESKTOP_RELEASE` 设为 `true` 则改为“只下载已审核候选”的严格流程。
- 未签名测试包由 `release.yml` 的 `desktop-unsigned` 作业在四个原生 runner 上自动生成并上传到同一次 GitHub Release（产物名带 `Test`、appId `dev.kapibala.desktop.test`，`test-build.json` 会写明 `verification: skipped`，自动门禁证据以同 SHA 的 Verify 工作流为准）；安装器沿用自带 `os-arch` 的文件名，`SHA256SUMS.txt` 与 `test-build.json` 追加平台短名区分；macOS 首次打开需右键或 `xattr -dr com.apple.quarantine`，Windows 会触发 SmartScreen。
- 因此 v0.1.0 不宣称：四平台安装验收、签名与公证、自动更新。托盘（Windows/Linux）与失焦系统通知已实现，但只有 macOS arm64 做过人工实机确认。发布说明必须逐条写明。
- `desktop-candidate.yml` 未改动，仍在缺凭证时拒绝产出候选，避免把测试包误当正式字节。

### v0.1.3 跨会话引用与多任务派发（原 v0.1.1 规划，2026-11-15 顺延）

> 双主题补丁位版本（2026-11-01 确认，2026-11-15 由 v0.1.1 顺延为 v0.1.3，[设计 005](design/005-v0.1.1-multi-task-delegation.md) 文件名沿用不改）：两个主题共用既有会话、任务树与权限基础设施，互不依赖、可独立交付。
>
> **附带发布修复**：本版把 v0.1.2 的受限 PATH shell 兜底修复带入 npm——npm 三包 `0.1.2` 在该修复前发布且版本不可覆盖，GitHub Release 桌面安装包已用修复提交重建（详见 [v0.1.2 发布说明](releases/v0.1.2.md)）。CLI 使用环境总有可用 shell，分叉影响可忽略，因此不单独发补丁版，随本版一并消除 tag/npm 内容分叉。
>
> **主题一 · 跨会话消息引用与上下文复用**：把其它会话（含本会话其它分支）的历史消息作为**确定性上下文**引入当前会话，走显式、可追溯、可复现的冻结快照回放，与自动提炼的长期记忆互补。v0.0.7 已交付的跨项目全文检索（`CrossProjectSessionCatalog.search` 返回命中 `recordId`）是定位基础，本版补齐其消费端。开源对标：opencode 的 `@session:` 稳定 token 与 maka 的会话快照（尾部取样 + 双预算 + 默认脱敏）已核实；Zed / Cursor 的 `@` 交互仅作形态参考，无可读实现。

**2026-11-16 核实与重排**（详见[设计 007 §0](design/007-v0.1.3-cross-session-reference-and-delegation.md)）：本版产品范围不变，改为 **MVP + 增强项** 两档判定（MVP 三条线缺一不可，增强项失败只回退该项）。同时修正三处依据：① codex-host 明确**不拼接父会话标题**，「委派名 · 父会话名」改为我们的自定规则；② 引用正文**默认脱敏**（对齐 maka `redactSecrets`）；③ 引用预算增加 **UTF-8 字节上限**，与字符上限同时生效。此前引用的 DeepTutor、hermes-agent 在该目录不存在，已从依据中删除。

主题一交付边界：

- **引用注入与落盘**：宿主经 `AgentSession.runPreparedTask` 在运行锁内把引用展开为带溯源头的引用块（来源元数据语义与 MCP Prompt 的 `promptSource` 对齐），随本轮 user 消息经 `MessageStore` 消息级落盘；引用为冻结快照，源会话后续压缩、分叉或归档不改变已注入内容，且不产生未闭合工具事务。
- **Core 只读读取 API**：新增按会话与 `recordId` 读取消息的受控只读宿主 API，复用 Envelope 因果链（`parentId`/`branchId`）与投影能力；只读路径不获取 `SessionLock`、不创建目录，不破坏单写者与项目桶校验模型。
- **宿主入口**：CLI 新增 `/quote`（复用 `/resume` 选择菜单与 `--search` 全文检索交互，支持会话级与消息级粒度）；桌面端输入区提供 mention 弹层，复用侧栏会话列表并接入全文检索（桌面端当前只搜标题）。
- **预算与压缩**：单条引用与单轮引用总量设上限，超预算拒绝并提示（沿用任务自身超预算零追加拒绝语义）；引用块携带来源标记，压缩投影优先保留溯源头与摘要、允许降级正文，不误伤未被引用消息；剪裁白名单与 `normalizeHistory` 行为不变。
- **收编遗留项**：v0.0.7 明确未交付的 `branchWithSummary` 跨分支摘要注入并入本版（`branch_summary` 记录类型与投影注入位已预留，本版补齐写入方）。
- **主题一明确未交付**：跨项目桶（跨工作区）引用——需先与 v0.0.5 项目信任模型对齐后另行设计；活引用（引用随源会话演进联动）；引用内容自动记忆化提炼；对被引用会话的任何写操作。技术方案另行编写。

**主题二 · 多任务派发**：交付范围以 [设计 005](design/005-v0.1.1-multi-task-delegation.md) 为准（提案草稿已入库），分三段交付（D1 Core 委派会话生命周期 → D2 CLI 用户级派发 → D3 桌面可见化，任一段独立可用）：`spawn_agent` 新增 detached 保留型委派会话；保留策略分两档——**MVP：上限 20 + `/delegations delete` 手动删除**，增强：LIFO 淘汰与闲置清理（D4.2）；`send_agent` 对空闲 detached 会话续聊（busy 即拒绝不排队）、工具层 requestId 幂等（显式去重，不做隐式摘要窗）、「委派名 · 父会话名」命名；CLI `/delegate` `/delegations` 用户级派发与委派会话面板；桌面侧栏委派会话可见、流式看进度、终态后接续聊天。跨 Harness 托管（把外部 CLI agent 接入为派发目标）与被 ACP 客户端托管维持 005 §3.3 非目标，列为后续探索项；本版不捆绑 Worktree 隔离（005 开放问题 4）。

> **多 Agent Harness 编排后置（2026-11-15 决策）**：把外部 Harness（Claude Code / Codex 等 CLI）作为委派目标的「多 Agent Harness 编排」不进入本版，后置为**未来版本的独立探索项，不承诺版本号**。它与本版「同 Harness 内子 agent」是两条不同技术路线（分界点为执行体是否来自同一 Harness）；两条路线的对比、codex-host 三个正交维度的拆解，以及纳入前必须具备的六项前置条件见 [设计 007 §10 附录 A](design/007-v0.1.3-cross-session-reference-and-delegation.md)。

### v0.0.10 稳定整合与发布边界（2026-10-21）

- 本版只做整合：不新增客户端形态、运行时子系统或 npm 包，不做 barrel 重构；wire 仍为 1.0，产品版本与协议版本继续解耦。
- 9 处公开差异（根字段联合 type、删除全局租约单例、缺省独占租约、`LocalClient.call()` 结果具体化、显式 cursor 返回原始续块、attach 失败关闭整个连接、`SpawnContext`/runner 必填协调器、`LocalTransport.setLimits` 必填、清理错误类型化）逐条登记在 [SDK 兼容性说明](sdk-compatibility.md)，迁移动作见 [迁移说明](migration/v0.0.10.md)。
- 历史与配置不需要用户执行迁移：v1 语料只读复制升级为独立 v2 副本，损坏与未知 schema 明确拒绝且零工具重放；v0.0.9 的 `settings.json` 可直接读取，目录迁移幂等。
- 最终候选 `d6d73ac` 的本地及跨平台门禁通过（159 文件 / 1364 测试）；旧新产物兼容、真实 Node 20、三包隔离安装、MCP、原生终端、跨用户 ACL、双解释器进程树和正式长跑证据见[验收记录](verification/v0.0.10.md#6-最终发布结果2026-10-23)。
- 六项同 SHA 证据及冻结阈值均经维护者审核，标签工作流完成三包发布、公共 registry 安装 smoke 与 GitHub Release。未来候选仍须重新满足全部证据门禁。

### v0.0.9 本地实现与发布边界（2026-10-21）

- CLI 内新增 protocol/client 子路径、本地 stdio/socket/pipe 宿主与 daemon/connect 入口，仍保持三个发布包；直接 CLI 兼容，协议版本独立为 1.0。
- 会话单控制者、操作 ID 去重、审批取消和有界一致快照已实现；重连不重发写操作，不提供跨连接事件重放。工作区写租约只覆盖同一宿主。
- 最终本地 `pnpm verify` 为 145 个测试文件、1253 项测试通过，`pnpm build`、macOS 真实 daemon/stdio 平台检查与三包 tarball 隔离安装通过；Linux/Windows CI 全量门禁通过，Windows ACL/进程树与 Node 20 见 [待补齐门禁](verification/v0.0.9.md)。发布由标签工作流完成：npm 三包 latest 为 `0.0.9`，公共 registry 安装 smoke 与 GitHub Release 资产均通过。

### v0.0.8 已确认交付边界（2026-10-17）

- 终端底层基础设施与输入守护：`TerminalModeGuard` 接管未捕获异常与进程退出，保障光标（`\x1b[?25h`）、备用屏（`\x1b[?1049l`）与 rawMode 可靠恢复；`TerminalInputFramer` 引入 40ms 拼包缓冲解决 ConPTY 分片，Bracketed Paste 隔离换行与快捷键并设 1MiB 上限防 DoS；`TerminalInputStream` 保证 stdin 单读者互斥；`TerminalEditor` 基于 `Intl.Segmenter` 支持 Unicode 宽字符、组合字符与历史回滚；
- 跨端纯展示模型（`@kiturone/kapibala-cli/view-model`）：导出无副作用的展示状态与纯函数 Reducer，提供独立构建产物（`tsconfig.view-model.json` / `tsup.view-model.config.ts`），`check-view-model.ts` 门禁保证 0 Node 内置依赖，供终端与未来桌面端共享；`selectMessages` 引入 WeakMap 快照缓存；
- 宿主桥接中枢与命令输出解耦：`SessionPresentationHost` 与 `PresentationStore` 统一订阅分发与 16ms 防抖；全量迁移 `packages/cli/src/commands/*` 20+ 内置命令至结构化 `CommandOutput`，消除运行期隐式 `console.log`，`check-cli-boundary.ts` 架构门禁强制约束；
- 多任务状态观察：Core `AgentRuntime` 提供 `subscribeTaskChanges` 只读通知订阅，CLI 宿主 `TaskObservationHost` 实时聚合子任务并在状态模型反映进度；
- 本版明确未交付：全屏 Ink TUI 主视图切换（后续单独排期）、Electron 桌面客户端包（当前路线图排入 v0.1.0）、Git Worktree 物理隔离与审批冒泡队列。

### v0.0.7 已确认交付边界（2026-10-16）

- 彻底移除 Core 内部对隐式 `process.cwd()` 的依赖，`AgentSession` 构造要求显式 `workspaceRoot` 绝对路径（缺少抛出 `WORKSPACE_ROOT_REQUIRED`），Windows 路径规范化统一走 `fs.realpathSync.native`；
- `PathSandbox` 重构为会话持有实例，引入 `WorkspaceLeaseCoordinator`（单例 `sharedWorkspaceLeaseCoordinator`）互斥写租约；架构门禁与单测阻止隐式目录操作；
- 会话升级为 Schema v2 Envelope，分离物理时序与因果链（`parentId`/`branchId`），解耦三大版本号；存量 v1 日志只读保护，`open` 与 `continueRecent` 默认自动创建 `_v2` 升级副本；
- 持久分支支持 `selectBranch`、`createBranch` 与 `forkSession` 导出独立会话（剥离来源 `upgradeIdentity`、导入历史不计费）；因果回溯校验工具闭合，严禁未闭合工具事务分叉，识别 `history_repair` 叠加记录并拒绝以全局控制记录作为切点；
- 引入 `AgentRuntime` 后台任务调度器，管理子代理状态机，`spawn_agent` 受理即刻闭合父工具事务；`SubagentOutbox` 以追加日志耐久保存终态与 ACK 并可读回，`SessionInbox` 按 `eventId` 幂等写入父历史；
- 通知投递为显式拉取：`/agents collect <id>` 注入来源分支，异分支拒绝并提示切换；空闲自动唤醒投递本版未接入；
- 层级安全限额与权限求交：`deriveChildPolicy` 以父会话真实模式、规则与工具表逐轴收紧求交，内置 5 类角色预设与场景模型路由，`modelOverride` 受理前校验；Plan 模式硬拦截 `agent:spawn`；最大深度熔断与树级槽位/累计额度生效；
- `CrossProjectSessionCatalog` 支持跨项目全局会话扫描、有界正则 worker（复用单 worker + 随剩余 deadline 收缩超时）熔断检索；支持 `archive_state` 逻辑归档与恢复，运行中会话硬拦截归档；
- 扩展 CLI 命令：`/history`（--tree/--search/--all/--agents）、`/branch`、`/fork`、`/archive`、`/agents`；终端底栏子代理紧凑状态行与 Ctrl+O 展开详情，秘密输入期间自动缓冲后台异步输出；
- 本版明确未交付（相关未接线组件已删除）：Git Worktree 物理隔离（`isolation:'worktree'` 受理前显式拒绝）、父终端审批冒泡队列、跨任务树 Token 分层账本、空闲自动投递、`branchWithSummary` 跨分支摘要注入；
- 全量门禁（112 个测试文件 / 1033 项通过、3 项因 Windows 符号链接权限跳过）通过；进程回收用例按平台分支，本机 Windows `taskkill /T /F` 分支实测通过。

### v0.0.6 已确认交付边界（2026-10-15）

- MCP 生态以独立公共包 `@kiturone/kapibala-mcp` 交付，保持 Core 纯粹 Headless 且零外部运行时依赖。三包依赖拓扑由架构门禁与自愈脚本全量约束。
- 支持 Stdio 与 Streamable HTTP（SSE）双传输。内置跨平台进程树强制回收与 RFC 1918 私网拦截；启动授权与工具调用授权分离，非 TTY 环境拒绝未经审批的 Stdio 服务启动。
- 工具统一映射为 `mcp__<server>__<tool>` 命名空间并在终端格式化展示；敏感参数自动脱敏为 `[REDACTED]`。
- 历史会话记录可选 `mcpSource` v1 元数据，发送外部模型 wire 时剥离，严格保持历史闭合不变量。
- 新增 `/mcp`、`/mcp tools`、`/mcp reconnect`、`/mcp enable/disable` 管理命令，新增 `/prompts` 与 `/prompt` 受控模板调用；提供 `--no-mcp` 宿主禁用开关。
- 本地全量门禁（100 个测试文件 / 943 项通过、3 项因 Windows 符号链接权限跳过）、独立 tarball 安装冒烟（`scripts/v0.0.6-pack-smoke.ts`）及真实 CLI 平台回归（`scripts/v0.0.6-platform-check.mjs`）全部通过。外部 npm Trusted Publisher 配置属远端发布前置。规划阶段不修改版本号。

### v0.0.4 已确认规划范围（2026-10-05）

- 原生 Anthropic Messages 与 OpenAI Responses 分别接入同一个 Agent 工具循环；保留第三方 Chat Completions 兼容网关，并加固工具参数、停止原因与断流校验。内置 Claude/OpenAI Profile 显式选择对应原生协议，自建 Profile 不自动改协议。
- `planning`、`execution`、`fast` 由用户或 SDK 显式选择，一次 `run` 内角色不随工具调用自动变化；`summary` 独立。提供可见思考块事件和按模型计算的输出预算，不推断隐藏思考。
- 版本开发范围、实施顺序、迁移与验收门槛见 [v0.0.4 完整开发方案](superpowers/specs/2026-10-05-v0-0-4-development-plan.md)，协议细节见 [技术设计](superpowers/specs/2026-10-05-v0-0-4-multi-protocol-routing-design.md)。技术方案于 2026-10-06 确认，工作区实现及本地验收于 2026-10-07 完成；41 项进度见 [OpenSpec tasks](../openspec/changes/v0-0-4-multi-protocol-routing/tasks.md)，证据见 [验收记录](verification/v0.0.4.md)，接入见 [迁移说明](migration/v0.0.4.md)。真实付费 API 未验收；npm 与 GitHub Release 已于 2026-10-07 发布并完成远端安装验收。自动意图分类、托管工具、多模态和界面折叠不进入本版。

### v0.0.3 已确认交付边界（2026-09-27）

- 历史会话能力从 v0.0.7 提前到 v0.0.3，与消息生命周期、上下文预算和滚动摘要共同交付；工作区版本已更新为 v0.0.3。自动与 Windows/POSIX 恢复门禁通过，三组真实工具任务小规模质量验收已完成，费用、缓存与模型限制见验收记录；npm 与 GitHub Release 已于 2026-09-27 发布并完成远端安装验收。
- 用户级 `~/.kapibala/sessions/<project-key>/` 按工作树分组，每会话独立文件；列表使用可重建元数据，记录 `gitBranch` 并提供环境分支漂移感知，选中后才加载对应正文。分文件解决不同任务混存，检查点解决模型上下文膨胀，原始历史仍会随单会话增长。
- 消息身份推荐使用时间单调递增的 UUIDv7；底层持久化 Envelope 显式保留可选的 `parentId: string | null` 字段以支持未来因果历史 DAG 与分叉，避免后续二次破坏性数据迁移。
- 普通 `kpbl` 与无恢复参数的单次问答默认新建；`/history` 查看列表，`/resume [id]` 切换续答，`--continue`/`--resume <id>` 启动恢复；`/new` 和受管 CLI `/clear` 保留旧历史，SDK reset 保持清空语义。
- 旧工作区 `.kapibala/history.jsonl` 整体导入为可选择的独立会话，保留原文件；恢复不重放工具、不继承审批缓存、不隐式改变执行 cwd。
- 压缩以 Pi 为主体，保留保守两级处理：保护范围外成功 read_file/glob/grep 结果先剪裁，仍达到阈值再滚动摘要；剪裁不改原文，后续摘要取原始结果。借鉴 Codex 恢复一致性，剪裁与摘要各自校验、持久提交后激活，重启重建适用状态。
- 摘要工具输入保留默认 2000 Unicode code point 首尾片段并检查整个请求预算；文件详情区分成功/失败/未知。三次自动摘要操作失败仅暂停自动摘要，最终硬预算决定任务是否停止；失败状态恢复、手动重试和配置周期有明确规则。稳定锚点只保证未变前缀一致，剪裁无额外模型调用但不承诺零延迟或缓存命中；真实质量、费用和缓存 usage 独立验收。
- 首版不做任务内部压缩或切分：完整保留当前交互、最近成功交互及其后的失败/中断交互，保护范围超限明确停止；该能力留待后续单独设计，不承诺超长单任务可无限续跑。跨项目检索、分叉、归档及多智能体仍在 v0.0.7。
- Core 内部组织结构已完成“六大领域分层”重构（types/、runtime/、context/、capabilities/、models/、extensibility/），执行引擎通过共享契约接入上下文准备；保留既有公开符号与基础 SDK 用法，新增能力和内部深路径迁移边界见迁移说明。
- 常用 Slash 命令整理纳入本版：新增 `/context` 预算明细（支持字符比例条 Visualized Gauge）与 `/compact` 手动压缩；采用 `/permissions`（兼容 `/mode`）、`/settings`（别名 `/config`），统一模型/配置重复子命令。`/clear` 保留为 `/new` 别名，`/quit` 保留为 `/exit` 别名。完整命令表见 [技术方案的 CLI 命令部分](../openspec/changes/v0-0-3-session-context/design.md#4-cli-命令和输入协调)，行为验收见 [CLI 命令契约](../openspec/changes/v0-0-3-session-context/specs/cli-command-contract/spec.md)。
- 命令注册、别名、参数、分组帮助与执行状态约束共用目录；菜单和秘密输入复用 REPL 输入协调器，非 TTY 不挂起。默认模型写入使用原始全局配置且保存成功后才更新内存；手动压缩不绕过完整轮次保护规则。命令面板模糊匹配、Tab 补全仍在 v0.0.8。
- 提案、验收规范与实施进度见 [v0.0.3 OpenSpec change](../openspec/changes/v0-0-3-session-context/proposal.md)。

## CLI 过程输出折叠与展开（规划补充，2026-09-28）

该能力分阶段交付，折叠只影响 CLI 展示，不改变 Core 的消息历史、工具事务闭合或落盘规则。

- **v0.0.4 事件基础**：Anthropic 原生 Provider 将模型实际提供、允许展示的思考内容以结构化事件传给 CLI；OpenAI Responses 只在 API 明确返回可见推理摘要时提供相应展示事件，加密推理 Item 不展示。工具调用及结果继续保留完整事件；Provider 未提供或已隐藏的思考内容不由 CLI 推测生成。
- **v0.0.5 默认折叠（已发布）**：CLI 默认将思考、工具调用和工具结果显示为简短摘要；TTY Ctrl+O 切换本轮详情，菜单/密钥/审批期间禁用。所有回答文本、错误、取消和权限请求完整可见；`--output-detail detailed` 提供非交互完整公开过程。当前轮次缓存最多 1 MiB，不能回收任意终端 scrollback；非 TTY detailed 流不受缓存截断。
- **后续终端专项，版本待定，点击展开**：在可重绘、可滚动的终端会话视图中，支持点击过程块展开或收起；同时处理鼠标事件、窗口尺寸变化、终端兼容及复制文本体验，并为不支持鼠标的环境保留键盘操作。此项不属于 v0.0.10 稳定整合或 v0.1.0 桌面端的默认交付范围。

验收时应确认折叠/展开不会遗漏流式输出，不会影响 SessionEvent 消费、消息落盘、工具结果闭合与会话恢复。

## 缓存友好的上下文压缩（专项增强与实测待排期）

> 原为 2026-09-28 的 v0.0.6 补充规划；2026-10-13 方案优化后，专项增强与实测移出 v0.0.6 MCP 交付，目标版本待定。以下目标保留，不标记完成；既有上下文压缩和完整事务规则不撤销，具体已交付边界仍以 v0.0.3/v0.0.4 记录为准。MCP 目录稳定不等于缓存专项验收通过。

- **目标**：在现有上下文压缩基础上，提高压缩后续轮次对 DeepSeek 等服务端前缀缓存的复用机会；优先保证上下文质量与长度约束，不以缓存命中率替代压缩目标。
- **投影规则**：原始消息历史和落盘记录保持不变；压缩只改变发送给模型的投影。每次压缩形成一个固定的摘要检查点，后续轮次在其后追加最近的完整消息；仅在下一次确需压缩时更新检查点。保持固定指令及可复用内容的顺序和序列化稳定，避免无关动态字段插入请求前缀。
- **工具事务**：压缩边界不得拆开 `tool_use` 与对应 `tool_result`；恢复、取消和失败轮次继续遵守既有 canonical 历史规则。
- **缓存预期**：摘要替换旧历史后，首次请求不保证命中被替换部分的旧缓存；新前缀建立后，后续请求才有机会复用。缓存由服务端管理，Kapibala 不实现本地模型 KV 缓存，也不承诺命中率。
- **验证与观测**：在 Provider 返回相关用量时记录缓存命中和未命中 token 数，比较压缩前、压缩后首轮及后续轮次的输入量、缓存命中、费用和响应质量；对不提供缓存用量的 Provider 保持兼容。

---

## 🖥️ 跨平台桌面客户端规划（Electron，v0.1.0）

> 2026-10-24 确认：基于现有 Harness 实现桌面版，不另建执行引擎。功能清单、接口、文件级任务和验收以 [v0.1.0 功能与开发方案](design/004-v0.1.0-desktop-harness.md)为准，共享层阶段 A 与桌面最小闭环阶段 B 已通过本地自动验收；[阶段 A](verification/v0.1.0-stage-a.md)与[阶段 B](verification/v0.1.0-stage-b.md)记录真实检查和跨平台 pending。阶段 C 的完整会话体验与本地门禁已落地，见[阶段 C 验收](verification/v0.1.0-stage-c.md)；2026-10-25 已补创建项目与信任文件夹双层交互，D1 已提供测试打包、生产依赖闭包、安装副本 smoke、许可与哈希附件，见[D1 验收](verification/v0.1.0-stage-d1.md)。紧凑黑白 UI 与两项断连问题已修复，D2/D3 的签名候选、版本同步和审核附件发布代码已接入；实际证书、远端流水线、其它安装目标及完整发布证据仍待验收，v0.1.0 尚未发布。

实施步骤、现有代码入口与故障测试见[桌面开发指南](desktop-development.md)。

### 架构与功能范围

Electron Main 管理原生窗口、托盘、通知和 Host 生命周期，单个 `utilityProcess` Agent Host 复用 Core、MCP 和共享宿主装配。React 界面经沙箱 Preload 和受控 Typed IPC 操作会话，只接收脱敏展示数据。此方案替代原 Main 直连引擎的规划，不启动外部 daemon 或监听端口。

首版交付默认空间与项目空间、共用模型及凭证设置、历史对话、流式 Markdown、思考折叠、按需工具详情、审批取消、多工作区会话、真实指标、Skill/MCP 状态及子任务观察。未绑定项目的新会话归默认空间，工作目录固定为 `~/.kapibala/workspaces/default`；默认空间是应用自有的可信根，首次启动把信任写入全局记录（与 CLI 共用），无需重复确认，项目空间仍须显式信任；权限检查保持不变，历史沿用既有项目桶。

主界面采用空间会话侧栏与对话主体两栏，工具详情默认关闭，点击后在右侧抽屉查看；模型配置放在设置中。视觉语言定为“纸面与静水”：白纸画布、墨色正文、静水青单一强调，细线分隔，阴影只给浮层。默认白底，支持深色与跟随系统，具体布局、色值和文案以 004 第 6.3 节为准。原始历史仍是唯一耐久事实，Core 保持 Headless 和零外部运行时依赖，现役本地 wire 协议保持 1.0（v0.1.0 桌面定稿时点口径；自 v0.1.4 起为整数 `PROTOCOL_VERSION = 2`，旧报价握手即失败）。

界面组件只用一个体系：`@cloudflare/kumo`（内含 Base UI 原语）提供组件与交互，Phosphor 为唯一图标来源，动画使用与 Kumo 同主版本的 Motion，Zustand 只保存易失 UI 状态，Markdown 与长列表分别用 react-markdown 和 `@tanstack/react-virtual`。首版不引入 Radix、shadcn/ui 或第二套图标、动画库，也不为暂不存在的可调分栏和拖拽安装布局库。已有依赖能正确表达时禁止自写焦点、弹层、组合框、虚拟化或高亮逻辑；新增依赖须先更新选型表并审许可证。约束见 004 第 6.1 与 6.1.1 节。

不做完整 IDE、Monaco 编辑器、交互式 PTY 终端、Git Worktree、多代理编排画布、云同步、远程服务或插件市场。自动更新、全局呼出小窗与拖拽附件留到后续版本，不把既有 CLI 的全部增强项纳入桌面首版。

### 开发顺序

| 阶段 | 交付重点 | 独立完成条件 |
|---|---|---|
| A：共享宿主 | 新增 CLI `/host` 窄出口、精确根身份、共享投影、全局配置写事务 | CLI/daemon 和公共 API 回归通过，桌面尚未接入也可合并 |
| B：桌面最小闭环 | 原生窗口、Host、默认/项目空间、信任、配置、新建/恢复、两栏对话、审批和取消；Kumo 与 Tailwind v4 接入及首帧主题 | 内部开发构建可完成真实任务，安全边界不留到后续补做 |
| C：完整会话体验 | 空间会话聚合、Kumo 原语实现的详情抽屉、三态主题、状态、子任务观察与通知，扩展阶段 B 已有的快照恢复压力测试 | 功能清单完成，长列表、输入法和异常路径通过验收，UI 依赖唯一性与主题门禁通过 |
| D：平台交付 | Windows NSIS/ZIP、macOS DMG、Linux AppImage，签名、公证与发布证据 | 各目标平台实际安装验证，所有正式发布门禁通过 |

### 平台与发布边界

macOS 关闭窗口保留应用，Cmd+Q 进入清理退出；Windows 支持托盘隐藏，Linux 无托盘时走退出确认。窗口隐藏不取消任务，Renderer 控制连接丢失触发取消；Host 崩溃或强制退出后保留未知清理状态，禁止自动重发写任务，不承诺强杀后所有后代都已回收。

桌面包 `packages/desktop` 为私有应用包，不新增 npm 发布包。**macOS 签名和公证、Windows 代码签名前移到 v0.1.0 正式发布门禁**，不再与自动更新一起延后；缺少凭证时只能交付明确标记的未签名测试包。原六类发布证据继续要求，桌面专项不能替代 Node 20、ACL、PTY、进程树、MCP 和正式长跑验收。
