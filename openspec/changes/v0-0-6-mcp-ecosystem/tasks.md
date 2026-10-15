# Tasks: v0.0.6 受控 MCP 生态接入

状态：仅规划落盘，所有checkbox为尚未执行的实施/验证任务。详见 [开发计划](../../../docs/superpowers/specs/2026-10-12-v0-0-6-development-plan.md) 和 [技术设计](../../../docs/superpowers/specs/2026-10-12-v0-0-6-mcp-ecosystem-design.md)。按组依赖顺序推进；每项含完成证据，功能与本组测试/注释同步交付。缓存友好的上下文压缩专项及其实测不入本版，不将既有压缩或MCP目录稳定性标为该专项已实现；第7、8组可并行，第9组汇合两者，第10组保留端到端集成门禁。

## 1. SDK 与平台可行性（里程碑 A）

- [x] 1.1 在受控验证目录评估并锁定官方v2 Client精确版本，验证Node20/当前CI版本ESM、类型与两协议时代；产出可重复命令及版本证据。
- [x] 1.2 验证Stdio legacy/modern协商、探测进程启动次数和启动取消；用真实受控Server断言命令、args和进程计数。
- [x] 1.3 验证Streamable HTTP legacy/modern、固定Header、取消/超时及4MiB有界解码可实现性；用loopback服务断言行为而非只读SDK文档。
- [x] 1.4 验证Windows .cmd/空格/Unicode参数包装、CVE-2024-24576防批处理特殊字符注入及node包装子进程树清理；记录真实PID与退出证据，失败先修订设计。
- [x] 1.5 验证POSIX直接进程/包装进程的取消与升级回收；记录真实PID、超时与退出证据，目标平台缺失明确标未验证。
- [x] 1.6 写入docs/verification/v0.0.6-sdk-compatibility.md并复核技术设计默认值与验证结果；不满足两传输/两时代或1.7防重放证据时不得进入依赖实现。
- [x] 1.7 【阻断门禁】用受控Server请求计数验证应用/SDK/transport对已发送tools/call均无隐式重放，按协议时代区分覆盖：legacy 模式下的 session-expired/404 session missing，以及 modern 模式（2026-07-28）下的 401 鉴权挑战/400 ProtocolMismatch 等逐请求失效，并覆盖断流、超时与取消及连接重建；断言至多发送一次，区分响应流续接和重复业务请求，幂等目录查询只在原截止内有限重试；任一层无法证明无隐式重发则立即停止后续依赖实现并修订选型。

## 2. 通用 Core 契约（依赖 1）

- [x] 2.1 实现原子来源替换（含候选批内自身重名预检与跨来源冲突检测）及不可变来源版本视图，补中文JSDoc；注册表测试证明候选批内重名整批拒绝、后项跨源冲突零部分提交、跨来源不误删、旧快照不变。
- [x] 2.2 绑定run不可变工具快照视图（AgentLoop在run启动时捕获快照并贯穿多turn推进）与对应执行实例，保留原生续答/Skill契约；Loop集成测试证明新增下一run可见、多turn循环不发生声明漂移、撤销不转调同名新工具、钩子捏造名称被拒。
- [x] 2.3 新增可选执行身份并纳入审批缓存/发送前复核，补注释；SessionApprovalCache.key深度哈希executionIdentity，测试证明目标/连接/当前epoch变化后旧allow_session失效、审批中epoch变化本次零发送，当前完整复核可恢复同generation同digest旧引用并允许新审批，不要求快照原始epoch永久相等，旧工具缓存语义不变。
- [x] 2.4 新增通用external:call（Core CAPABILITIES集合与类型同步扩充该项）及能力规则校验，补公开说明；权限矩阵覆盖Plan、Auto、Approval、FullAccess、deny、Skill硬限制和无审批通道。
- [x] 2.5 新增显式opt-in结果转换并与2.8的发送事实记录分离，补注释与兼容例；Executor测试覆盖业务isError、宿主转换失败和普通对象isError字段不被误判。
- [x] 2.6 新增受控任务准备入口及Controller生命周期接点，补接口说明；测试证明prepare期间busy/可取消、失败零append、结果预算与单条提交顺序，最终提交前复核准备身份以拒绝通知/取消竞态。
- [x] 2.7 新增通用可选Tool.validateInput无副作用接口，补中文JSDoc；最后可改参hook之后、权限审批之前执行，不改参不访问远端；测试证明拒绝/异常零审批零发送，校验、权限、审批缓存、身份和发送共享同一最终参数快照，旧Tool缺省兼容。
- [x] 2.8 新增可选execution v1元数据{version:1,dispatchOutcome:not_sent|succeeded|failed|unknown,hostError?:{phase:validation|projection|hook|audit,code:string}}，适配器先记录发送事实、Executor附加宿主错误；同步序列化/validators/历史/审计/Provider投影及中文JSDoc，测试旧结果无字段可读、有效响应后本地错误不改unknown且不将元数据透传模型。

