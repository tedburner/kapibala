# Kapibala v0.0.4 完整开发方案

状态：版本范围已于 2026-10-05 确认，技术方案已于 2026-10-06 确认；2026-10-07 工作区实现完成。工作分支：`codex/v0-0-4-multi-protocol-routing`。协议与路由审阅基线见 [技术设计](2026-10-05-v0-0-4-multi-protocol-routing-design.md)，进度与证据以 [OpenSpec tasks](../../../openspec/changes/v0-0-4-multi-protocol-routing/tasks.md) 和 [验收记录](../../verification/v0.0.4.md) 为准。本方案不代表提交或发布授权，正式版本号仍为 0.0.3。

## 1. 版本定位与取舍

**版本主题：多协议 Agent 工具循环与显式场景模型路由。** 在 v0.0.3 的合法 canonical 历史、消息级落盘、上下文保护和权限审计基础上，接入 Anthropic Messages 与 OpenAI Responses 两种原生协议，修复现有 OpenAI Chat 兼容层的执行前校验缺口，并让 `planning`、`execution`、`fast` 成为用户可显式选择的主任务角色。

推荐采用“三协议、一个工具循环”的方案：

| 选择 | 结果 | 判断 |
| --- | --- | --- |
| 原生 Anthropic + 原生 OpenAI Responses + 保留兼容 Chat | 各协议独立翻译，统一接入 `ModelProvider`、`AgentLoop` 和 `AgentSession` | **采用**。解决内置 OpenAI 推理模型的工具协议不匹配，同时保留第三方网关。 |
| 只补 Anthropic，OpenAI 继续全部走兼容 Chat | 改动较少 | 内置 `gpt-6-astra` 的工具调用仍与官方协议要求冲突，不适合作为本版完成状态。 |
| 把所有兼容端点迁到 Responses | 适配器数量少 | 第三方 Chat 网关通常没有 Responses 端点，破坏存量配置。 |

Anthropic 原生 Messages、OpenAI 原生 Responses 与兼容 Chat 加固均已确认为 v0.0.4 交付范围。成功标准是三个协议都能经过同一工具事务规则完成多步任务，且默认 DeepSeek 用户、已有自建网关和存量历史不发生无声迁移或数据丢失。

## 2. 交付范围

| 工作流 | 必须交付的用户行为 | 边界 |
| --- | --- | --- |
| Anthropic 原生 Messages | 内置 Claude 通过原生流式文本、签名思考、多个工具调用及结果回填运行 | 仅显示服务端允许显示的思考文本；原始签名和脱敏块只供合法续答。 |
| OpenAI 原生 Responses | 内置 OpenAI 推理模型使用 Responses；支持文本、推理 Item、函数调用与 `call_id` 结果回填 | `store: false`、本地管理历史；首版不接 OpenAI 托管工具、远端会话链或多模态。 |
| OpenAI Chat 兼容加固 | DeepSeek 等现有兼容网关继续可用；无效工具参数、过滤和断流不能触发工具 | 保留显式兼容开关处理已知网关差异，不根据厂商名暗中改协议。 |
| 场景路由 | `default`、`planning`、`execution`、`fast` 由用户/SDK 显式选；同一次 `run` 全程使用该角色模型 | `summary` 独立；没有自动意图分类或按请求序号切阶段。 |
| 思考事件基础 | Core 向宿主传递结构化的可见思考与内容块边界 | 折叠、点击展开和 TUI 留待路线图后续版本。 |

本版不改变工具权限、审批缓存、历史原文、消息级落盘、`run_command` 行为或默认模型选择。内置 OpenAI/Claude 的**协议字段**会迁移，因此相同模型的回答质量、用量与延迟需要重新验收。主任务路由不新增模型分类请求。

## 3. 核心契约

### 3.1 协议与配置

`ModelProfile.provider` 明确取 `openai-compatible`、`anthropic`、`openai-responses`。CLI Provider 工厂只按该字段选适配器，密钥仍按既有厂商族共享规则解析。内置 Claude 切到 `anthropic`，内置 OpenAI 切到 `openai-responses`；DeepSeek、Gemini、Qwen 等以及所有自建 Profile 保持其显式协议。兼容 Chat 的输出上限字段、采样参数、usage 尾帧与完成标记要求采用最小的显式能力配置，不做 URL/模型名启发式推断。

