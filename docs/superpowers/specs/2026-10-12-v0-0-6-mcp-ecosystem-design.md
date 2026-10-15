# Kapibala v0.0.6 MCP 生态接入技术设计

状态：2026-10-13 本地规划草案，尚未实现、验收或发布。用户要求先将讨论落实到本地；本文记录建议决策，不表示接口已经可用。当前工作区版本为 0.0.5。

关联：[开发计划](2026-10-12-v0-0-6-development-plan.md)、[OpenSpec 提案](../../../openspec/changes/v0-0-6-mcp-ecosystem/proposal.md)、[实施决策](../../../openspec/changes/v0-0-6-mcp-ecosystem/design.md)、[任务](../../../openspec/changes/v0-0-6-mcp-ecosystem/tasks.md)。需求场景以本变更 specs 为准，实施进度只在 tasks 维护。修改范围时同步四类规划文件，避免分别成为不同版本的答案。

## 1. 目标、现状与版本边界

版本主题为受控 MCP 接入：通过同一 AgentSession 消费外部 Tools 和用户 Prompt，并保持权限、审计、完整工具事务、消息级持久化及 Headless 约束。

本版明确**不包含缓存友好的上下文压缩专项增强及实测**。`docs/RELEASES.md` 保留该规划并标记版本待定；既有摘要、投影和完整事务约束继续有效，不因 MCP 目录稳定或结果预算而宣称缓存专项已经完成。本设计只记录 MCP 对上下文投影的必要边界。

已观察到的现状：ToolRegistry 有 source 注册/注销，但 registerSource 逐个提交，冲突可能留下部分工具；Loop 每步读当前注册表，Executor 按名称解析，尚未绑定模型所见目录；ApprovalRequest 没有远端执行身份；普通返回对象直接 JSON 序列化，只有 run_command 有专用业务失败判断；AgentSession.run 接受字符串，runSkill 是目前的专用任务注入入口；CLI 的类型检查和发布脚本只覆盖既有两个包。

| 必须交付 | 本版边界 |
| --- | --- |
| 独立 `@kiturone/kapibala-mcp` 包 | SDK/校验器依赖留在扩展包，Core 零运行时依赖 |
| Stdio、Streamable HTTP | HTTP 为固定 Header/Bearer 凭据；旧 HTTP+SSE 不自动回退 |
| Tools 与 Prompts 发现 | 有界分页、显式过滤、稳定命名和来源 |
| 动态上下线 | 运行期间撤销立即影响执行，新声明在下一 run 发布给模型 |
| 信任、启动和逐调用授权 | 项目路径信任不等于批准启动，annotations 不授予权限 |
| 多协议、取消、恢复和交付验证 | 模拟验收与外部真实 Server 验收分别记录 |

本版不提供 Resources 读取、OAuth、Sampling、Elicitation、MCP Apps、任务扩展、Code Mode、延迟工具搜索、自动安装和完整 TUI。Resource Link 可展示来源与 URI，但不能假装存在读取入口。二进制/多模态只提供省略说明。

## 2. 参考证据与选型

本地源码快照记录于 2026-10-12；表中的路径为 `F:/Project/aigc` 下的项目相对位置，仅作开发者参考，不是运行时依赖。

| 项目与快照 | 参考入口 | 采用的机制与取舍 |
| --- | --- | --- |
| Pi `cdaf6c227`（2026-10-11） | `pi/packages/coding-agent/docs/mcp.md`；`src/extensions/mcp/{tools,runtime.lazy}.ts` | 统一执行管线、稳定名称、结果预算；首版直接暴露，不引入 Code Mode/延迟搜索 |
| OpenCode `d21b0790a6`（2026-10-11） | `opencode/packages/core/src/mcp/{index,client,stdio}.ts` | 连接独立作用域、旧回调身份检查、分离超时；不照搬其 session-expired 后重放调用的恢复语义 |
| Codex `8c0f701167`（2026-10-11） | `codex/codex-rs/codex-mcp/src/{binding,client_tool_catalog,connection_manager}.rs` | 调用绑定目录版本与权限身份；采用单 Session、run 稳定快照，暂不建立跨会话连接池 |

