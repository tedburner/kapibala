# Kapibala v0.0.6 MCP 生态接入开发计划

状态：2026-10-13 本地规划草案，尚未开始功能实现。当前版本 0.0.5；本文不代表 Git 提交、推送、外部发布或付费 API 验证授权。

依据：[技术设计](2026-10-12-v0-0-6-mcp-ecosystem-design.md)、[OpenSpec 提案](../../../openspec/changes/v0-0-6-mcp-ecosystem/proposal.md)、[实施决策](../../../openspec/changes/v0-0-6-mcp-ecosystem/design.md)、[需求场景](../../../openspec/changes/v0-0-6-mcp-ecosystem/specs)、[任务进度](../../../openspec/changes/v0-0-6-mcp-ecosystem/tasks.md)。详细验收默认值和接口语义引用技术设计，本文只维护顺序、接点和完成证据。

## 1. 交付与里程碑

交付一个受控 MCP 扩展包、CLI 接入与 Core 必需的通用契约。Tools/Prompts、Stdio/Streamable HTTP、固定 HTTP 鉴权、运行快照、启动与调用授权、结果闭合和三包交付均为本版必需。缓存友好的上下文压缩专项增强与实测不属于本版交付，`docs/RELEASES.md` 已保留其目标并标记版本待定；既有压缩约束不变，不在本计划中将专项标记完成。

| 里程碑 | 必须形成的可检查结果 | 对应任务组 |
| --- | --- | --- |
| A：兼容证据与通用契约 | SDK 两时代/两传输可行；服务端计数证明已发送 `tools/call` 不被隐式重放；原子注册/身份/结果/任务准备契约明确；旧工具回归通过 | 1、2 |
| B：Stdio 端到端 | 独立包通过授权连接本地真实进程，发现/调用/审计/落盘，业务失败正确闭合；目录 epoch 竞态和参数校验通过 | 3、4、5、6（Stdio路径） |
| C：用户 Prompt 与任务准备 | 基于 Core + Stdio 闭环完成 Prompt 元数据、显式获取、单条 user 提交和来源落盘；不等待 HTTP 才能开始验证 | 8 |
| D：HTTP、CLI 与交付准备 | HTTP 复用同一执行语义；管理命令、非TTY、三Provider、跨平台清理及三包安装门禁完成 | 7、9、10 |

每组随功能补齐有意义测试、公开中文 JSDoc 和相应使用说明。最终组只做跨模块集成，不把早期权限/目录/取消单测推迟到末尾。

## 2. 实施顺序与依赖

1. **先验证 SDK/进程边界与防重放证据，再进入契约实现。** v2 具体版本、Stdio 探测次数、现代/旧版协商、HTTP 限长及 `.cmd`/进程树处理需可重现证据；必须以受控 Server 请求计数断言在 legacy（session-expired / 404 session missing）与 modern（401 鉴权过期/挑战、400 HeaderMismatch/ProtocolMismatch 等逐请求失效）以及断流、超时、取消下，已发送 `tools/call` 绝无隐式重放（至多发送 1 次）。若 SDK 存在不可关闭的隐式重试，立即停止后续依赖实现并修订选型。
2. **通用 Core 契约先完成，再接扩展包。** 原子 source 更新（含候选批内自身重名与跨来源冲突预检）、在任务运行锁生效/执行准备（`runPreparedTask` prepare 阶段）开始时捕获不可变快照并贯穿多 turn 推进、目录 epoch、执行身份、最终参数校验、出队前同一同步微任务无 await 复核、结果双维度及任务准备相互配合；不引入 MCP 专用循环分支。
3. **建立包/配置/启动授权，再连接 Stdio。** 配置解析纯读阶段不可执行，Server 名称必须符合 `^[a-zA-Z0-9_-]+$` 且禁止 `/` 与 `__`；宿主启动授权回调缺省拒绝；审批串行与技术等待截止分离。
4. **目录和调用共同验证。** 任务准备时捕获快照并固定 MCP 声明至整轮结束，通知立即暂停来源并递增 epoch；只有最新 refresh token 且在实际发送前同步复核仍有效，完整复核的旧实例才可恢复。刷新失败不可因超时恢复旧权限；Skill 收紧不能被覆盖。
5. **结果和清理完成后再扩 HTTP。** 已发送操作不可重放，响应有界、消息级落盘、return/abort 等待收口必须先通过 Stdio 基线；阶段 A 和 HTTP 集成测试还要证明 SDK/transport 没有隐式重发。
6. **Prompt 不再依赖 HTTP 完成。** Prompt 通过同一任务锁接入，先用受控 Stdio Server 形成纵向闭环；获取是受控外部操作，用户意图不覆盖 Plan/deny；保存模板为单条 user 消息中的独立块，不直接插入 assistant/system。HTTP 在其独立闭环完成后汇合 Prompt 的传输矩阵。
7. **CLI 管理使用 controller/Registry。** Session 切换工厂按独立实例所有权接入；只读命令不连接，变更命令不能打断准备/审批/清理。
8. **新包纳入完整工程与发布验证。** 类型检查、`scripts/dev.mjs` 中的 `repairWorkspaceLinks` 覆盖完整三包依赖拓扑、包边界、直接枚举五处版本真源文件路径（根目录/Core/MCP/CLI package.json 及 CLI_VERSION）、本地 tarball 安装必须覆盖，外部发布另行授权。

