# Kapibala v0.0.5 技能体系 (Skills) 与过程输出折叠设计方案

状态：工作区实现与本地验收已于 2026-10-11 完成，尚未发布。本文记录架构与兼容边界；可验收行为和实施进度分别维护在 [OpenSpec specs](../../../openspec/changes/v0-0-5-skills-system/specs/) 与 [tasks](../../../openspec/changes/v0-0-5-skills-system/tasks.md)。实际用法见 [技能指南](../../skills.md)，证据及限制见 [验收记录](../../verification/v0.0.5.md)。

## 一、背景与设计目标

### 1.1 阶段定位

v0.0.4 已提供多协议接入、场景路由和结构化思考事件。按 [路线图](../../RELEASES.md) 与 [设计基线](../../design/001-agent-framework-design.md)，v0.0.5 建立可复用、可发现、按需加载的技能体系：

1. 摘要常驻 L2.5，正文与配套资源按需读取。
2. 项目知识覆盖个人偏好；目录冲突、不可用技能与预算遗漏可诊断。
3. 技能限制只收紧既有权限，不通过 Markdown、厂商扩展或历史记录新增授权。
4. 模型调用与用户显式调用共享加载逻辑，保留调用来源与完整历史。
5. 正文在上下文中的有效性、活动权限与去重状态同步管理。
6. CLI 默认摘要展示过程，支持当前轮次详情切换及非交互完整详情输出。

### 1.2 不变量与范围

- Core 保持 Headless、运行时零外部依赖；宿主负责目录配置、信任交互与终端展示，Core 负责校验与执行期强制检查。
- 模型工具经过现有 ToolExecutor / AgentLoop；所有退出路径先闭合工具事务并清理，有 Store 时完成消息级 append，无 Store 时提交完整内存历史。
- 使用现有 UnicodeTokenEstimator，1% 是估算预算，不宣称等同于厂商 tokenizer 的精确比例。
- 支持 Agent Skills 常用 YAML 子集；不承诺完整 YAML 或任意 Claude Code 插件直接运行。
- 首期 inline 加载；不执行动态 shell 插值，不实现 fork、安装市场、远程技能、MCP 依赖安装或任意历史滚动区重绘。子 Agent 和完整 TUI 仍按既有路线交付。
- 不修改设计基线章节、编号及交叉引用。

## 二、参考实现与取舍

依据本机 F:/Project/aigc 检出内容，不作为这些项目最新版本的声明。Claude-Code 是非官方 source map 还原仓库。

| 参考 | 可借鉴机制 | v0.0.5 取舍 |
|---|---|---|
| [pi skills](../../../../../aigc/pi/packages/coding-agent/src/core/skills.ts) | 元数据/正文分离、XML 转义、冲突诊断 | 渐进披露；覆盖优先级按 Kapibala 基线规定 |
| [opencode skill tool](../../../../../aigc/opencode/packages/core/src/tool/skill.ts) | 加载权限检查、结构化正文与限量资源清单 | 正文/资源共享信任与可用性检查 |
| [codex discovery](../../../../../aigc/codex/codex-rs/ext/skills/src/loader/discovery.rs) | 深度、目录数、条目数与链接策略 | 有界扫描；防环与授权边界分别检查 |
| [deepseek-harness skill](../../../../../aigc/deepseek-harness/packages/skill/skill/src/index.ts) | 模型/用户调用分离、共享包装 | 公开宿主查询与显式调用契约 |
| [hermes-agent context](../../../../../aigc/hermes-agent/agent/context_compressor.py) | 正文丢失提示、重载与去重失效 | 去重依据当前投影，不依据曾经加载 |
| [Claude-Code prompt](../../../../../aigc/Claude-Code/src/tools/SkillTool/prompt.ts) | 目录预算与描述长度 | 保留 250 字符上限，改用 Unicode 估算与遗漏查询 |
| [skills 样例](../../../../../aigc/skills/skills/claude-api/SKILL.md) | 多行 description、配套 references | 真实样例验证块标量 |

