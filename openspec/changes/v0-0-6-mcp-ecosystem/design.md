# Design: v0.0.6 受控 MCP 生态接入

## Context

动机见 [proposal](proposal.md)，源码证据、建议接口与预算见 [技术设计](../../../docs/superpowers/specs/2026-10-12-v0-0-6-mcp-ecosystem-design.md)。当前 source 注册非原子，调用/审批缺少远端版本身份，普通对象结果不会映射业务失败；既有 native continuation、Skill 收紧与历史闭合必须保留。本文为 2026-10-13 优化后的规划，不是实现或验证记录。

## Goals / Non-Goals

**Goals:** 让独立 MCP 扩展通过同一会话、执行器与持久化消费 Stdio/HTTP Tools 和用户 Prompt，提供确定的权限、目录更新、失败与清理行为。

**Non-Goals:** 本版不建立跨会话连接池、Code Mode、Resources/OAuth/反向请求/UI 子系统，也不把 Server 自述的路径或 readOnlyHint 当作 OS 沙箱或授权依据。缓存友好的上下文压缩专项增强与实测另行排期、目标版本待定；现有压缩约束继续有效。

## Decisions

### D1. 独立扩展与实例所有权

MCP 包只依赖 Core 根导出及 SDK/校验器。createMcpPlugin 返回插件和 controller，一个实例只挂载一个 Session；setup 部分失败自行回收，teardown 幂等。Core 增加通用原子 source 更新（含候选批内自身重名预检与跨来源冲突检测）、快照、无副作用最终参数校验、执行身份、显式结果转换与任务准备入口，并将通用能力 `external:call` 纳入 Core `CAPABILITIES` 集合与类型，不出现 MCP 专用循环分支。这是对早期基线“一行不改”目标的通用契约补齐，不声称实际零修改，也不修改用户维护的基线章节。替代方案是在 CLI 单独执行远端工具，会绕过审计/权限并产生两套闭合语义。

### D2. run 稳定目录、epoch 与即时撤销

工具快照绑定模型定义/执行实例，MCP 定义固定到本次 run：在任务运行锁生效、执行准备（`runPreparedTask` 的 prepare 阶段）开始时，从 `ToolRegistry.snapshot()` 捕获不可变运行视图，从任务准备到整个 run 的所有 turn 循环均通过该快照生成模型可见目录与解析执行实例，多步续答期间不发生声明漂移。新定义下一 run 生效，断连或变更立即撤销旧实例执行资格，保留本轮声明以满足 native continuation；旧调用失败闭合，不转调新实例。replaceSource 预检批内自身重名与跨来源冲突后同步提交，失败保留旧目录。替代方案是每步实时改 Schema，会破坏既有原生签名/私有推理前缀约束。

Tools/Prompts 各自维护 catalogEpoch。通知递增对应 epoch、暂停该能力的未发送调用/提交；刷新捕获 client、connectionGeneration、能力类型、epoch 和唯一 refresh token，开始消费 dirty。仅这些标识仍有效、期间无新通知且完整候选验证通过才能发布；候选摘要用于判断定义是否变化，而非要求新旧全目录相同。过期成功/失败均不能覆盖新状态。

每能力同时一个刷新和一个 dirty 标记；每周期最多三轮，共享 catalogTimeoutMs，持续变更超限保持 stale/unavailable。结束后新通知或显式重连可发起新周期，不自旋、不超时恢复旧权限。同 Client/generation 且 toolDigest 未变的旧运行引用可在完整复核后取得最新 epoch 的资格，不要求运行快照原始 epoch 永远相同；等待审批的旧调用若 epoch 变化仍零发送失败，新调用须重新授权。

全部异步准备、审批和发送前审计（包括 `await audit` 与钩子）完成后，在实际调用 transport 发送方法之前同一同步执行微任务中检查当前资格、取消及参数；检查与底层发送之间严禁跨 `await` 或发生事件循环让步。该保证覆盖客户端在发起发送前已经观察到的撤销，不要求不可实现的 socket 级出队 hook，也不是对服务端实现的锁定。失败旧目录仅供诊断，下一 run 不广告；required 依其能力就绪规则阻止新任务。