截至上述日期，官方 latest 指向 [2026-07-28 协议](https://modelcontextprotocol.io/specification/2026-07-28)。[SDK v2 协议说明](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html)区分 legacy initialize 与 modern discover；Stdio auto 探测可能额外启动探测进程。[v2 升级文档](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2)声明 Node 20+。阶段 A 必须以安装产物和受控 Server 验证这些行为及版本稳定性，不能只依据文档承诺。

优先官方 v2 Client，精确版本与锁文件在兼容验证后确定；Stdio 默认 legacy，HTTP 默认 auto，用户可显式选择 legacy/modern。若拟选版本缺少所需兼容能力，停止扩展包实现并修订选型，不能静默删除一种传输或协议验收。SDK 内部差异封装在 transports，不泄漏到 Core。

## 3. 架构与公共契约

依赖方向为 CLI → MCP → Core 公共根导出，CLI 也直接使用 Core。Core 不导入 MCP/SDK；MCP 不依赖 CLI、终端、ANSI 或 Core 内部目录。基线“核心循环一行不改”的早期目标在本变更中细化为补齐通用扩展契约、不增加 MCP 专用分支；不声称实际零修改，也不调整用户维护的基线章节。

新增 `packages/mcp/src/{index,plugin,manager,config,identity,catalog,tools,prompts,results,errors}.ts` 与 `transports/{stdio,http}.ts`。文件粒度可按实现合并，职责保持分离。

`createMcpPlugin(config, hostOptions)` 建议返回 `{ plugin, controller }`：plugin 实现 AgentPlugin，controller 暴露状态快照、订阅、connect/disconnect/reconnect 和 Prompt 查询/准备。一个实例只挂载一个 Session；禁止全局单例或把连接移交到新 Session。teardown 幂等，setup 失败主动清理已取得的资源，因为 AgentSession.use 的失败插件不会进入销毁列表。

Core 增量使用通用契约，建议名称为：

| 契约 | 语义 |
| --- | --- |
| `ToolRegistry.replaceSource(source, tools)` | 预检候选批次自身重名与跨来源冲突后同步提交；任一冲突失败均不改变旧目录。跨来源覆盖默认禁止，不能删掉其他来源的胜出条目 |
| `ToolRegistry.snapshot()` | 返回不可变 `ToolRegistrySnapshot`，捕获只读定义列表、工具引用集合与来源版本；注册表后续变化不改写已有快照 |
| `Tool.validateInput?(input)` | 无副作用地校验最终参数，不修改参数、不访问远端；异常与拒绝均阻止审批和发送 |
| `Tool.executionIdentity?(input, rootDir)` | 本次执行身份；审批缓存与执行前复核消费，缺省保持旧工具规则 |
| `Tool.toExecutionResult?(raw)` | 显式 opt-in 转换为 `{ content, isError, errorCode?, retryPolicy?, execution? }`；普通对象继续作为业务输出 |
| `ToolResultBlock.execution?` | 可选 v1 执行事实 `{ version: 1, dispatchOutcome, hostError? }`；随 canonical 结果保存，不直接扩散 SDK 类型或发到 wire |
| `ApprovalRequest.executionIdentity?` | 纳入缓存键，供宿主展示目标摘要；不含凭据原文；`SessionApprovalCache.key` 深度哈希该字段 |
| `AgentSession.runPreparedTask(task, prepare, options)` | 同一运行锁内异步准备文本块/来源；预算和存储成功后才进入模型 |
| `AgentSession.getPlugins()` | 获取当前会话已成功挂载生效的所有扩展插件只读列表，供宿主查询状态与贡献 |
| `AgentPlugin.contributes?` | 声明式扩展贡献元数据容器（包含 `commands`、`skillsRoots` 等），解耦外部生态与具体宿主 |
| `PluginCommandContribution` | 纯元数据命令描述（`name`, `description`, `usage`, `mutates`），供交互宿主自动纳管，保持 Core Headless |
| `TextBlock.promptSource?` | 可选 v1 来源，序列化校验、历史/摘要/协议投影共同维护 |

Core `CAPABILITIES` 集合与 `Capability` 类型同步扩充通用能力 `external:call`，使 `validatePermissionRules` 与权限策略能合法校验与裁决外部调用。`validateInput` 得到的参数必须是最终参数快照；该快照同时供权限、审批缓存、身份计算和 transport 发送使用，禁止校验后再次静默改参。校验失败不应弹出工具调用审批。旧 Tool 不实现该方法时保持既有行为。

执行结果采用两个维度：`execution.dispatchOutcome` 表示远端事实（`not_sent`、`succeeded`、`failed`、`unknown`），可选 `execution.hostError={ phase: 'validation'|'projection'|'hook'|'audit', code: string }` 表示宿主处理故障，不保存原始异常或秘密。`failed` 不保证没有副作用；`unknown` 仅表示可能已经发送但没有可靠最终响应。已知成功但转换失败时，`isError=true` 表示宿主故障，同时保留 succeeded 和 `after_user_action`，闭合当前工具事务后暂停本轮，不能让模型自动重做。

MCP 适配器先判定可靠业务结果，再做投影；投影异常必须转成带已知事实的结果，而非抛到通用 unknown 分支。Executor 在结果钩子/审计前保存 execution，后续异常附加 hostError，不覆盖已知事实。旧结果没有 execution 仍可读，不凭空补成 not_sent。validators、序列化、历史、摘要和三 Provider 投影须保留语义：元数据不直接上 wire，但安全正文和摘要必须说明已执行/未知及不可自动重做。

持久化失败是 Session 提交失败，不伪装成已落盘的 hostError：停止后续发送并保留进程内已知事实；存储恢复后只允许补写原结果，不能重做远端调用。若未提交结果在进程退出后丢失，重启仍按既有缺失结果规则记录 OUTCOME_UNKNOWN，不承诺从未成功落盘的数据中恢复真实结果。

## 3.1 模型前缀、目录 epoch 与执行边界

v0.0.4 的原生协议要求合法工具续答的系统/工具前缀稳定。本版采用 run 级不可变工具快照机制：在任务运行锁生效、执行准备（`runPreparedTask` 的 prepare 阶段）开始时，从 `ToolRegistry.snapshot()` 捕获不可变运行视图 `ToolRegistrySnapshot`；从任务准备、预算校验到整个 run 的所有 turn 循环均通过该快照生成模型可见目录并解析执行实例，多步续答期间不注入新 MCP 定义、不改变既有 MCP Schema，完全杜绝因后台刷新导致中间步骤工具声明漂移的问题。模型可见目录和执行工具引用由同一快照产生，model:before 不能引入没有对应快照执行实例的名称。

每个 Server 的 Tools 与 Prompts 分别维护单调递增的 `catalogEpoch`。通知立即递增对应能力的 epoch 并暂停其未发送调用/提交；Tools 通知不误伤独立的 Prompt 目录，反之亦然。每次刷新捕获 client、connectionGeneration、能力类型、epoch 和唯一 refresh token，开始时消费 dirty；只有这些标识仍为当前值且期间无新通知，完整候选才可原子发布。候选摘要用于比较每项定义是否改变，不要求整份目录摘要等于旧目录。过期成功或失败均不得覆盖新状态。

每个能力同时最多一个刷新和一个 dirty 标记，不累计通知队列。一次刷新周期建议最多三轮，全部共享 catalogTimeoutMs 总截止；仍不稳定则保持 stale/unavailable 并结束周期，不能自旋或自动恢复权限。周期结束后新通知或显式重连可发起新的有界周期。完整复核成功后，同 Client/generation 且 toolDigest 未变的旧运行引用可以在最新 epoch 下恢复资格；原运行快照的 epoch 不要求永久等于当前值。正在等待审批的旧调用不能借此复用旧批准：其绑定 epoch 变化仍应零发送失败，下一次调用重新取得身份和授权。

所有异步准备、审批和发送前审计（包括 `await audit(...)` 与钩子）完成后，在实际调用 transport 发送方法（如 `client.callTool()`）之前同一同步执行微任务中完成同步资格、取消及参数快照复核；复核与调用底层 transport 发送方法之间严禁插入任何 `await` 或异步等待，利用 JS 单线程特性确保在无微任务让步的情况下完成检查并进入发送。复核失败直接返回 `MCP_TOOL_CHANGED` 或 `MCP_SERVER_UNAVAILABLE`，发送次数严格为零。该保证覆盖客户端在发起发送前已经观察到的撤销与变更，不要求不可实现的 socket 级出队 hook，也不承诺服务端实现与检查同步。不能把已复核的旧实例换成同名新实例。

断连、撤销、身份漂移立即撤销旧引用的执行资格；本轮声明仍保留以维护协议前缀，调用时返回 MCP_TOOL_CHANGED/MCP_SERVER_UNAVAILABLE 并闭合结果。旧定义从下一 run 的模型目录消失。已发送调用不因为目录撤销而伪装成未执行，等待真实结果或报告未知。

连接状态与能力状态分开维护：连接可为 disabled、blocked、connecting、ready、failed、disconnected、closing；Tools 与 Prompts 分别可为 unsupported、pending、ready、stale、unavailable。连接 ready 不代表任一能力 ready。required Server 的判定是：声明 Tools 时 Tools 必须 ready；Prompt-only Server 时 Prompts 必须 ready；混合 Server 的 Prompt 失败不得撤销已经 ready 的 Tools，也不单独阻止普通工具任务；用户执行 Prompt 必须其目录 ready。没有声明任何本版支持能力的 required Server 不就绪。

保持既有 Skill 激活/收紧及签名保护流程；不能为了目录过滤重排受保护 continuation。既有 Skill 若声明当前未连接的精确 MCP 名称，沿用未知工具拒绝，提示先连接后重新激活，不扩大为隐式白名单。

## 4. 配置、信任和执行身份

CLI 读取 `~/.kapibala/mcp.json` 和 `<projectRoot>/.kapibala/mcp.json`，使用 `{ mcpServers: Record<string, ServerConfig> }`。SDK 接收显式 config，不隐式扫描 home。无配置文件即禁用 MCP，不启动进程/网络、不增加问答等待。

Server 名称必须满足严格命名规范以避免在 Prompt ID（`<server>/<prompt>`）和工具名（`mcp__<server>__<tool>`）中产生解析歧义：必须匹配 `^[a-zA-Z0-9_-]+$`，长度 1–64 字符，显式禁止包含斜杠 `/`、反斜杠 `\` 以及连续双下划线 `__`；违规命名在配置解析阶段直接判定为 `MCP_CONFIG_INVALID` 并拒绝。

ServerConfig 为 stdio/http 判别联合：stdio 包含 command、args、cwd、env，http 包含 url、headers；共享 enabled、required、protocol、includeTools、excludeTools、startupTimeoutMs、catalogTimeoutMs、requestTimeoutMs。协议配置为 legacy/auto/modern，现代模式固定使用已验收的 SDK modern 行为，不能把字符串当任意版本支持承诺。

相同 Server 名称按项目整项覆盖用户定义；只含 `{ enabled: false }` 的项目条目为禁用覆盖，不需补齐传输。数组不拼接、嵌套对象不跨来源补字段。受信任项目方可读取并应用声明；未信任项目诊断并排除，其同名声明不得覆盖用户定义。有效禁用覆盖保留禁用，不回退到全局副本。名称/配置错误局限于当前条目，required 条目无效则任务失败。

所有输出包含 global/project、配置文件、覆盖关系、连接状态；凭据/敏感路径按展示策略脱敏。`/mcp enable|disable` 默认只改变当前 Session，来源文件保持不变；本版无配置写入命令，用户手动维护文件。配置变更通过下一启动重新解析；reconnect 仅使用当前已授权配置，不能顺手加载新命令。

HTTP 默认要求 HTTPS，仅回环地址可显式使用 HTTP；禁止 URL 内嵌用户密码。连接前解析并校验目标 IP：默认拦截所有私有网段与受限保留地址：
- IPv4: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (私网 RFC 1918)；`169.254.0.0/16` (链路本地/云元数据，含 `169.254.169.254`)；`100.64.0.0/10` (CGNAT RFC 6598)；`0.0.0.0/8`；`224.0.0.0/4` (组播)；`240.0.0.0/4` (保留)
- IPv6: `fc00::/7` (唯一本地 ULA RFC 4193)；`fe80::/10` (链路本地)；`ff00::/8` (组播)；`::/128` (未指定)；IPv4 映射地址 `::ffff:0:0/96` 解包后按 IPv4 规则校验

仅显式回环地址允许访问（IPv4 `127.0.0.0/8` 全段、IPv6 `::1/128` 以及主机名 `localhost`）。显式配置域名白名单仅放行主机名声明，连接建立时底层 Socket Remote IP 仍必须经过上述私网/保留地址复核，禁止白名单域名通过 DNS 解析到内网地址以防御 SSRF 与 DNS Rebinding 攻击。重定向不得自动跨目标转发鉴权 Header；跨 origin/安全等级变化作为新执行目标拒绝并要求修改配置重新授权。凭据按 Server 身份隔离，不复用模型密钥的厂商族回退规则。仅声明已实现的客户端能力，不宣告 Sampling/Roots/Elicitation/Tasks 等延期能力。

只支持 `${NAME}` 环境变量插值，不执行 `!command`、`$()` 或模板脚本。变量缺失为 MCP_CONFIG_INVALID，不使用空字符串继续。HTTP 凭据必须使用环境变量引用，拒绝明文 Authorization/API Key 类值；Stdio 显式 env 的普通值可用 literal，凭据要求环境引用。Stdio 继承 SDK 必需的基础变量（如 PATH、SystemRoot、HOME/TEMP 等平台最小集合）和 env 明确列出的键，禁止整份 process.env。项目级配置若插值了全局敏感环境变量（命中 `*_KEY`, `*_TOKEN`, `*_SECRET`, `OPENAI_*`, `ANTHROPIC_*` 等模式），启动审批 descriptor 必须标记高危凭据外发预警（Credential Alert），显式向用户列出被引用的敏感宿主变量名，防止恶意仓库钓鱼窃取宿主核心凭据。cwd 相对值以声明配置所属根解析：项目配置按 native 物理项目根，用户配置按用户配置目录；缺省 cwd 为当前物理项目根，审批身份包含最终绝对路径。command 经受控 PATH 解析为具体目标后授权并复核，禁止 Windows 保留设备名（`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9` 及其带扩展名形式）作为 command 或 cwd，可识别本地脚本额外绑定内容摘要。

启动前宿主 `authorizeServerStart(descriptor, signal)` 回调；缺省仅能运行已显式预授权的 SDK 配置，其余拒绝。CLI 复用 PermissionPolicy/审批通道及独立 Session 启动缓存，descriptor 描述 exec/网络连接、目标、args、cwd、环境变量名称与敏感值摘要及高危凭据告警，不假装走 run_command 文本解析。项目路径信任只允许采用声明，不自动允许启动；授权等待期间复核目标。

FullAccess 不能替代项目信任或宿主硬拒绝。`--no-mcp` 先于解析插值/启动，所有后续 enable/reconnect 不得绕过。非交互需预授权，否则返回可操作拒绝；没有审批通道不能默认为允许。启动授权和工具调用授权是两个独立决策，前者的 allow_once 不得自动批准后者。

身份分为 `serverIdentity`、`connectionGeneration`、`catalogEpoch`、`toolDigest`。serverIdentity 绑定物理配置作用域、解析命令/端点、args/cwd、环境与凭据来源、可识别脚本摘要；授权使用的敏感值变化通过宿主内存修订标记或带密钥摘要检测，不把低熵密钥裸 hash 写入日志。该身份不能证明外部服务端实现不变，也不能把 Server 提供的路径约束当作 OS 沙箱。

## 5. 连接状态、目录发布与资源清理

每 Server 独立管理连接状态和 Tools/Prompts 能力状态，使用 generation 防迟到回调。重连显示 connecting，保留最近失败诊断；不建立无限后台重试。

建议默认值（可由有效配置/宿主收紧）：连接并发 4；startup 10s；catalog 10s；request 60s；本地 cleanup 5s。startup 截止涵盖启动、协商和初始目录发现，不是分别累加；全体启动等待也有宿主总期限 15s，required 未就绪阻止任务。Prompt 目录失败记录 unavailable，不冒充零个 Prompt，也不撤销已成功 Tools。

上述技术等待期限在必要人工启动批准完成后计时；审批由输入所有者串行处理且可取消，不以用户阅读审批的时间消耗连接期限或擅自批准。未声明 tools 能力的 Prompt-only Server 跳过工具发现，以其声明且本版支持的能力发现结果判定 ready；初始目录失败和合法空目录必须区分。

setup 在有限等待后返回可用/失败状态并释放全部失败资源，禁止遗留未受管的启动 Promise。背景变化不直接向终端输出，controller 发布安全事件。状态订阅使用可取消句柄，teardown 释放全部监听器与定时器。

目录操作支持全部分页。建议每类每 Server 最多 20 页、200 条，cursor 重复或预算超限停止发布新目录；保留旧目录并标 stale。输入 Schema 建议单工具 32 KiB、深度 20，总模型 MCP 定义预算 64 KiB、最多 64 个工具。Server 按配置名、工具按原始名稳定排序，按整项截取；未展示工具在本 run 不可调用，诊断列出 omitted，用户可用 includeTools 精确筛选。最终 ContextManager 仍检查完整请求预算。

无效单工具可剔除并诊断；原始重复名、不可消解的命名冲突或分页不完整导致整份候选不发布。`replaceSource` 同步原子提交合法候选；跨连接回调必须在 generation/client/epoch/refresh token 匹配后才提交。合并通知和重复刷新统一遵循 §3.1 的有界周期，不另设第二套 dirty 规则；未达到最新 epoch 的刷新永远不能恢复执行资格。

Stdio stdout 仅做协议，stderr 尾缓存默认 8 KiB，诊断脱敏且限速；不自动转为模型指令。退出清理先关闭 stdin/连接，再按平台回收进程树。启动命令优先直接执行原生可执行程序（`.exe` 或通过 `node.exe` 启动脚本）；Windows `.cmd` / `.bat` 不通过不受控 `shell:true` 执行，必须遵循 CVE-2024-24576 修复规范进行参数字符校验与严格转义包装，禁止未转义特殊字符（如 `&`, `|`, `%`, `^`, `"`）引发批处理命令逃逸。关闭、重连、Session 销毁先撤销可调用资格，再取消/等待本地请求，最后回收连接/进程树；超期限后强制回收并报告失败，禁止假装已清理。

单次调用取消不必关闭整个 Server。若 SDK 无法在截止内解除本地等待，关闭对应连接并完成本地未知结果记录；这不能保证远端副作用停止。进程树清理语义须用真实 Windows/POSIX 进程证明，不能只依赖 close() Promise。

## 6. 工具适配与执行权限

规范名称为 `mcp__<server>__<tool>`，允许模型协议的安全字符并限制到 64 字符；发生清洗、超长或碰撞时加入由原始 Server/Tool 身份产生的稳定摘要。不能用本次发现顺序决定谁保留短名；保留 `source=mcp:<server>` 与原始名称映射。

输入 Schema 由扩展包的 SDK/校验器验证；禁止远端 `$ref`、运行时代码和自动网络取 Schema，不能为迎合 Provider 静默删掉约束。将所需 Schema 子集无法适配的工具标 unavailable。每次模型钩子运行后，以同一最终参数快照执行无副作用 `validateInput`；校验拒绝或异常在审批前闭合工具结果，发送次数为零，不触发人工批准。校验、审批和发送不得各自构造不同参数。

新增通用 Capability `external:call`（Core `CAPABILITIES` 集合与 `Capability` 类型同步扩充该项以通过规则校验）；HTTP 再声明 `net:outbound`，stdio 的每次工具请求声明 `external:call`。Server annotations 为不可信辅助展示，不推导 `fs:read`/`exec`，也不自动放行。默认 dangerous=true；显式 capability/tool allow 沿用既有规则，deny 与硬拒绝仍优先；Plan 始终拒绝，FullAccess 仅作用于当前会话裁决。`ApprovalRequest.executionIdentity` 包含 serverIdentity、connectionGeneration、catalogEpoch、toolDigest，`SessionApprovalCache.key()` 必须将 executionIdentity 与最终参数快照共同深度纳入哈希，确保断连重连或目标变化后绝不命中旧 allow_session 缓存。

工具执行只经过 ToolExecutor：最终 hook 参数 → 扩展包参数校验 → Skill 硬限制/权限 → 人工审批 → 身份、epoch 和连接复核 → 发送 → 结果钩子/审计 → Session 落盘。controller 不公开绕过此管线的模型工具调用入口。最后资格复核完成后若发现目录/身份变化，必须零发送失败，不能切换同名新实例继续调用。

## 7. 结果、审计、取消与恢复

文本 content 转为文本；structuredContent 确定性序列化并保留，避免重复输出完全相同 JSON。`isError=true` 转成 canonical 业务错误，安全反馈允许模型调整参数；不靠工具名专判。协议异常、业务失败、宿主校验/投影失败和未知结果区分错误码。

适配器结果使用 §3 的 `execution v1`：发送前失败为 not_sent；收到有效业务失败为 failed；收到有效成功为 succeeded；可能已发送但无可靠最终响应为 unknown。宿主转换、after-hook、审计故障附加 hostError，不覆盖已确定的远端事实；已有可靠响应但宿主校验失败不等于远端业务失败。无法验证出可靠业务状态的畸形响应仍为 unknown，不能仅凭 HTTP 200 认定 succeeded。未知结果或已知成功后的宿主处理故障使用 after_user_action，闭合本轮后等待用户处理。落盘失败遵循 §3 的提交边界，不承诺跨崩溃保留未提交结果。

首版 canonical 保持 string content，不新增图片/音频块。对图片、音频、嵌入二进制记录类型/大小及“未传递”标记，不落 Base64、不下载链接。Resource Link 仅保留 URI/名称/描述；私有 `_meta` 丢弃，只允许经过审阅的非敏感字段。

模型可见/历史保存的转换结果默认 20 KiB UTF-8，总线协议响应硬上限建议 4 MiB；必须在传输或有界解码处限制，不能先无限累积再检查。文本截断保留首尾与 omittedBytes；结构化结果放不下时按完整 JSON 项摘要/省略，不能返回破碎 JSON。原始大结果不承诺留存，CLI detailed 只能展开实际保留的安全内容。转换省略不改变已知远端业务成功；转换异常使用 MCP_RESULT_INVALID，并携带远端状态已知事实。

应用、SDK 和 transport 均不得重新发送已经发送的 `tools/call`。连接恢复、响应流续接或 session-expired 重建不等于业务调用重试；阶段 A 必须使用受控 Server 的服务端请求计数覆盖断流、超时、会话失效和鉴权重试。仅目录查询等幂等发现操作可在原截止时间内有限重试；这不允许重放 tools/call。若无法证明 SDK 不会隐式重放，停止后续实现并修订选型。

| 情况 | 结果与重试 |
| --- | --- |
| 发送前权限/参数/身份失败 | `not_sent`，never 或 after_user_action |
| 收到有效业务失败 | `failed`/MCP_TOOL_ERROR，保留安全反馈；相同调用不自动重放 |
| 收到有效成功 | `succeeded`，保存真实结果，包括取消前已完成调用 |
| 已发送、超时/断连/取消且无可靠响应 | `unknown`/OUTCOME_UNKNOWN，after_user_action；不自动重放 |
| 目录查询瞬态失败 | 最多两次额外尝试，均受原截止时间限制 |

请求完成/取消始终清理本地句柄，取消通知按协议时代委托 SDK，不承诺服务端回滚。`managesTimeout=true` 的 MCP 适配器负责单次调用期限和本地收口，禁止 Executor 通用 Promise.race 提前释放锁。

审计记录 server/source、generation、catalogEpoch、toolDigest、目标非敏感摘要、实际模型、关联 run/toolUseId、发送阶段、业务结果和未知结果。startup/执行必须在审计成功后发生；审计失败拒绝尚未发送操作，已发送则保留已知真实结果或未知事实。`tool_use` 一旦落盘，全部调用（含拒绝/跳过/失败）仍闭合为 tool_result。消息 append 失败、消费者 return、Ctrl+C、Session 切换均沿用既有等待/锁规则；连接关闭不替代历史闭合。

恢复读取已保存安全内容和来源，不连接旧端点、不重新获取 Prompt、不执行旧 tools/call、不恢复旧信任或审批；本次当前配置连接是新的授权过程。来源字段只供解释/审计，不作为执行资格。

## 8. Prompt 与受控任务准备

PromptRegistry 提供 stableId、server/name、description、arguments、source、availability、generation 查询；SDK/CLI 共用。命令稳定 ID 为 `<server>/<prompt>`，不与工具名称混用。目录有界且支持分页/刷新，不预取正文；用户显式调用才携带参数请求 `prompts/get`。

`runPreparedTask` 的 prepare 回调在 Session 与 ActiveSessionController 同一 busy/取消范围内执行；模型不可借该回调伪造 caller=user。首版参数为 `JSON object<string,string>`，按照 Prompt arguments 检查必填/未知参数，不默默删字段；错误先于远端请求。命令展示、provenance 和诊断不重复保存原始参数；但用户任务正文可能包含参数，并进入模型、历史及摘要，本版不承诺对用户主动提交的秘密做自动脱敏。服务器获取失败、取消、Prompt 身份改变或输入预算不足时释放锁，不追加半份任务；Store append 成功后才启动模型。

`prompts/get` 的获取也先经过宿主硬限制、模式和精确权限规则（external:call，HTTP 追加 net:outbound）；用户显式 `/prompt` 可作为该次获取的 allow_once 意图，不能覆盖 Plan、deny 或宿主拒绝。取得模板不批准模板随后建议的工具执行。获取前及结果提交前核对 Prompt 的 client/generation/epoch/digest；准备期间 epoch 变化则本次准备失败，即使新目录复核表明名称未变也需用户重新调用。变更通知未复核时拒绝获取/提交。提交采用同步最终检查后立即进入消息提交的本地边界；消息 append 在途之后发生的通知不撤回该既有提交，不自动重取模板。

远端返回 user/assistant 多条消息按顺序转成一段带角色标签的 user 任务上下文，不伪造真实 assistant 响应、不提升为 system。仅支持文本；包含无可读文本或不可安全表达的必需二进制块时明确 MCP_PROMPT_UNSUPPORTED，不把部分模板当完整成功。服务器 instructions 只作来源说明或独立有界辅助文本，不改宿主系统规则。

单条本轮 user 消息包含不带 arguments-json 的调用标识（`/prompt <server>/<name>`）、用户显式任务正文（如有）和独立 Prompt 内容块；不复制完整原始命令。模板可能回填参数并进入正文，应用不保证秘密脱敏，也不能清除终端输入回显或外部 shell 历史。`promptSource v1` 建议为 `{ server, name, scope, contentDigest, configIdentity }`，不保存认证值或重复保存原始参数。来源允许旧历史缺省，无新会话 schema；更新 validators/history/summary/Provider 投影，元数据不发到 wire，不从它恢复授权。有 Store 时事件 `mcp_prompt_loaded` 在关联消息提交成功后发布；无 Store 时完整内存历史为边界并标 memory。

## 9. CLI、SDK 与会话所有权

命令为 `/mcp`、`/mcp tools <server>`、`/mcp reconnect|enable|disable <server>`、`/prompts [query]`、`/prompt <server>/<name> <arguments-json>` 与 `/plugins [name]`（别名 `/plugin`）；CLI 支持 `--no-mcp`。`/plugins`、`/mcp` 与列表命令只查询本地快照，忙碌时可用，不隐式连接。重连/开关/Prompt 为变更动作，运行、审批、任务准备和清理期间拒绝重入。

CommandDispatcher 注册上述命令并支持从已挂载插件中读取声明式贡献；动态 Prompt 通过 Registry 搜索和固定 `/prompt` 入口执行，不产生大量同名 Slash 注册。Tab 可补全 server/prompt 稳定 ID，完整模糊命令面板仍留待 v0.0.8。工具过程保留 MCP 命名空间和来源，使用现有 summary/detailed；非 TTY 输出无 ANSI、无交互等待。`/plugins` 命令为终端提供统一扩展观测入口，清晰展示当前会话已挂载插件、版本、描述以及贡献的交互命令与生态服务统计。

ActiveSessionController 的新建/恢复工厂为目标创建独立 MCP 插件，并先校验配置/授权；required 失败则保持旧 Session。切换发布后回收旧连接，清理失败沿用 retired 所有权供重试。新旧独立实例在准备期可短暂并存，启动总数受宿主限制；会话启动授权缓存只属于对应会话，不跨项目转移。

SDK hostOptions 提供 authorizeServerStart、预授权身份、eventLogger、状态订阅与配置作用域；缺省无 home 扫描、无 UI、无隐式启动许可。授权与任务回调可用于 GUI/服务宿主，不能要求终端输入。

## 10. 工程、验证和迁移

扩展 tsconfig.check.json 的 paths/include、MCP 包 tsconfig/tsup 与声明构建；Vitest 已用 packages/*/tests 通配，但要证明新包测试确实收集。开发入口 workspace 链接自愈函数（`scripts/dev.mjs` 中的 `repairWorkspaceLinks`，其实现已基于 `readWorkspacePackages()` 动态收集全部工作区包）确保覆盖完整三包依赖拓扑：
1. `packages/cli/node_modules/@kiturone/kapibala` → `packages/core`
2. `packages/cli/node_modules/@kiturone/kapibala-mcp` → `packages/mcp`
3. `packages/mcp/node_modules/@kiturone/kapibala` → `packages/core`
4. 根工作区 `node_modules/@kiturone/kapibala` → `packages/core`（及根目录按需链接）
对退化为空目录的 workspace 链接均以 Windows native junction 重建，保持 native 物理路径身份和 `.cmd` 纯 ASCII 语法。

架构门禁增加 MCP 包不得导入 Core 内部或 CLI/终端的检查；构建和包 tarball 验证 Core 无运行时依赖、MCP 只导出受控契约、CLI workspace 依赖打包为精确版本。

release.ts/flow.ts/Actions 统一以可复用发布清单精确枚举五处版本真源文件路径：
1. 根目录 `package.json`
2. `packages/core/package.json`
3. `packages/mcp/package.json`
4. `packages/cli/package.json`
5. `packages/cli/src/version.ts` 中的 `CLI_VERSION`
彻底消除手写两包或三个 manifest 的数量假设。发布顺序严格固定为 Core→MCP→CLI，同步 trusted publishing、pack/checksum、失败重试与安装 smoke；新 npm 包的 Trusted Publisher 配置属于外部发布前置条件，不能假装代码修改即可完成。

规划阶段不改版本号。阶段 A 具有严格的**阻断性门禁准则**：必须通过真实计数受控 Server 验证应用/SDK/transport 对业务 `tools/call` 的发送计数至多为 1 次，并**按协议时代区分失效形态**：
- **Legacy 模式**：覆盖 session-expired、404 session missing、断流、超时、取消；
- **Modern 模式**（2026-07-28 规范，无 Mcp-Session-Id）：覆盖 401 鉴权过期/挑战、400 HeaderMismatch/ProtocolMismatch、断流、超时、取消；
若 SDK v2 存在无法在 transport 配置中关闭的隐式重试，则该阶段立即终止并修订选型，严禁带着隐式重发隐患进入后续实现。实现后执行 `pnpm verify`、`pnpm dev:build`、Node20/当前 CI 版本打包安装和 Windows/POSIX 进程验收；付费模型与外部 Server 验收仅在有可用凭据/预算时执行并单独报告。

向后兼容：旧配置缺省无 MCP；旧 Tool 不实现新可选方法则语义不变；旧 JSONL 无 promptSource 可读；MCP 源不按内置 fs:read 剪裁。回退通过 `--no-mcp`/配置关闭停止新接入，历史只保留安全文本；不得移动已发布标签或覆盖版本。

## 11. 风险、完成条件与实现者可决定项

| 风险 | 处置与完成证据 |
| --- | --- |
| 原生协议续答受目录变动破坏 | run 稳定声明、epoch/refresh token、发送前复核；三 Provider 多步回归 |
| SDK/transport 隐式重放已发送调用 | 服务端请求计数按时代覆盖 legacy(session失效)/modern(401/400) 及断流/超时；不能证明则停止实现 |
| 参数在审批后被 hook 或校验器改变 | 最终参数单一快照；校验失败零审批零发送 |
| 已知远端成功被宿主错误改写为未知 | execution v1 分离 dispatchOutcome 与 hostError；已提交历史/审计保留事实，未提交跨崩溃结果不作保证 |
| 连接与能力状态混用 | 连接状态、Tools 状态、Prompts 状态分别建模并测试 required 判定 |
| Stdio 任意副作用与进程包装 | 启动目标明确授权、最小环境；不宣传为 OS 隔离；真实进程树清理 |
| 项目配置插值跨域敏感凭据外发 | 启动审批显式标记高危凭据告警并列出敏感变量名；禁止未授权跨域外发 |
| HTTP 私网穿透/SSRF 与 DNS Rebinding | 连接前拦截 RFC 1918 私网段与 169.254/16 元数据；Socket 建立后复核底层 IP |
| Windows 批处理参数逃逸与保留设备名 | 严格参数字符校验与安全转义包装（防 CVE-2024-24576）；拒绝 CON/PRN/AUX 等设备名 |
| 审批缓存漏绑身份致同名工具绕过 | `SessionApprovalCache.key` 深度哈希 `executionIdentity`；单测断言重连/换脚本后零命中 |
| 远端操作结束状态不可判定 | OUTCOME_UNKNOWN、禁止自动重放，不声称服务端回滚 |
| 目录/结果导致内存与上下文膨胀 | 分页/Schema/传输/结果有界，完整请求预算兜底 |
| Prompt 参数与秘密混入历史 | 不在 provenance/诊断重复回显，明确用户正文仍可能持久化，不承诺自动脱敏 |
| 新包遗漏开发/发布链路 | 本地 pack/安装与清单一致性测试，外部可信发布独立记录 |

必须完成 Tools + Prompts、两种传输、权限身份、原生续答、消息闭合、真实跨平台清理与三包安装验收，才能声明 v0.0.6 MCP 功能交付。缓存友好压缩不属于本版完成条件；Resources/OAuth 等延期能力不得在帮助或 README 冒充现成能力。

实现者可决定：SDK 的精确补丁版本、内部文件合并、校验器实现、诊断文案和状态订阅底层。上述决定需满足本文边界并记录验证；变更协议支持、授权默认值、结果恢复或版本范围须先更新规划并重新评审。15–20 工作日为粗估，不是交付承诺。