三个独立目录分别是 `models/openai-compatible/`、`models/openai-responses/`、`models/anthropic/`，各自实现 `ModelProvider`；CLI 工厂构造，SDK 宿主直接构造后绑定。共同使用一套 Session、Loop、工具执行器和 canonical Store。即使 Anthropic wire 需要 user 角色装工具结果，历史仍保存 canonical tool 消息，角色转换只在适配器内发生。Profile/Provider 必须原子配对，不能更换模型或协议后复用旧 Provider；详情见技术设计 §1.1。

输出预算也是模型能力：新增 `ModelProfile.maxOutputTokens?: number`，内置原生 OpenAI 推理模型建议 32768、Claude 5 建议 16384，现有兼容 Profile 保持 4096。`createContextBudget` 的预留、`ModelRequest.maxTokens` 和实际 Provider 字段必须一致；用户显式更低上限优先，仍需满足协议约束。思考/推理 token 计入该上限。Claude 5 内置模型采用服务端默认自适应思考；Haiku 4.5 默认不开启旧式延长思考，不据 `supportsThinking` 猜测它已在思考。

### 3.2 历史与流事件

原始 canonical 历史继续作为唯一可恢复真源。Provider 在流式增量之外，成功终止时通过 `ModelEvent.message_stop.finalContent` 交付**按原始顺序的完整内容块**；Loop 以完整内容块装配最终 assistant，工具调用仅从已校验的完整响应提取。旧兼容 Provider 可继续增量装配，避免一次性重写。OpenAI 加密推理使用 `provider_state` 块，携带协议、模型 ID、run ID、版本和经结构/大小校验的原始 reasoning Item；历史读取对旧记录保持兼容，发送投影按目标协议剔除不能合法回传的私有块。可见思考事件增加块起止边界和稳定 `blockId`，密文与签名不进入 CLI 过程输出。

Responses 的 message/function_call 还需保留消息分组、源 Item ID 和 assistant phase；业务 call_id 与 Item ID 分别记录。摘要源序列化剔除签名、脱敏密文、provider_state 和协议私有元数据；预算估算则必须计入本次实际回传状态和协议开销。新增内容类型同步更新历史校验、规范化和成功交互判断，不把完整响应误标为中断。Responses 工具请求显式 `strict: false` 保持既有可选参数语义，并检查无效参数、refusal 与不支持的输出 Item。

Anthropic 的签名/脱敏思考和 OpenAI 的加密推理 Item 都只在同一次 `run` 的同协议、同模型工具续答中保留原样；跨角色、跨模型、摘要后或新 `run` 不回传。签名前的系统指令、工具定义、消息前缀与请求专用环境消息保持稳定；当前未闭合工具回合若压缩会破坏前缀，直接报上下文不足。历史原文不因投影剔除而改写。

任何协议的失败、取消或不完整响应都不能启动工具。已发出的可见文本增量可以供 UI 显示，但不能将未验证的 `tool_use` 写入历史。已经开始执行的工具按 v0.0.3 的清理、审计和结果闭合规则等待完成；不自动重放。usage 缺失仍标为未知，不能冒充零消耗。Core 继续 Headless 且运行时零第三方依赖。

三个 Provider 向 Loop 交付统一停止语义：`stop`、`tool_calls`、`length` 或错误。工具存在时若原始协议表示截断/过滤，必须以失败为准；不能用工具存在覆盖截断。摘要请求沿用统一的正常结束判定。

### 3.3 路由

`AgentSession.run` 在开始时快照主任务角色、实际 Profile 和 Provider，直到本次工具循环结束不变。SDK 用 `run(..., { role })`；CLI 以 `/model route default|planning|execution|fast` 选择当前会话角色，以 `/model <role> <id>` 绑定角色 Profile，单次问答可用 `--role`。角色切换只在空闲时生效。显式角色缺少绑定或密钥时在请求前报错；默认角色维持既有回退。普通 `/model <id>` 同时切回 default；当前角色的密钥更新同步刷新同组绑定。摘要用 `summary`，缺绑定时使用 default，默认输出目的预算仍为 4096 并独立记账。预算、usage、错误归属、日志和上下文窗口一律记录实际模型。