## 3. 独立包、配置与启动授权（依赖 2）

- [x] 3.1 建立packages/mcp包与根导出/声明构建，补tsconfig paths/include及测试收集；命令证明新包类型错误与测试失败能被门禁发现。
- [x] 3.2 实现mcp.json判别配置、Server命名约束（`^[a-zA-Z0-9_-]+$`且禁止`/`与`__`）、整项覆盖/禁用/来源诊断，补配置JSDoc；纯函数测试覆盖无配置、非法名称歧义、非法required、未信任覆盖和禁用不回退。
- [x] 3.3 实现native物理路径、cwd声明根、command实际目标解析与Windows保留设备名拒绝；路径测试覆盖短/长名、相对根、授权前后目标漂移及CON/PRN/AUX/NUL等设备名拒绝。
- [x] 3.4 实现env引用/基础白名单、缺变量拒绝、敏感值隔离与项目配置敏感凭据告警；进程/配置测试断言无关密钥不继承、命令插值不执行、项目配置引用敏感凭据触发Credential Alert并列出变量名、日志不含凭据。
- [x] 3.5 实现独立启动授权回调、会话缓存、审计和身份复核；宿主测试覆盖信任不放行、FullAccess硬限制、非TTY拒绝、审批串行和批准后期限计时。
- [x] 3.6 建立docs/mcp.md配置/SDK/启动授权章节及最小示例；配置测试读取示例验证合法性，文档区分计划与已实现范围。

## 4. Stdio 与连接所有权（依赖 3）

- [x] 4.1 实现一Session一插件/controller及失败setup资源回滚，补生命周期JSDoc；测试证明不能重复挂载/跨Session复用、失败资源有所有者。
- [x] 4.2 实现Stdio已授权目标启动、协议能力协商和Prompt-only处理；真实进程测试证明默认legacy、显式modern及无tools能力不误请求。
- [x] 4.3 实现并发/整体截止及独立连接/Tools/Prompts状态，补状态说明；时钟/Client测试覆盖required声明Tools则Tools ready、Prompt-only则Prompts ready、混合Prompt失败不撤销Tools、用户Prompt必须其目录ready，可选失败可继续且无遗留启动任务。
- [x] 4.4 实现generation/client及各能力独立epoch/refreshToken防护、订阅清理和手动重连；竞态测试证明旧close与目录成功/失败均不能污染新状态，一类能力刷新不撤销另一类，重连不重载配置。
- [x] 4.5 实现有界stderr诊断、幂等teardown及进程树升级清理；真实进程测试证明回收包装/子进程且重复销毁安全，失败不冒充完成。
- [x] 4.6 同步docs/mcp.md Stdio支持/超时/重连/清理限制；用文档中的受控Server启动关闭例验证退出行为。

## 5. 目录与工具权限（依赖 4）

- [x] 5.1 实现稳定工具命名及原始身份映射，补JSDoc；测试覆盖非法字符、64字符上限、碰撞和倒序发现映射不变。
- [x] 5.2 实现完整分页、重复cursor/硬上限、Schema校验与精确过滤；目录测试证明不完整候选不发布、无远端ref获取、无静默删约束。
- [x] 5.3 实现Tools独立epoch/refreshToken、通知暂停/原子发布和同generation同digest旧引用复核恢复；竞态测试覆盖过期成功/失败零污染、审批中epoch变化即使摘要未变本次零发送且新审批可执行、变更撤销、新增下一run；持续通知每刷新周期最多三轮共享catalogTimeout，耗尽保持stale/unavailable，后续新通知或显式重连才开启新周期。
- [x] 5.4 实现模型MCP声明数量/字节及实际请求预算筛选；中文/大Schema测试证明整项省略、稳定次序和遗漏项零发送。
- [x] 5.5 适配工具进入统一Executor并通过2.7校验最终参数；发送计数测试覆盖hook改参、校验拒绝/异常零审批零发送、readOnlyHint、Plan/Skill和未知工具；在所有异步审批与异步审计完成后、底层transport真实出队点同一同步微任务中复核当前身份/epoch与最终快照（无await让步），复核至底层发送之间不发生事件循环让步，已观察撤销严格零发送、不替换同名新实例。
- [x] 5.6 同步docs/mcp.md目录/预算/过滤/权限说明；补runSkill引用未连接MCP工具的兼容测试，提示连接后重新激活。