## 3. 代码接点与变更边界

| 接点 | 计划改动 | 本阶段证据 |
| --- | --- | --- |
| Core capabilities/tools/{registry,index} | 原子来源替换（含候选批内自身重名预检与跨来源冲突检测）、不可变快照视图（`snapshot()`）、可选最终参数校验/执行身份/结果转换 | 批内重名与后项冲突零部分提交，快照不受后续注册表变更影响，普通对象返回语义不变；旧 Tool 缺省兼容 |
| Core runtime/{loop,executor} | 任务准备开始捕获不可变快照并贯穿生命周期（多 turn 不漂移）、出队前同一微任务无 await 同步复核、业务失败及等待清理 | 原生工具续答声明稳定、撤销零发送、已完成结果保留；校验失败零审批零发送 |
| Core capabilities/security/{permissions,approval} | `external:call` 扩充、`SessionApprovalCache.key` 深度哈希 `executionIdentity`、发送前授权约束 | Plan/deny/Skill/无审批通道/FullAccess/重连缓存深度哈希失配矩阵 |
| Core context/session、types/历史/摘要/验证器 | runPreparedTask、promptSource v1、execution v1（dispatchOutcome/hostError）、提交事件、PluginContribution/PluginCommandContribution 扩展契约与 session.getPlugins() 查询 | 准备失败零追加，旧JSONL可读，来源不回传/授权，已知成功不被投影错误改成 unknown，插件声明式 contributes 纯元数据解耦 |
| 新 `packages/mcp` | 配置（严格 Server 名称字符集）、生命周期、适配、目录、Prompt与传输（全量私网/保留 IP 拦截与 Remote IP 二次复核）、声明式 contributes 插件契约 | fake/真实Server、两时代、分页、epoch竞态、结果、清理、服务端请求计数、插件携带命令声明 |
| CLI project-trust/index/session-startup/active-session | MCP配置入口、启动审批、Session工厂及取消 | 无MCP无开销、required失败保留旧Session、连接和能力状态分离 |
| CLI commands/catalog/dispatcher/input-coordinator/ui | 固定管理与Prompt命令、/plugins [name] 插件诊断命令、补全和安全输出 | busy查询/变更、串行输入、非TTY无ANSI、/plugins 观测全量与明细 |
| tsconfig、开发脚本、架构门禁 | 新包类型/声明、scripts/dev.mjs repairWorkspaceLinks 覆盖三包拓扑、公共导出限制 | 故意错误被检测，Windows 三包软链退化自愈为真实 junction |
| release/flow/Actions及其测试 | 统一清单精确覆盖五处版本真源文件路径（根 `package.json`、Core/MCP/CLI `package.json` 及 `CLI_VERSION`），按 Core→MCP→CLI 顺序发布 | 本地tarball可安装，内部依赖版本一致，发布检查不遗漏新包 |

不修改用户维护的 `docs/design/001-agent-framework-design.md` 章节或交叉引用；本变更明确细化基线“核心循环一行不改”的早期目标：允许为所有扩展补齐通用契约，但 Loop 不加入 MCP 专用分支；不将实际 Core 改动描述为零修改。无关模型目录/品牌/资产/终端架构不重构。

## 4. 自动化验收矩阵