“场景路由”就是按任务用途预设和选取模型。例如规划用某个 Claude Profile，实施用某个 OpenAI Profile，简短问答用小模型；几个角色也可以绑定同一模型。选择 planning 不会自动编写计划、增加提示词或禁止写文件；若需要强制只读规划，使用现有 Plan 权限模式。规划完成后用户显式选择 execution，下一次请求沿用同一会话普通历史，构成跨模型接力。v0.0.4 不自动识别用途或切阶段。

## 4. 实施顺序与检查点

每个阶段完成后先检查本阶段验收，再进入依赖阶段。阶段是开发顺序，不是自动提交或发布指令。

| 阶段 | 实施内容 | 完成检查 |
| --- | --- | --- |
| A. 契约与安全基线 | 扩展 `ModelProfile` 协议类型、输出上限、完整内容块事件和来源字段；统一 canonical 工具结果与绑定配对；同步协议私有块的 JSONL/历史/摘要/预算消费者；统一停止原因并执行前校验工具 ID、名称、JSON 对象参数和完成标记。 | 模拟无效工具调用不会执行或落盘；合法旧历史读取、SDK 旧事件消费和 Headless 门禁通过，摘要源无协议密文。 |
| B. Chat 兼容加固 | 修复 `parseError` 丢失、异常 `finish_reason`、有原因但缺 `[DONE]`；按显式能力控制 `max_tokens`/`max_completion_tokens`、`stream_options` 与采样字段。 | DeepSeek 工具续答与已有网关用例保持通过；断流、过滤、无效 JSON 等均先于工具执行失败。 |
| C. Anthropic 原生 | 在 Core 增加 Messages 请求投影、HTTP/SSE 状态机、按索引内容块、签名/脱敏思考、工具结果与 usage；修复同一工具回合的动态环境消息锚点和前缀冻结。 | 文本及多工具回合、多个思考块、隐藏思考、签名续答、取消和缺终止事件均有协议模拟测试。 |
| D. OpenAI Responses 原生 | 增加无状态请求与 Item 投影、按类型/ID 流组装、加密推理 Item 与函数调用；校验 `completed`、`incomplete`、`failed`、refusal 与 schema 可选参数；保留 Item ID/phase、`call_id` 和缓存 usage。 | 多函数调用及连续工具步骤可续答，消息阶段保真；不支持的 Item 明确失败；跨模型/新 `run` 不回传加密推理 Item。 |
| E. 路由、CLI 与迁移 | 让 Session/Loop 使用实际角色模型和输出预算；完成 CLI Provider 工厂、`/model`、`--role`、角色密钥刷新、状态显示和非 TTY 错误；提升内置目录版本并迁移 Claude/OpenAI 的协议字段，内置输出上限作为可覆盖默认值。 | 四种主任务角色、SDK/CLI 入口、角色与权限独立、多工具规划回合、摘要独立、缺密钥和跨协议恢复均按设计运行；用户显式更低预算保留。 |
| F. 集成与发布准备 | 运行 `pnpm verify`、`pnpm build`、Windows/POSIX CLI 进程验收；形成迁移文档、验收记录和 `docs/releases/v0.0.4.md`。可用密钥与预算允许时做小规模真实 API 冒烟。 | 所有必需门禁通过，限制与未验证项写入验收记录；发布说明完整，版本号仍为 `0.0.3`，直到正式执行发布流程。 |

重点代码接点：`packages/core/src/models/` 的三个协议适配器，`packages/core/src/types/index.ts` 的事件/历史契约，`packages/core/src/runtime/loop/index.ts` 的安全完成边界，`packages/core/src/context/session/index.ts` 的角色与预算，`packages/cli/src/index.ts` 的 Provider 工厂，`packages/cli/src/settings.ts` 的内置清单迁移，以及 `packages/cli/src/commands/model.ts` 的命令。实现时只改动这些职责相关位置，不重构无关模块。

## 5. 验收矩阵

