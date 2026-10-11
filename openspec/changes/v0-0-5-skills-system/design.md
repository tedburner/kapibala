# Design: v0.0.5 技能体系与过程输出折叠

## Context

动机与能力范围见 [proposal](proposal.md)，架构背景与参考证据见 [技术方案](../../../docs/superpowers/specs/2026-10-08-v0-0-5-skills-system-design.md)。本文件固定实施决策；可观察行为见本变更的 specs，后续行为变更必须同步规范、技术方案及任务。

当前 Core 已有 PromptAssembler、ToolRegistry、ToolExecutor、AgentSession、ContextManager、消息级存储和多协议投影。read_file 的 PathSandbox 只允许工作区，不能读取全局技能引用。CLI 只有部分工具行回写与单一输入协调器，没有完整 TUI/历史重绘。现有项目信任由配置加载触发，需补足仅有项目技能的仓库。

## Goals / Non-Goals

**Goals:** 在既有 Harness 内提供渐进披露、用户/模型加载、受控引用、只收紧权限、可恢复上下文事实和可检查终端过程。明确预算/扫描/缓存上限，并使用同一领域规则服务 Headless 宿主。

**Non-Goals:** 完整 YAML、任意厂商执行扩展、fork、远程安装、动态 shell 插值、全局脚本自动执行授权、完整 scrollback 折叠或重写设计基线。零外部运行时依赖不变。

## Decisions

### D1. 领域服务与会话绑定

新增 capabilities/skills/{types,frontmatter,scanner,registry,loader,resources,policy,index}.ts，工具工厂分别创建 load_skill、list_skills、read_skill_resource，绑定 Session 的快照/活动状态/审计。Registry 可公开只读元数据和诊断；公开根导出均同步中文 JSDoc。

SessionConfig 接收可选技能根与来源信任配置；无配置时不隐式扫描宿主 home。CLI 提供默认根；Headless 未提供项目信任即拒绝项目技能。AgentSession 增加 getSkills(query?) 与 runSkill(name, task, options?) 宿主入口；runSkill 与 run 共用互斥锁、run 生命周期、落盘和模型循环，预检失败先释放锁，不追加任务。禁止从模型可编辑参数推导 caller=user。

替代方案：在全局 builtinTools 数组放单例。拒绝原因：工具需要当前 Session 的注册表和状态，单例会串项目/权限。

### D2. 有界 YAML 子集与明确兼容诊断

支持块标量、引号/注释、列表、一层 metadata、BOM/CRLF，正文按独立头部边界切分。文件 128 KiB、头部 16 KiB。name 缺省合法目录回退警告，非法标识拒绝；description 缺失拒绝，超规范长度保留并警告。拒绝重复键、危险/不支持结构；未知普通字段保留，已知执行扩展不支持时不可执行。

allowed-tools 字符串/列表可解析，但归一化到 Kapibala 的只收紧限制，报告 SKILL_PERMISSION_SEMANTICS。when/when_to_use 兼容到统一字段，userInvocable 和 argumentHint 向宿主公开。license/compatibility/metadata 保留，compatibility 随正文返回。

替代方案：只用单行正则或引入完整 YAML 运行时依赖。前者损坏真实块标量，后者违背 Core 约束；本方案明确子集并用真实样例验收。未来增加语法不改变已接受文件的解释。

### D3. 确定性来源、信任与快照

优先级 project-native > project-agents > global-native > global-agents > builtin；候选稳定排序后按优先级/物理身份裁决。无效/未信任高层不遮蔽合法低层，有效禁用高层不回退启用副本。保留胜出与被覆盖路径诊断。

每根默认深度 6、目录 2000、条目 20000，SKILL.md 即边界。默认排除 .git/node_modules/dist，.gitignore 支持子集且诊断不支持模式。项目子链接留在物理项目根，全局子链接留在物理全局根；防环与边界检查独立。

信任按物理项目身份，独立于项目 settings。CLI 扩展 project-trust 以处理技能来源，非交互排除未信任项目技能，Headless 由宿主注入。每 run 刷新并固定快照；运行中内容/真实路径变化返回 SKILL_CHANGED，下一 run 刷新，不热混用。