| 能力规范 | 必须覆盖的行为 | 测试层 |
| --- | --- | --- |
| tool-source-transactions | 后项冲突、跨来源保留、run快照、epoch/refresh token、钩子捏造名称、即时撤销、发送前竞态、旧Tool兼容 | Core注册表/Loop/Executor |
| mcp-config-trust | 整项覆盖、项目禁用/未信任、native路径、cwd、最小env、缺变量、敏感凭据告警、私网SSRF/DNS Rebinding拦截、保留设备名拒绝、目标漂移、重定向隔离、启动与调用授权分离 | 配置纯函数+宿主授权 |
| mcp-connection-lifecycle | 两时代两传输、并发截止、required/optional、Prompt-only、迟到回调、失败setup、幂等回收、连接/能力状态分离 | fake clock/Client+真实进程 |
| mcp-tool-execution | 名称碰撞保序、分页环、Schema/ref、预算遗漏、通知暂停/epoch、参数校验、`external:call` 规则校验、Skill/Plan/缓存身份哈希隔离 | 扩展目录/权限集成 |
| mcp-result-lifecycle | execution v1（dispatchOutcome/hostError）、isError、structuredContent、限长、二进制/_meta、省略、未知结果、审计/append失败、不重放计数 | 适配/Session事务/真实计数Server |
| mcp-user-prompts | 参数、角色降级、预算、取消、Plan/deny、来源、旧历史、事件提交、参数不重复回显 | Session/Provider投影 |
| cli-mcp-management | 固定命令、补全、busy/输入门禁、独立Session、非TTY、真实输出范围 | CLI命令/进程验收 |
| mcp-package-delivery | 新包typecheck/test收集、公共边界、junction、tarball、版本/依赖顺序 | 工程/安装冒烟 |

三 Provider（Anthropic Messages、OpenAI Responses、Chat Completions）使用可控模型协议模拟完成相同工具任务。专门断言 native continuation 的工具/系统受保护前缀不因 MCP 刷新改变；不同run可看到新定义。模拟不同故障发生顺序，断言服务端实际发送次数，不能仅检查UI文案。

## 5. 真实进程与安装验收

新增受控本地测试Server，不读取真实密钥、不访问生产资源。Stdio验证直接node、参数带空格/Unicode/批处理特殊字符（防 CVE-2024-24576 注入）、保留设备名拒绝、cwd、stderr、超时、进程包装、子进程树及强制回收；HTTP使用loopback服务验证legacy/modern、固定Header、私网拦截、过大响应、断流、重定向和请求数。真实Server还需对 session-expired、鉴权重试、超时和断流分别记录 `tools/call` 计数，证明无隐式重放。

Windows与POSIX分别记录环境/Node版本/命令/退出码/进程存活证据。需要目标平台却无法执行时标未验证，不能以mock替代真实进程清理。Node20与当前CI Node版本分别执行本地pack安装；缺MCP配置的默认CLI、`--no-mcp`以及受控MCP调用均需要冒烟。

整体验证命令：`pnpm verify`（typecheck→test→lint，含架构/密钥）和 `pnpm dev:build`。build不代替typecheck，dev --verify-only必须与verify同源。

外部真实开源Server/真实模型属于独立小规模质量验证：只有有可用凭据和明确费用预算时执行，记录Server/版本/工具/协议/用量，未执行则列限制。真实npm发布/远端安装验收在发布授权后进行，不能在本地计划阶段自动尝试。

## 6. 文档与交付产物

- 阶段A产出 `docs/verification/v0.0.6-sdk-compatibility.md`，记录精确SDK版本、探测次数、服务端请求计数、取消/限长及平台证据。
- 接入各阶段同步 `docs/mcp.md` 的配置、启动/调用权限、生命周期、结果保留和Prompt用法；新公共API同步中文JSDoc。
- 功能完成后形成 `docs/migration/v0.0.6.md`、`docs/verification/v0.0.6.md`、`docs/releases/v0.0.6.md`，更新路线图/README帮助中的实际交付状态。缓存友好压缩需另行更新其版本归属，不能在本版验收记录中冒充完成。
- 所有实施checkbox仅在对应验证通过后勾选。规划产物存在不表示任何功能任务完成。

## 7. 风险、估算与停止条件

粗估单人15–20工作日；阶段A明确SDK和平台证据后重估。主要不确定性为现代/旧版协商、SDK响应限长包装、Windows进程树、目录 epoch 竞态及native续答前缀，不把默认参数调整当作安全规则变更。

若SDK无法证明两传输/两时代、服务端计数无法证明工具调用不重放、参数编码/进程树无法安全处理、调用快照会破坏既有技能/签名、旧JSONL不能兼容或三包类型检查漏扫，应停止依赖阶段并更新设计/specs/tasks后继续。不能删减测试来宣称门禁通过。

本地计划完成后可审阅方案并明确请求实施。实施、Git操作、发布和外部权限配置是不同动作，均遵守当次授权及仓库流程。