参考：[Agent Skills specification](https://agentskills.io/specification)、[客户端集成指南](https://agentskills.io/client-implementation/adding-skills-support)。标准 experimental allowed-tools 表达预批准工具；Kapibala 归一化为“只收紧”的限制并输出兼容诊断，不据此自动批准。

## 三、Core 技能领域设计

### 3.1 模块与集成点

新增 capabilities/skills/ 的 types、frontmatter、scanner、registry、loader、resources、policy；新增 load_skill、list_skills、read_skill_resource 工具工厂，从 Core 根导出，公开契约同步中文 JSDoc。工厂绑定会话注册表、活动状态和审计，不能把状态藏在全局 builtinTools 单例中。

改造 context/session/index.ts 的初始化、run、预算、清理与恢复，context/manager.ts 的投影有效性判断，runtime/executor/index.ts 的最终裁决，以及 PromptAssembler 的 L2.5。CLI 在 index / tool-registration 接入；session-startup 保留历史会话选择职责。

### 3.2 领域契约

| 类型 | 必要字段与约束 |
|---|---|
| SkillScope | builtin / global / project，仅描述来源，不直接授权 |
| SkillFrontmatter | name、description、license、compatibility、metadata、allowed-tools；disable-model-invocation、user-invocable、argument-hint、when / when_to_use 为扩展 |
| SkillMetadata | name、完整 description、when、scope、sourceRoot、filePath、baseDir、modelInvocable、userInvocable、argumentHint、可用状态、限制摘要 |
| SkillDefinition | 元数据 + body + contentDigest；正文包装保留 compatibility 与资源基准 |
| SkillDiagnostic | code、level、path、message、winnerPath / loserPath；宿主展示前过滤终端控制字符 |
| SkillInvocation | name、caller（宿主提供 user / model）、用户任务参数 |
| SkillActivation | runId、name、scope、filePath、contentDigest、关联消息/调用 ID、投影状态及限制 |
| SkillCatalogResult | 生效元数据、诊断、遗漏数量、稳定分页游标 |

caller、trusted、baseDir 不进入模型可编辑 schema。用户入口只由宿主确认真实命令后调用，不从模型输出或技能正文推导“显式用户授权”。

### 3.3 Frontmatter 兼容与失败规则

使用有界逐行解析器，不用单个正则承担全部 YAML。支持 UTF-8 BOM、LF/CRLF、独立行开闭 ---；普通/单双引号字符串、支持子集内的转义、引号外行尾注释、布尔值；|、|-、|+、>、>-、>+ 块标量及其折叠/尾部换行；行内字符串数组、缩进字符串列表；metadata 一层字符串映射。allowed-tools 支持标准空格分隔字符串并兼容列表。

name 为 1–64 个小写 ASCII kebab-case 字符；缺省回退目录名并警告，目录名不匹配警告，非法标识拒绝。description 缺失、非字符串或空白拒绝；超过 1024 code points 保留原值并警告，目录投影另行缩短。compatibility 超过 500 code points 警告。

重复键、未闭合头部、畸形结构、非法布尔、YAML tag/anchor/alias/merge 拒绝，错误局限于当前技能。未知普通元数据保留并诊断，不合并进对象原型。已知的未支持执行扩展 context: fork、hooks、model、agent、shell、动态插值将技能标为不可执行，给出迁移诊断，不静默降级 inline。

默认 SKILL.md 上限 128 KiB、frontmatter 上限 16 KiB，受限读取后再解析。正文还受当前请求输入预算约束；不能容纳完整正文时拒绝，不把截断指令标为加载成功。

### 3.4 发现、信任与扫描边界

同名胜出顺序从高到低：project .kapibala/skills → project .agents/skills → global ~/.kapibala/skills → global ~/.agents/skills → builtin。项目根使用现有解析规则，内置可以为空。

根规范化后，候选按路径 code point 顺序稳定排序；先按优先级裁决再做物理文件去重，防止低层链接抢占。无效/未信任候选不覆盖有效低层技能；有效但显式禁用的高层候选保持禁用，不回退启用低层副本。

每根默认最大深度 6（根为 0）、目录 2,000、条目 20,000；含 SKILL.md 的目录立即作为技能边界，根自身也检查。超限/权限错误/破损链接诊断；环和重复真实路径跳过。项目子链接必须在物理项目根内，全局子链接在配置的物理全局根内；根自身可以是宿主显式配置的链接。防环不等于允许越界。

默认排除 .git、node_modules、dist。按声明目录继承 .gitignore，首期支持普通路径、前导 /、尾 /、*、**、?、!、注释/转义前导标记；后规则覆盖前规则，排除父目录后不继续递归，兄弟规则不串用。字符类等不支持语法诊断并忽略该条，不宣称完整 Git ignore 兼容。

项目信任不依赖 settings 文件存在。CLI 复用 trustedProjects 的物理身份，在项目技能进入提示词/加载前确认。非交互未信任项目排除项目技能并报告原因，全局/内置仍可用。Headless 宿主通过 SessionConfig 提供信任裁决，缺省项目技能不可执行。信任不自动批准写入或执行。

### 3.5 注册表、快照与查询

Registry 提供 list/search/get/diagnostics 与不可变快照；宿主可查看 unavailable、disabled、shadowed、not-advertised；模型只可查询可信、模型可调用且未被宿主禁用的技能。

每个 run 开始刷新快照，run 内固定胜出来源与摘要，不流式热替换。加载重新核对真实路径/contentDigest；变化返回 SKILL_CHANGED，下一 run 刷新。Session 活动状态相互隔离；切换等待清理，恢复重新发现，不沿用历史路径或旧信任。

### 3.6 L2.5 预算与遗漏发现

只有绑定当前注册表的 load_skill 工具可见时才生成 L2.5；空目录或仅 user-only 技能时省略模型目录、load_skill 和 list_skills；用户显式激活后仍可绑定 read_skill_resource。位于 L2 与 L3 之间。

默认预算为 min(2000, floor(contextWindow * 0.01)) 估算 tokens；未知窗口沿用现有解析规则并标注估算。UnicodeTokenEstimator 计入完整序列化片段，包括标题、引导、XML、转义和遗漏提示；还需满足实际请求剩余输入空间。

description 最多 250 code points，有空间可带 when；元数据统一 XML 转义，不切割 surrogate pair。按 scope/来源优先级及名称稳定排序；超限移除完整条目，为遗漏数量和 list_skills 引导预留预算，不输出破碎 XML。最小目录也放不下则省略 L2.5，工具说明仍指向查询入口。

list_skills(query, cursor, limit) 默认 20、最大 50，完整响应默认最多 1,000 估算 tokens，并受当前请求剩余空间限制；缩短展示描述或减少本页完整条目，游标仍按实际返回条目推进。最小响应放不下则明确报预算错误，不返回不前进的分页。仅返回可信模型可调用元数据，不读取正文/激活权限；快照变化使 cursor 失效。load_skill 可加载被 L2.5 预算遗漏但查询可见的技能，不把展示子集当成唯一可用集合。

### 3.7 共享加载、历史与事件

loader 统一检查来源、调用方、可用性、摘要和预算。load_skill 只接受 { name }；宿主用户入口接受 name 与原始 task。失败抛结构化 KapibalaError，由执行器转 isError，不返回伪成功字符串。

成功包装 skill_content：name、scope、contentDigest、compatibility、baseDir、完整正文、当前有效工具限制、最多 20 个资源相对路径与遗漏标记；不预读资源。技能不能覆盖更高层宿主规则。运行内收紧由执行器强制保证，并在加载结果告知模型；不为了收紧重排既有签名续答的系统前缀或工具 schema。

模型路径沿用 tool_use/tool_result 闭合及消息提交。用户路径在同一条本轮 user 消息中保存原始命令/任务文本块与独立技能正文文本块，正文块附宿主来源；该消息提交后才启动模型（有 Store 时需一次 append 成功），不伪造无 assistant 调用的 tool_result，仍经 canonical 规范化与所有 Provider 投影。

skill.loaded 审计记录身份/摘要/caller/runId/消息关联，不存正文。新增 Headless skill_loaded 事件，有 Store 时仅在关联消息 append 成功后发布；无 Store 时以完整事务进入本轮内存历史为提交边界，并标识 persistence=memory，不宣称已落盘。审计/落盘失败停止后续执行并清理状态，不能 UI 已加载但历史缺失。

### 3.8 权限与活动生命周期

allowedTools 保持基线的排他限制：未声明无额外限制，显式空列表只允许技能控制工具。兼容 allowed-tools 归一化时提示 SKILL_PERMISSION_SEMANTICS，不新增预批准授权。

原生名称与固定别名 Read/read_file、Write/write_file、Glob/glob、Grep/grep、Bash/run_command 可映射。不存在工具和 Bash(git:*) 等参数模式拒绝激活，提示迁移为宿主精确权限规则；绝不退化成允许全部 run_command。

当前 run 所有活动技能声明白名单取交集；未声明不参与交集。最终调用同时满足技能限制、PermissionPolicy、路径/执行目标规则；FullAccess、审批缓存和用户允许不能绕过技能拒绝。load_skill/list_skills/read_skill_resource 不参与业务白名单交集，但仍执行各自信任/调用/资源校验与既有权限；控制工具不能写入或执行代码。

强制检查在 tool:before 改写最终参数之后、实际执行之前，复用 PermissionPolicy 的 hardDenied 通道并审计具体技能原因。三个技能控制工具声明 builtin / fs:read，不因遗漏能力而在 Plan 中被拒或反复询问；仍服从宿主 deny 规则。宿主显式加载走同等权限检查，不能绕过关闭技能或文件读取拒绝。

load_skill 的最终结果通过 tool:after 和 tool.finished 审计且 isError=false 后，执行器根据实际工具定义身份安装 pending 收紧，在返回 runAll 前生效，同批后续调用也受限制；不能只看工具名称或解析结果文本安装状态。关联结果提交前不新增资源授权，同批资源访问返回 SKILL_NOT_COMMITTED，下一步可重试。有 Store 时提交需 append 成功，无 Store 时需完整事务进入内存历史。失败加载不改活动集合；审计/落盘失败停止后续调用并闭合结果。

模型无解除限制工具。run_finish、取消、异常、clear、切换和提前退出在工具清理/历史闭合后清空本轮活动状态。新 run 重新激活；旧正文/摘要/恢复本身不授权。提示词明确跨运行使用旧技能指导前重新加载。

### 3.9 受控资源与脚本

read_skill_resource({ name, path, startLine?, endLine?, offset? }) 只服务本轮已提交活动技能，由注册表解析根。拒绝绝对路径、盘符/UNC、.. 越界、目录、二进制文本读取、外部软链/junction；读取前重核真实根与 SKILL.md 摘要。单页最多64 KiB UTF-8，以 nextOffset 接续，offset 不与行范围混用。普通 read_file 沙箱不扩大。

单次文本上限 64 KiB，支持行范围，截断明确标记并允许分段。资源变更按本次读取审计，根/SKILL.md 变化需新 run 刷新。正文/清单不作为新增授权。

脚本可受控读取；执行仍走 run_command、技能限制、现有目标检查与审批，不增加全局脚本自动白名单。不支持的项目外执行提示复制到工作区后按原流程执行；读取不等于执行/写入。

### 3.10 上下文有效性、去重与恢复

正文保存机器可识别来源；ContextManager 据实际请求投影判断 present/requires_reload，不能只看旧调用名或正文标签。来源字段使用文本块/工具结果块上的可选 skillSource，详见 §3.11，不依赖旧 JSONL 会丢弃的任意消息级字段。

当前 run 已激活正文所在完整事务/宿主注入单元不参与一级剪裁或二级摘要。累计正文放不下走 context_budget_exceeded，不删指导后继续，也不绕过签名/不透明续答约束重排历史。

旧 run 正文可随完整轮次摘要，但保留“正文已移出，使用前重载”的结构化名称/标记；成功压缩重核有效性并失效去重，失败压缩保留有效旧投影。

仅同来源/contentDigest、完整正文仍在实际投影且本轮激活合法时可返回 already_present 引用，新的调用仍闭合。正文移出、来源变化或新 run 未激活必须重新核验与激活。恢复只恢复事实，不恢复授权、不重放工具。

### 3.11 持久化格式、失败与配置契约

不新增消息角色、ContentBlock.type、SessionRecordType 或会话 schema 版本。为 TextBlock / ToolResultBlock 增加可选 skillSource（version=1、name、scope、物理 filePath/baseDir、contentDigest、renderedDigest、caller、runId、invocationId）；contentDigest 为原 SKILL.md 字节的 SHA-256，renderedDigest 为完整包装正文 UTF-8 的 SHA-256。来源由受信任加载器注入，永远不作为恢复授权。

SessionStore 与旧 JSONLMessageStore 均保存 content 块，因此两个路径可往返；normalizeHistory 合并连续纯文本时保留各块来源，并用现有 sources 关联原消息 ID。Provider 仅投影既有 text/content 字符串，skillSource 不发送到 wire、不转换成 system 角色。投影改写/摘要移走正文时去掉其有效来源并生成重载标记；完整文本摘要不匹配时判 requires_reload。旧消息缺来源、未知来源版本或自定义 Store 未保存该字段时保留历史文本，但不做有效正文去重，不恢复权限。核心有效性检查不只读 metadata，还校验 renderedDigest 和实际可见文本。

错误遵循既有 retryPolicy，表示允许后续怎样处理，不触发加载器内部自动重试：

| 错误 | retryPolicy | 后续处理 |
|---|---|---|
| SKILL_NOT_FOUND / SKILL_INVOCATION_FORBIDDEN / SKILL_UNSUPPORTED / SKILL_POLICY_DENIED / SKILL_INVALID_INPUT / SKILL_RESOURCE_DENIED | never | 本轮相同失败不重复；可修正名称/参数或开始新任务 |
| SKILL_NOT_COMMITTED | immediate | 批次提交后可再请求；不得加入执行器 never 失败缓存 |
| SKILL_CURSOR_EXPIRED | immediate | 清空游标后重新查询，不使用旧页继续 |
| SKILL_CHANGED / SKILL_UNTRUSTED / SKILL_BODY_BUDGET_EXCEEDED | after_user_action | 结束本轮，用户更新信任/目录/任务/窗口后新运行 |
| 审计/存储失败 | 沿用 AUDIT_UNAVAILABLE / OUTCOME_UNKNOWN 的既有策略 | 先闭合/回收并停止，不宣称成功或重放工具 |

loaded 审计放在提交阶段：消息提交前执行器照常记录 tool 审计，pending 只存在内存；提交成功后记录 skill.loaded 并发 skill_loaded。提交阶段审计失败时，已落盘真实结果保留，但不发布成功事件或继续执行。短路错误产生安全诊断，不记录正文或密钥。

CLI 配置首期仅增加 skills.enabled（默认 true）和 skills.disabled（技能名称数组，默认空）；项目配置只能进一步关闭/增加禁用，enabled 按全局与已信任项目逻辑与、disabled 取并集。禁用不删除历史；不提供安装/执行自动白名单。数值默认限额在 Core 单一常量集维护，CLI 不复制预算逻辑。Headless 通过 SessionConfig 明确提供 roots/enabled/disabled/trust，不隐式扫描 home；用户写全局仍用 loadGlobalSettingsForWrite。

## 四、CLI 宿主与过程折叠

### 4.1 命令

/skills [query] 展示名称/描述/来源、用户与模型可调用性、不可用原因、当前 run 活动状态、遗漏与诊断；补全来自 Registry。

/skill <name> [task...] 直接走共享加载。user-only 允许用户入口，user-invocable=false 拒绝；缺少 task 提示用法，不自动执行。缺失/非法/忙碌/清理期间拒绝，不启动模型或追加任务。技能禁用或宿主整体关闭工具时禁用执行入口，仍可 /skills 查元数据。现有 --disable-shell 仅关闭 run_command，不整体关闭技能/文件工具；本方案不新增 --disable-tools 参数。宿主只通过 Core 根导出接入，切换重新绑定快照和工厂。

命令定义进入 COMMAND_CATALOG，/skills 为只读，/skill 为变更类 rawTail 命令；只提取首个名称，后续 task 保留引号、空格与换行，不再次按空白 split/join。任务作为独立用户文本，不做 $ARGUMENTS 替换或 shell 插值。CLI 增加 ActiveSessionController.runSkill，复用 execute 的取消/退出等待；命令通过宿主运行回调消费完整事件流并使用本轮 EventRenderer，不能直接调用 session.runSkill 绕过控制器，或借只读 statusRenderer 输出完整任务。Headless 可直接使用 Session.runSkill。

### 4.2 真实事件与缓存

复用 thinking_block_start/thinking_delta/thinking_block_stop、text_delta、tool_start/tool_progress/tool_finish、tool_messages、message_stop、run_finish；新增 skill_loaded。Core 不输出折叠指令，不改变请求/落盘。

EventRenderer 缓存当前轮次过程，以 blockId/toolUseId 保留思考、工具输入/结果、状态和耗时，默认 UTF-8 总量 1 MiB。超限保留摘要/截断标记，完整已落盘信息从历史获取；UI 上限不截断模型上下文。

summary 显示思考状态/耗时、工具脱敏摘要/状态/耗时、技能名称。所有 text_delta 保持完整流式可见，不等待最后一条；错误、取消、预算异常与审批显式可见，不能缩成成功徽章。

### 4.3 展开与输入

Ctrl+O 由 CliInputCoordinator 统一路由/解绑，仅真实 TTY 且无菜单/密钥/审批独占时生效；不创建第二个 readline，秘密输入期间不读取缓冲。Ctrl+C/EOF 保留取消与等待清理语义。

切换展示当前轮次缓存并控制后续过程渲染。仅光标锚点有效时重绘有界当前过程区域；resize 重算宽度/行数，不覆盖答案、审批、提示符或上一轮。外部输出使锚点失效则追加有标签详情快照并重建锚点，不擦写任意 scrollback。收起不追溯删除已滚入历史的详情；完整历史折叠留给 v0.0.8。

finish 幂等，解绑按键/timer；渲染不阻塞事件消费或跳过清理，详情仍脱敏并过滤终端控制序列。

### 4.4 非 TTY

新增 --output-detail summary|detailed，REPL/one-shot 共用，默认 summary。非 TTY summary 追加紧凑状态，无 ANSI/光标/动态计时；detailed 完整输出协议公开的思考、工具输入/结果和所有回答，无 UI 缓存 1 MiB 截断。模型未提供思考时不伪造，Provider 私密/不透明状态不输出。

debug 仍独立 stderr 开发诊断，不替代详情模式。帮助/脚本参数转发同步，非法选项在运行前报错；所有模式保留既有脱敏与控制字符过滤。

## 五、实施顺序与验收

按领域契约 → 有界发现/信任 → 目录预算/查询 → 共享加载/权限/资源 → 上下文/恢复 → CLI → 跨协议/终端验收推进，详见 [tasks](../../../openspec/changes/v0-0-5-skills-system/tasks.md)。

覆盖真实多行样例、无 settings 未信任项目、同物理文件跨层优先级、环/越界 junction、中文/转义预算与遗漏分页、同批加载后写操作拒绝、多技能交集/FullAccess/缓存、全局资源/脚本边界、用户-only/模型-only、压缩后重载、恢复不重放、提前退出清理、签名续答、Windows/POSIX TTY 与非 TTY 完整详情。

文档阶段检查 OpenSpec 严格校验、能力/任务映射和链接；实施阶段 pnpm verify（typecheck → test → lint，lint 含架构与密钥扫描）。真实模型验证记录模型/输入/结果和限制，不将单次遵循当作普遍质量保证。