替代方案：按 readdir 偶然顺序后者覆盖，或自动信任扫描到的文件。拒绝原因：不可重现、缓存抖动和未经用户选择的项目指导。

### D4. 估算目录预算与独立查询

PromptAssembler 在 L2 与 L3 之间注入可信且模型可调用目录，仅在匹配加载工厂可见时启用。UnicodeTokenEstimator 测量完整 XML 片段，默认 min(2000, floor(contextWindow × 0.01)) tokens；窗口沿用现有解析。description 250 code points，XML 转义后计成本；序列化顺序稳定，超限按整条删除并预留遗漏引导。

list_skills(query,cursor,limit) 默认 20、最大 50，完整响应默认最多1000估算tokens且受当前请求剩余空间约束；缩短描述/减少完整条目，游标按实际返回推进，最小响应放不下报预算错误。不读取正文/改变权限；过期 cursor 拒绝。load_skill 能加载可信查询可见但 L2.5 遗漏技能。最小目录放不下仍由工具说明提供查询引导。

替代方案：contextWindow × 0.01 × 4 字符或把全部 skill 名放 enum。前者不能满足中文估算上限，后者把省下的目录成本重新塞进 schema；采用名称校验和结构化错误。

### D5. 共享加载、提交与事件顺序

loader 检查调用控制、当前可信身份、快照摘要、正文大小和剩余输入空间。成功包装 skill_content（身份/摘要/compatibility/baseDir/完整正文/当前有效限制/最多20资源名），不预读资源，正文放不下则失败。

模型沿用正常事务。用户runSkill在同一条user消息内保存原始task/命令块和独立技能正文块，正文块带skillSource；整条提交后开始模型（有Store需一次append成功），避免两次append之间半份注入，不伪造tool_result。skill_loaded在消息及提交审计成功后发布，无Store标识persistence=memory；事件包含身份/来源/摘要/caller/关联ID。

活动状态区分pending与committed：执行器确认最终结果通过tool:after及tool.finished审计且非错误后，按实际工厂工具定义身份安装pending收紧，返回runAll前生效；同名插件/结果文本不能伪造该状态，失败结果不激活。pending不授予资源资格。Session现有pendingAssistant/tool_messages落盘分支完成整个批次后再提交活动记录、记skill.loaded审计并发事件；无Store走同一完整内存事务边界。批次内资源访问返回SKILL_NOT_COMMITTED（immediate，不进never缓存）。审计/append失败停止后续执行，清理活动状态，已提交真实历史不回滚。tool_finish不是活动提交边界。

替代方案：在 CLI 直接拼接字符串或工具 execute 内直接发布成功事件。拒绝原因：两套校验、来源无法追溯和落盘失败后虚假成功。

### D6. 运行级最小权限

未声明白名单不额外限制，显式空列表仅控制工具；多个声明白名单取交集。仅支持原生名和 Read/Write/Glob/Grep/Bash 固定映射；未知工具或参数模式拒绝激活，不宽化 Bash(git:*)。

load_skill/list_skills/read_skill_resource为控制工具，声明source=builtin、permissions=['fs:read']，不参与业务交集，但保留自身与宿主deny，不能写入或执行代码；否则当前Plan会拒绝缺能力工具。执行器在tool:before改写最终参数后通过已有PermissionPolicy.hardDenied注入技能拒绝，并审计技能来源及原因。FullAccess/缓存/审批不能绕过。宿主runSkill复用同一逻辑加载权限，不能绕过skills.enabled=false或宿主读取拒绝。

限制本轮只能累加，终止路径先清理工具/历史再清空。恢复/新 run 重新激活，不根据旧正文授予权限。保留已完成工具真实结果。收紧经加载结果告知模型并由执行器强制，不在运行中为权限投影改写签名continuation的系统前缀/工具schema；开始模型前的宿主显式激活可参与初始工具可见性裁决。仅user-only集合时不注册load_skill/list_skills，但显式激活后可提供read_skill_resource。