## 6. 结果、取消与工具事务（依赖 5）

- [x] 6.1 实现text/structuredContent/isError和execution v1错误分类适配，补JSDoc；测试断言有效业务失败为failed但不承诺无副作用，已知成功转换失败保持succeeded并附projection错误、after_user_action暂停不重放；有效响应之后hook/审计错误不得改unknown。
- [x] 6.2 实现20KiB保留预算、传输4MiB硬界、JSON安全省略及二进制/_meta处理；测试证明超大输入有界、无Base64/凭据、无链接下载。
- [x] 6.3 实现适配器管理调用期限/取消并等待有界本地收口；取消测试证明不被通用Promise.race提前释放且已完成结果保留。
- [x] 6.4 实现发送阶段与OUTCOME_UNKNOWN/after_user_action及原截止内最多两次额外目录重试；用应用/SDK/transport请求计数按协议时代覆盖 legacy（session-expired/404）与 modern（401/400）以及断流、超时、取消和恢复，断言已发送tools/call始终不自动重放。
- [x] 6.5 集成启动/调用审计和消息级闭合；故障测试覆盖审计不可用零发送、有效响应后审计失败保留发送事实、append失败进程内保留真实结果并停止推进、消费者return、多调用取消和清理期busy；重启缺失落盘结果仍恢复unknown且不重放，不保证未落盘事实跨重启可知。
- [x] 6.6 同步docs/mcp.md结果保留/execution元数据/未知/取消与落盘失败边界；与既有历史恢复测试联跑，证明旧结果缺字段兼容、MCP来源不按内置只读剪裁且来源不恢复权限。

## 7. Streamable HTTP（依赖 6）

- [x] 7.1 实现HTTP传输并复用同一目录/执行/结果/清理管线，补JSDoc；loopback集成覆盖legacy/auto/modern及拒绝旧SSE。
- [x] 7.2 实现HTTPS/显式回环HTTP（127.0.0.0/8、::1/128、localhost）、URL用户密码拒绝、固定Header/env凭据、全量私网与保留网段拦截（RFC 1918、169.254/16、CGNAT 100.64/10、0.0.0.0/8、组播/保留；IPv6 ULA fc00::/7、fe80::/10、组播、::/128及IPv4-mapped）与白名单底层Socket Remote IP二次复核防御DNS Rebinding；测试证明缺变量零请求、私网目标被拦截、白名单解析至内网被拦截、Server间不串用密钥。
- [x] 7.3 实现重定向目标/鉴权隔离；跨origin测试断言新目标收到零鉴权请求，不能自动降级HTTP或改URL。
- [x] 7.4 集成HTTP断流/协议异常/超时和必要关闭收口；loopback服务端计数按时代覆盖 legacy（session-expired/404）与 modern（401/400）以及鉴权挑战和SDK/transport恢复，证明已发送tools/call至多一次、可靠响应不被本地错误改unknown，幂等目录查询才可有限重试。
- [x] 7.5 同步docs/mcp.md HTTP示例和支持矩阵；用本地HTTP示例验证命令/配置并明确OAuth与SSE延期。

## 8. Prompt 与历史来源（依赖 6 和 2.6，可与 7 并行）