| 场景 | 必查结果 |
| --- | --- |
| 三协议正常回合 | 流式文本、多工具调用、结果回填、下一步续答、usage 与实际模型一致；最终历史中每个 `tool_use` 后都有对应 `tool_result`。 |
| 思考与推理 | Anthropic 多块签名和脱敏块保序；OpenAI 加密推理 Item 只用于合法回传；隐藏思考不展示，跨模型/跨协议/新 `run` 不发送旧私有数据。 |
| 故障和中断 | HTTP 错误、SSE 错误、坏 JSON、截断参数、过滤、超限、`incomplete`、缺终止标记和消费者提前结束都不执行未完成工具；在途工具完成清理并闭合审计。 |
| 路由和成本 | 四角色及 `summary` 实际模型、密钥、上下文窗口、压缩、usage、日志和 CLI 状态一致；`planning` 调用读取工具后仍保持规划模型。 |
| 升级兼容 | 旧 JSONL、旧设置与内置 Profile 升级不丢密钥、不物化未启用模型；自建兼容网关不自动切协议；默认 DeepSeek 流程不增加额外模型请求。 |
| 架构一致性 | 三适配器的 canonical 工具结果结构相同；Claude 规划 → OpenAI 执行 → Chat 问答可在同一会话切换；Profile/Provider 错配时零请求。 |
| 协议元数据 | Responses 消息分组、phase 与 Item ID 回传保真；摘要源不含签名/密文；目的预算和实际请求输出上限一致。 |

测试以可控模拟 HTTP/SSE 流为自动化门禁，覆盖分片、交错、重复、未知事件和所有终止路径；使用真实进程验证 CLI 启动、命令、退出与 Windows 工作区链接。真实 Anthropic/OpenAI API 验证需要现有可用密钥和费用预算，未执行时必须写明“未验证”，不能用模拟结果代替。

## 6. 发布与开发流程

当前在 `codex/v0-0-4-multi-protocol-routing` 分支开发，`main` 保持可发布。设计审阅完成后再按阶段实现，阶段完成可分别审查；涉及 Git 的暂存、提交、合并、推送均遵守当前会话授权和仓库 `AGENTS.md` 的确认要求，不随文档自动执行。

验收通过后先补齐发布说明、迁移说明和验证证据，再经主干合并与 `pnpm release 0.0.4` 的交互确认创建发布提交和标签；推送 main 与标签另行授权并手动执行。不得提前改三处 `package.json` 和 `CLI_VERSION` 来假装版本已发布，也不得在没有发布记录时宣称 npm/GitHub Release 完成。

## 7. 本地参考项目给出的设计依据

| 项目 | 可借鉴的设计 | Kapibala 的取舍 |
| --- | --- | --- |
| Pi | OpenAI Chat、OpenAI Responses、Anthropic Messages 分为不同适配器，按端点能力处理参数和推理回传。 | 保留明确协议边界，只实现当前 Agent 工具循环所需的 Item/内容块，不引入通用 SDK 依赖。 |
| OpenCode | Provider 工厂把 OpenAI 原生、OpenAI 兼容和 Anthropic 映射到不同协议路由。 | CLI 只按 `ModelProfile.provider` 选协议，自建网关不随品牌自动改协议。 |
| Codex | Responses 主链路要求明确的完成事件，并维护函数调用与推理上下文。 | 借鉴完成标记和 Item 保真；继续由 Kapibala 本地 canonical 历史管理恢复。 |
| grok-build | 同时存在 Chat 和 Responses 流处理，并保留工具调用与停止原因。 | 停止原因先于工具调度校验；不采用其“工具调用覆盖截断停止原因”的行为。 |
| 本地 Claude-Code 重构仓库 | 可观察交互行为和场景组织方式。 | 它声明为非官方重构，协议事实仍以 Anthropic 官方文档为准。 |

## 8. 主要风险与停止条件

- **协议私有状态被破坏**：若工具回合中的签名或加密推理 Item、请求前缀不能稳定回传，停止该协议的工具续答并报告错误，不能静默降级后继续执行工具。
- **兼容网关差异**：Chat 默认严格校验完整响应；只有已验证的网关行为才允许显式能力例外，例外必须有回归测试。
- **迁移覆盖用户配置**：使用 `loadGlobalSettingsForWrite()` 与现有纯迁移函数；损坏配置中止写入，API Key 和用户显式 `maxOutputTokens` 原样保留，内置目录只同步已有 Profile 的目录字段。
- **范围蔓延**：托管工具、自动意图分类、多模态、TUI 折叠、远端会话状态与任务内部压缩均不进入本版。任何新增能力先修改本方案与验收标准，再决定实现。

参考：[Kapibala 路线图](../../RELEASES.md)、[OpenAI Responses 迁移指南](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[OpenAI 推理模型](https://developers.openai.com/api/docs/guides/reasoning)、[Anthropic Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)。本地 Pi、OpenCode、Codex 与 grok-build 仅作为实现模式参考，协议事实以官方文档和 Kapibala 的回归测试为准。