替代方案：提示词要求模型自律、白名单取并集、限制永久继承会话。分别存在绕过、权限扩大和后续无关任务受旧规则污染的问题。

### D7. 技能资源入口保持文件/执行沙箱

read_skill_resource(name,path,startLine?,endLine?,offset?) 要求本轮 committed 活动技能，根由注册表解析，检查词法与物理边界、SKILL.md 摘要；绝对/UNC/盘符/.. 越界、目录/二进制、外部链接均拒绝。单次64 KiB且分段/截断标记明确；nextOffset 为 UTF-8 字符边界，可用 offset 续读超长单行，不能与行范围混用；资源变更记录本次事实。普通 read_file 不扩大 rootDir。

脚本只可受控读取，执行仍走命令工具与原规则；项目外执行不支持时明确提示迁移到工作区。正文中的动态 shell 不执行。

替代方案：把 home 或所有技能目录加入普通文件/命令白名单。拒绝原因：扩大无关读写/执行范围，读取授权也不能代表执行授权。

### D8. 上下文有效性与压缩

SkillActivation 关联实际消息 ID、来源摘要与 run。ContextManager 依据实际请求判断正文 present/requires_reload。当前 run 活动正文的完整事务/注入单元受保护；预算仍不够按既有超限路径结束，不破坏签名 continuation 或历史闭合。

旧完整轮次摘要后输出结构化重载标记，不宣称摘要含完整规则；成功压缩失效去重，失败保留旧投影。只有同来源/digest 完整正文仍在投影且本轮合法激活时可 already_present；新 run 重新核验与激活，正文缺失完整重载。恢复只恢复事实不恢复授权、不重放。

替代方案：永久 pinned 所有技能或仅按曾调用集合去重。前者上下文持续增长，后者正文丢失后永远不补；保护范围限当前 run，旧轮次允许摘要加重载。

### D9. CLI 有界折叠与非交互完整模式

CLI 复用真实事件名 thinking_delta/text_delta/tool_start/tool_finish 等及新 skill_loaded。当前 run 过程缓存默认1 MiB UTF-8，按 block/tool ID 关联，超限标记；回答全文流式，错误/审批始终显式。缓存不截断 Core 历史/模型请求。

Ctrl+O 交给 CliInputCoordinator，独占问答期间禁用，终止幂等解绑。可靠锚点下只重绘有界过程区；resize/外部输出/审批使锚点失效时追加详情快照，不擦写答案或历史。收起只影响当前区和后续输出，不承诺删除已滚入 scrollback 的全文。

新增 --output-detail summary|detailed，默认 summary；one-shot/REPL 共用。非TTY无ANSI/动态回写，detailed输出所有公开过程（不受1MiB缓存限制），保留脱敏/控制字符过滤，debug仍独立stderr。

替代方案：直接追加键盘监听并回写整个终端，或用 debug 代替用户详情。前者破坏审批/秘密输入/已有输出，后者混淆开发诊断与完整过程。完整历史TUI留给v0.0.8。

### D10. 持久化、失败、配置与CLI入口的具体兼容

**来源存储：** 在既有TextBlock/ToolResultBlock添加可选skillSource v1，不新增ContentBlock类型、角色、SessionRecordType或SESSION_SCHEMA_VERSION。字段包含name/scope/filePath/baseDir/contentDigest/renderedDigest/caller/runId/invocationId；前者SHA-256原文件字节，后者SHA-256完整包装文本UTF-8。来源仅由加载器注入，无权限效力。两种内置Store都保存content，因此不用旧JSONL会丢失的任意消息级字段。normalizeHistory保留块与来源索引，Provider只发送原text/content，来源不进入wire角色。摘要改写失效来源并加重载标记，缺失/未知版本/自定义Store丢来源均保留正文但禁用有效性去重。