- [x] 8.1 实现PromptRegistry有界发现/查询/来源/可用性及独立epoch/refreshToken，补JSDoc；测试搜索不取正文、目录故障不是空集成功、同名区分、旧成功/失败不污染、通知暂停提交且不影响Tools；持续通知每周期最多三轮共享catalogTimeout，耗尽不无限续刷。
- [x] 8.2 实现JSON字符串参数、必填/未知校验及受控获取权限；测试Plan/deny优先于用户意图、用户执行必须Prompts ready，参数错/目录变化零提交，恢复同摘要目录后仅新准备可执行。
- [x] 8.3 接入runPreparedTask完整文本准备与角色标签降级；测试获取取消、必需二进制拒绝、预算不足，以及获取后/预算等待中目录变化零append；最终提交检查同步进入append不跨await，append在途后的通知不撤回、不重取；无arguments-json调用标识+显式任务正文+模板单条user提交。
- [x] 8.4 新增promptSource v1并更新序列化/validators/history/summary/Provider投影，补来源JSDoc；旧JSONL/无Store/跨协议恢复测试证明无来源授权或重新获取，metadata/诊断/审计不重复原始参数，任务正文/模板带参数仍可进入模型历史摘要。
- [x] 8.5 实现提交后的mcp_prompt_loaded事件与安全审计；故障测试证明append失败零加载事件/模型请求，memory提交标识正确，提交前已观察通知与提交在途通知的边界一致。
- [x] 8.6 同步docs/mcp.md SDK任务准备/Prompt用法及隐私边界，不承诺正文自动脱敏或清除终端输入/外部shell历史；三Provider模拟消费带角色标签模板，断言只存在真实模型assistant响应。

## 9. CLI 与活动会话（依赖 7 和 8）

- [x] 9.1 接入CLI独立MCP配置/项目信任/启动授权和--no-mcp；CLI测试覆盖无配置无等待、未信任排除、宿主关闭不可enable绕过。
- [x] 9.2 注册/mcp及tools/reconnect/enable/disable与安全诊断；命令测试覆盖未知Server、busy只读、变更拒绝和当前Session开关不写文件。
- [x] 9.3 注册/prompts与/prompt JSON raw-tail解析、来源ID补全；测试覆盖带空格JSON、必填校验、内置Slash无冲突及统一任务取消。
- [x] 9.4 集成ActiveSessionController的新建/恢复工厂和retired清理；切换测试证明required失败保留旧Session、配置/审批隔离和旧资源重试有所有者。
- [x] 9.5 接入输入协调器和summary/detailed MCP展示；TTY/非TTY测试覆盖审批串行、namespace可见、无ANSI/凭据且只展开保留内容。
- [x] 9.6 同步/help、docs/mcp.md、README接入入口和实际状态；命令目录/帮助测试证明不宣称Resources/OAuth/完整TUI已交付。
- [x] 9.7 接入统一插件扩展契约（PluginContribution / PluginCommandContribution）与 /plugins [name]（别名 /plugin）只读诊断命令；测试覆盖全量插件列表、特定插件详情（展示贡献命令、技能目录与 MCP 统计）及未知插件提示。

## 10. 工程交付与整体门禁（依赖 9）

- [x] 10.1 扩展MCP公共包/Headless架构门禁并补边界夹具；测试拒绝CLI/终端/Core内部导入，产物检查证明Core运行时依赖为零。
- [x] 10.2 扩展scripts/dev.mjs的完整三包依赖拓扑自愈（基于repairWorkspaceLinks动态收集或显式校验CLI→MCP、MCP→Core、CLI→Core、根依赖），保持verify-only同源和.cmd纯ASCII；Windows软链退化为空目录场景自愈为native junction及pnpm dev:build验证通过。
- [x] 10.3 将release/flow统一清单精确覆盖五处版本真源路径（根 package.json、packages/core/package.json、packages/mcp/package.json、packages/cli/package.json 与 packages/cli/src/version.ts 的 CLI_VERSION）并同步Actions pack/顺序（Core→MCP→CLI）/检查；release测试覆盖遗漏、错版本/依赖及幂等发布计划，禁止实际发布。
- [x] 10.4 做Node20/当前CI版的独立tarball安装和三包烟测，检查checksums/文件清单/依赖；外部Trusted Publisher配置列为发布前置未验项。
- [x] 10.5 完成三Provider多步工具/原生前缀、Windows/POSIX真实进程及HTTP整体回归，执行pnpm verify与pnpm dev:build；记录命令/结果和未验证环境。
- [x] 10.6 形成migration/verification/releases v0.0.6文档并同步路线图状态；逐项映射验收证据，明确真实模型/外部Server限制且规划阶段不改版本号。

## Workflow follow-up

- 完成功能后由用户审阅；Git暂存/提交展示完整公司格式消息和文件清单，确认后才操作，推送独立授权。
- 新npm包Trusted Publisher配置、合并/发布与main/tag推送均按独立授权及既有发布门禁执行；本地验收不等于远端发布完成。
- 全部实施与必要验收完成后再按用户要求同步/归档本OpenSpec变更，当前不归档、不修改主规范。