### D3. 配置、启动与凭据

用户/项目 mcp.json 按 Server 整项覆盖，Server 名称必须符合 `^[a-zA-Z0-9_-]+$`（长度 1–64）且禁止 `/`、`\` 与 `__` 以免 Prompt ID 与工具命名歧义；项目禁用是合法收紧，未信任项目排除不遮蔽全局。SDK 显式配置不扫 home。cwd 按声明根解析，command 解析真实目标后启动授权，禁止 Windows 保留设备名（CON/PRN/AUX/NUL 等）作为目标或目录；环境为基础白名单加显式 env，只支持 ${NAME}。项目级配置若插值宿主敏感凭据（如 `*_KEY`/`*_TOKEN`），启动审批 descriptor 必须标记高危凭据告警并列出变量名。HTTP 凭据要求 env 引用。启动审批绑定目标/脚本摘要并复核，缺省不启动未授权定义。FullAccess 不替代信任。替代方案把项目信任当永久命令批准，无法让变化目标的批准失效。

HTTP 要求 HTTPS（回环支持 IPv4 `127.0.0.0/8` 全段、IPv6 `::1/128`、`localhost` 可显式 HTTP），拒绝内嵌密码/跨目标重定向，连接前全量拦截私网及受限保留地址（IPv4: RFC 1918、169.254/16、CGNAT 100.64/10、0.0.0.0/8、组播/保留；IPv6: ULA fc00::/7、fe80::/10、组播、::/128、IPv4-mapped 等）；显式域名白名单仅放行主机名声明，底层 Socket 建立后仍必须复核 Remote IP 以防御 SSRF 与 DNS Rebinding；不跨 Server 复用或转发鉴权；只声明本版客户端能力。技术启动截止从人工授权完成后计时，审批可取消而不自动批准。启动许可不继承为工具调用许可。

### D4. 两传输与有界生命周期

优先验证官方 v2 Client；Stdio 默认 legacy、HTTP auto，显式 modern 可用且须验收。每 Server 独立 generation 防迟到回调。默认并发4、startup10s/catalog10s/request60s/cleanup5s、整体启动15s。重连仅手动，关闭回收本地请求及进程树；Stdio 优先直接执行原生可执行程序，Windows .cmd/.bat 遵循 CVE-2024-24576 修复建议限制参数字符与安全转义包装，先以真实进程验证。替代方案无限后台重试会制造启动副作用和输入竞争。

连接状态与 Tools/Prompts 能力状态分开：连接 ready 不等于目录 ready。能力区分 unsupported/pending/ready/stale/unavailable。required 声明 Tools 则要求 Tools ready；Prompt-only 要求 Prompts ready；混合 Server 的 Prompt 失败不撤销 ready Tools，但用户调用 Prompt 必须其目录 ready。无本版支持能力的 required Server 不就绪，合法空目录不同于发现失败。optional 故障有诊断且不阻断其他能力。

### D5. 有界目录与执行权限

稳定 mcp__server__tool 名称，清洗/超长/碰撞用身份摘要而非发现顺序。分页20页/200项、Schema32KiB/深20、模型MCP定义64KiB/64工具；超额整项省略且诊断，不可调用遗漏项。扩展包验证 Schema，禁止远端 ref 和静默删约束。

Tool.validateInput 是可选无副作用校验接口，在最终 hook 改参后、权限审批前执行；禁止强制转型、填默认值、删字段或访问远端。校验拒绝/异常零审批零发送；校验、权限、缓存、身份和发送共享同一最终参数快照。旧 Tool 缺省语义不变。

external:call 为通用能力，HTTP 追加 net:outbound；默认 dangerous，Plan 拒绝、其他按显式规则/审批；Skill 硬限制优先。`ApprovalRequest.executionIdentity` 深度纳入 `SessionApprovalCache.key()` 的哈希计算（包含目标、generation、当前 epoch、toolDigest 及参数），发送前复核，断连重连后旧 allow_session 失效。替代方案把 readOnlyHint 映射 fs:read 会造成无沙箱自动授权。

### D6. 结果事实与宿主故障分离

opt-in 转换正确处理 isError/structuredContent，普通对象旧语义不变。canonical 可选 execution v1 为 `{ version: 1, dispatchOutcome: 'not_sent'|'succeeded'|'failed'|'unknown', hostError?: { phase: 'validation'|'projection'|'hook'|'audit', code: string } }`。可靠业务结果判定先于投影；failed 不保证无副作用，未知只用于可能已发送且无可靠结果，不能仅凭 HTTP 200 判断成功。

已知远端结果不能被转换、after-hook 或审计失败改成 unknown；追加 hostError 并保留事实。已知成功但宿主处理失败使用 isError 和 after_user_action，闭合事务后暂停本轮，不能自动重做。元数据随结果校验/序列化保存，旧历史缺省可读；Provider 不直接透传元数据，但安全正文及摘要保留已执行/未知说明。

append 失败停止后续发送并保留进程内结果；恢复存储只补写结果、不重做调用。若未提交结果在崩溃后丢失，恢复仍按 OUTCOME_UNKNOWN 闭合，不承诺未落盘结果跨重启可知。

转换结果20KiB、协议输入4MiB有界，非文本省略、Resource Link不自动读取、私有_meta不透传。应用、SDK和transport不得重放已发送 tools/call；按协议时代分别以服务端请求计数覆盖 legacy（session-expired/404）与 modern（401/400）以及鉴权重试、断流和超时，断言至多发送一次。目录查询可在原截止内有限重试，响应流续接不得重新调用工具。MCP 适配器管理 timeout 并等待本地收口；通用 Promise.race 不能提前释放锁。

### D7. Prompt 的用户语义和提交边界

PromptRegistry 仅列元数据，用户显式以 server/name 调用，字符串对象参数按必填/未知校验。runPreparedTask 在 Session/Controller 同一 busy/取消范围内取得并验证完整文本，失败不追加任务。多角色模板带标签转 user 上下文，不伪造 assistant/system；单条 user 消息保存不含 arguments-json 的调用标识、显式任务正文（如有）、Prompt 文本和可选 promptSource v1，提交后才启动模型/发布加载事件。

provenance、应用回显和诊断不重复原始参数；模板和用户正文仍可能包含参数并进入模型、历史及摘要，不承诺秘密自动脱敏或清除终端输入/外部 shell 历史。恢复不重新获取或恢复权限。替代方案 CLI 直接拼接或多次 append 造成双入口及半份历史。

prompts/get 仍受宿主硬限制、Plan 和 deny 规则；显式用户命令只构成本次获取 allow_once 意图，不批准随后工具动作。获取前和提交边界复核 client/generation/epoch/digest；准备期间 epoch 变化即失败，不以新目录替旧任务提交。最后同步检查后立即进入消息提交，append 在途后的新通知不撤回已经开始的提交、不重取模板。

### D8. CLI 和会话工厂

固定 /mcp、/prompts、/prompt 命令查询 controller/Registry，无动态 Slash 大量注册；列表忙碌可用且不连网，变更动作走门禁。enable/disable 仅当前 Session，reconnect 不重载配置；--no-mcp 不可绕过。启动审批由输入所有者在启动或显式管理阶段处理，后台刷新不抢输入；非 TTY 无审批通道则拒绝。新建/恢复用独立插件，required 失败保持旧 Session，旧清理沿用 retired 所有权。替代方案全局连接单例会串项目、凭据与权限。

### D9. 第三个包的工程交付与依赖

补齐 tsconfig paths/include、声明构建、覆盖完整三包依赖拓扑的 Windows native junction 自愈（CLI→MCP、MCP→Core、CLI→Core、根依赖）、MCP 架构门禁。release/flow/Actions 使用统一清单覆盖五处版本真源（根 `package.json`、Core/MCP/CLI 的 `package.json` 及 `CLI_VERSION`），按 Core→MCP→CLI 顺序发布；pack、依赖精确版本、checksums 与安装 smoke 覆盖三包。规划阶段版本不变，外部 Trusted Publisher 配置单独验收。

阶段 A 先验证两传输及底层防重放（以受控 Server 计数断言六类故障下已发送 `tools/call` 至多一次，无法证明则停止依赖实现），再补 Core 并完成 Stdio/结果闭环。此后 HTTP 与基于 Stdio 的 Prompt 可独立推进；CLI/最终集成等待两支完成，并补齐 HTTP Prompt 和三 Provider 矩阵。不因任务编号把 Prompt 串行依赖于 HTTP，也不把 HTTP 从最终验收遗漏。

### D10. 统一插件扩展契约与组件聚合 (Plugin Contribution Container)

参考 Claude-Code（插件作为包含 skills/hooks/mcpServers/commands 的打包容器）与 OpenCode（以独立插件包与领域扩展点连接内核）的设计共识，拒绝把 `tools`, `skills`, `mcp`, `command` 机械地混杂在单个大包中。升级 Core 的 `AgentPlugin` 契约，支持声明式 `contributes: PluginContribution`（声明 `commands` 纯元数据和 `skillsRoots` 技能目录），保持 Core 0 运行时依赖与 Headless 约束；CLI 新增只读诊断命令 `/plugins [name]`（别名 `/plugin`）统一观测当前会话已挂载插件、命令贡献面与生态状态。

## Risks / Trade-offs

- SDK/modern API 变化 → 阶段 A 锁定精确版本、服务端发送计数和平台矩阵，失败先修订选型，不删支持范围。
- 通知持续变化 → 有界周期保持 unavailable，不承诺恶意或持续抖动来源仍可用。
- 外部副作用无法由协议回滚 → 分离启动/调用授权、已知/未知事实，不重放、不宣传 OS 隔离。
- 项目配置环境变量外发窃密 → 启动审批高危告警标示敏感变量名，禁止未经授权的跨域凭据外发。
- HTTP 私网穿透与 DNS Rebinding → 连接前拦截 RFC 1918 私网段与 169.254/16 元数据地址，Socket 建立后复核底层 IP。
- Windows 批处理参数逃逸与保留设备名 → 严格参数转义限制，禁止 CON/PRN/AUX/NUL 等保留设备名。
- 审批缓存身份绑定失配 → `SessionApprovalCache.key()` 深度纳入 executionIdentity，断连/重连/目标变化后零命中。
- run 内新工具不能立即使用 → 接受下一 run 生效以维护 native continuation，撤销仍即时生效。
- 未落盘的已知结果可能随崩溃丢失 → 进程内保留并停止，恢复保守闭合，不引入本版之外的分布式事务承诺。
- 大工具集/二进制结果降级 → 显式 omitted/unsupported，不承诺完整原文留存。
- 三包可信发布需要外部设置 → 本地 pack 安装先验证，发布授权和 npm 设置独立处理。

## Migration Plan

缺省无 mcp.json 即保持旧行为；旧 Tool 可选校验/身份/结果契约缺省保持兼容；旧 JSONL 缺 promptSource/execution 可读。实现后做三 Provider 恢复与事务测试；--no-mcp 为新接入回退入口，不删除历史。缓存专项的版本待定状态同步 RELEASES，不标已完成。版本仅在正式发布流程同步，Git 提交/推送需独立授权。

## Open Questions

SDK 精确补丁版本、平台进程包装与校验器是有验收边界的阶段 A 选择；无法实现出队资格复核、限长或不重放时必须停止并修订方案。当前没有待用户决定的阻塞范围问题，不将上述待验证事实写成已支持。