**错误与提交：** SKILL_NOT_COMMITTED和SKILL_CURSOR_EXPIRED为immediate，允许下一步修正，不自动重试、不进入never缓存；SKILL_CHANGED/UNTRUSTED/BODY_BUDGET_EXCEEDED为after_user_action，需新运行；NOT_FOUND/INVOCATION_FORBIDDEN/UNSUPPORTED/POLICY_DENIED/INVALID_INPUT/RESOURCE_DENIED为never。审计/存储失败沿用已有类别，已落盘事实不撤销。skill.loaded在提交之后审计，失败不发布成功事件或继续调用。消息不存在的失败预检不注入正文。

**配置：** 首期仅skills.enabled（缺省true）/skills.disabled（缺省空）；全局与已信任项目enabled取逻辑与、disabled取并集，项目不能重新启用全局禁用技能。关闭不删除历史。Headless明确提供roots/enabled/disabled/trust，不读取宿主home。各项数值限额共用Core常量集，CLI不重算。全局写入仍走loadGlobalSettingsForWrite。

**命令：** COMMAND_CATALOG注册/skills只读、/skill变更且rawTail。首个token为技能名，剩余task保留空格/引号/换行，作为原始用户文本，不执行$ARGUMENTS替换。ActiveSessionController.runSkill复用execute；CommandContext通过宿主运行回调消费事件，REPL使用任务renderer和现有取消/退出等待，不绕过控制器或借statusRenderer跑任务。--disable-shell只关命令工具，本方案不新增--disable-tools。

替代方案：消息顶层任意字段、增加全新记录类型、把命令层直连Session、默认缺省能力。分别丢失旧Store往返、扩大迁移范围、破坏控制器取消和产生Plan误拒；本方案使用已有存储/权限/输入协议的增量扩展。

## Risks / Trade-offs

- YAML/厂商兼容有限 → 清楚列子集，用真实样例与诊断；不静默忽略执行语义。
- 白名单交集可能使组合技能无法执行 → 显示冲突和迁移原因，拒绝期间仍可检查/加载控制信息；不自动扩大权限。
- 动态文件或链接变更 → 加载/资源访问重核真实路径与摘要；沿用现有精确执行目标检查，不声称跨读取的文件系统快照原子性。
- 目录预算影响触发召回 → 查询遗漏入口和稳定排序，记录遗漏数量。
- 当前运行正文占用预算 → 完整保护并明确超限，不用摘要假装指导仍有效。
- 大输出/终端锚点失效 → 缓存有界、详情快照降级、非TTY完整模式、真实Windows/POSIX进程验收。
- 自动遵循依赖模型质量 → 真实模型记录触发/遵循结果与限制，不把结构单测当行为保证。

## Migration Plan

1. 按 [tasks](tasks.md) 实施，零依赖与中文导出注释随阶段验证；无技能目录时原问答路径保持可用。
2. 现有设置新增技能来源/禁用配置时使用既有原始全局写入入口，不把内置模型物化进用户配置；信任按既有 trustedProjects 身份格式复用。
3. 不重写既有会话原历史，不增加会话schema或记录类型。新增来源只在既有content块中，缺失或未知版本视为未知，不把旧文本解析成授权；旧读取器忽略可选字段仍读取原正文，两种Store往返及旧读取器兼容必须验收。
4. 行为验收通过后同步用户用法、迁移边界及验证记录；发布仍由既有流程独立处理。
5. 回退关闭技能来源/工具和新增命令即可；历史正文作为既有文本继续读取，不重放工具。默认摘要可用 detailed 切回完整公开过程。

## Specification Mapping

| 决策 | 可验收规范 |
|---|---|
| D1/D2 | skill-domain-contract、load-skill-builtin-tool |
| D3 | skill-scanner-discovery、skill-registry-management |
| D4 | skill-prompt-assembly |
| D5 | load-skill-builtin-tool |
| D6 | skill-execution-policy |
| D7 | skill-resource-access |
| D8 | skill-context-lifecycle |
| D9 | cli-skills-commands、cli-output-folding |
| D10 | skill-domain-contract、skill-registry-management、load-skill-builtin-tool、skill-execution-policy、skill-context-lifecycle、cli-skills-commands |
