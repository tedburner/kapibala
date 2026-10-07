# Kapibala v0.0.4 多协议与场景模型路由设计

状态：技术方案已于 2026-10-06 由用户确认。本文保留审阅设计基线；后续实施细化、行为规范和任务进度统一维护在 [v0.0.4 OpenSpec change](../../../openspec/changes/v0-0-4-multi-protocol-routing/proposal.md)。

## 背景与目标

v0.0.4 按已确认的 [版本路线图](../../RELEASES.md) 同版交付 Anthropic 原生 Messages、OpenAI 原生 Responses、Chat Completions 兼容层加固、`fast` / `planning` / `execution` 场景路由和思考事件基础。目标是让 Claude 和 OpenAI 推理模型都通过各自原生协议完整参与现有工具循环，同时继续支持第三方兼容网关，并让用户为不同任务场景显式选择角色模型。

本版沿用 v0.0.3 的 canonical 历史、消息级落盘、上下文保护和完整工具事务。Core 继续保持 Headless，运行时零第三方依赖。`docs/design/001-agent-framework-design.md` 是既有设计基线，本设计不改动其章节编号和交叉引用。

验收标准：Anthropic Messages 与 OpenAI Responses 均能完成流式问答及多工具回合；协议私有的思考/推理数据仅在合法的同模型工具续答中原样回传；Chat 兼容层拒绝无效工具参数和不完整响应；默认用户的模型选择和请求次数不变；显式路由时每一步的实际模型、预算和指标一致；中断、失败和恢复不产生悬空工具事务。

## 方案选择

| 方案 | 行为 | 取舍 |
| --- | --- | --- |
| **显式场景路由（采用）** | 默认沿用单模型；用户选择 `planning`、`execution` 或 `fast` 后，整个 `run` 的模型步骤使用该角色；后续任务可切换角色 | 与显式计划模式、代理模型配置的本地参考实现一致；规划阶段可以包含多个工具回合，模型和费用可预测 |
| 按模型请求序号切阶段 | 首个模型请求使用 `planning`，后续请求使用 `execution` | 实现简单，但规划期间只要调用一次搜索或读取工具就会过早切到执行模型；请求序号不能证明业务阶段已结束 |
| 默认自动阶段路由或意图分类 | 自动判断任务并切换角色 | 现有配置会立即改变实际模型和费用，还需要分类准确率与错误回退验收 |

小模型意图分类保留为未来可插入的路由策略；v0.0.4 不引入分类请求，也不根据提示词启发式地隐式改变角色。

## 1. 协议与组件边界

### 1.1 显式协议类型

`ModelProfile.provider` 增加 `anthropic` 和 `openai-responses`，保留 `openai-compatible`。CLI 的 Provider 工厂按该字段构造实例，不能仅凭模型 ID、厂商族或 URL 猜协议。自定义 OpenAI 兼容网关即使承载 Claude 或 OpenAI 模型，也继续由其显式的 `provider` 字段决定协议。

原生适配器位于 Core 的 `models/` 领域，通过现有 `ModelProvider` 契约接入；各自只负责 canonical 消息与目标 wire 格式双向翻译、HTTP/SSE、错误和 usage。Loop 与 Session 负责工具执行、历史闭合、路由和预算，不引入终端或配置文件逻辑。

#### 独立适配器和统一运行时

| Profile 的协议字段 | Core 独立实现 | 请求路径（baseURL 含版本前缀） | 工具结果的发送格式 |
| --- | --- | --- | --- |
| `openai-compatible` | `models/openai-compatible/` 的 `OpenAICompatibleProvider` | `/chat/completions` | `role: tool`、`tool_call_id` |
| `openai-responses` | 新增 `models/openai-responses/` 的 `OpenAIResponsesProvider` | `/responses` | `function_call_output`、`call_id` |
| `anthropic` | 新增 `models/anthropic/` 的 `AnthropicProvider` | `/messages` | `role: user` 中的 `tool_result` |

三个类分别实现 `ModelProvider`，各自维护请求翻译、流状态机和错误映射。CLI 中独立的 Provider 工厂构造并绑定 Profile 与实例；SDK 宿主直接构造 Core 导出的适配器并绑定，Core 不读取 CLI 设置或环境变量。共同的 HTTP/SSE 工具只共享建连超时、取消清理和 SSE 帧解析，不能把三个协议塞进一个包含大量协议分支的适配器。

运行路径为“用户选角色 → Router 选 Profile/Provider → Session 准备统一历史和预算 → Provider 翻译并请求模型 → Loop 校验并执行工具 → Store 保存统一消息 → Provider 为下一步翻译结果”。工具授权、执行器、Session 锁、存储和恢复只有一套。`ModelProfile.provider` 在当前命名中表示**协议**，厂商品牌仅用于目录展示和凭据分组；同一家厂商可以有多个协议 Profile。

#### canonical 工具结果与切换边界

`ModelProvider.assembleToolResults` 继续保留现有 SDK 接口，但所有实现都必须返回 canonical `role: 'tool'` 消息和 `tool_result` 块；不得把 Anthropic wire 的 user 消息或 Responses Item 写成历史角色。`normalizeHistory` 当前通过连续 tool 消息闭合事务，只有在发送翻译阶段才能改变 wire 角色和结构。跨协议时文本、工具名、输入、结果保持语义，签名/加密状态按来源规则剔除；目标协议的 ID 语法若需转换，使用本次请求内确定性别名，并同步映射调用和结果，不改历史 ID 或重放工具。

一个路由绑定必须原子保存 Profile 与实际 Provider，协议、模型名、端点和输出预算来自同一绑定；SDK 的旧 `switchModel(..., provider?)` 不得在更换协议/模型/端点时继续复用不匹配的 Provider。显式角色查询要校验绑定存在，不能通过当前 Router 的默认回退把配置错误隐藏。主任务失败不自动从 Responses 回退到 Chat 或从 Anthropic 回退到网关。

Anthropic 默认请求带 `anthropic-version: 2023-06-01` 和明确的鉴权头，支持可选 workspace 标识；baseURL 统一只拼接一次 `/messages`，不重复版本前缀。端点、版本或 workspace 配置错误清楚报告。身份凭据按既有安全路径读取，协议回传来源还需绑定本次端点/租户范围，不能仅凭相同模型 ID 接受别处的私有状态。参考：[Anthropic Authentication](https://platform.claude.com/docs/en/manage-claude/authentication)。

### 1.2 请求序列化

- 以 v0.0.3 的合法历史投影为输入，系统指令放在 Anthropic 请求的系统字段，普通消息按 canonical 顺序序列化。
- assistant 的多个 `tool_use` 保持其内容块顺序；对应 `tool_result` 必须紧跟在下一条 user 消息的 content 中，且工具结果块排在该消息普通文本前。缺失结果由既有规范化流程记录 `OUTCOME_UNKNOWN`，绝不重放工具。
- 仅向**相同 Provider、协议和模型 ID**原样回传由原生 Anthropic Provider 产生且仍完整有效的 `thinking` 签名和 `redacted_thinking` 数据。新产出的这两类块带可选的来源模型标记并随 canonical 消息落盘；旧记录没有该标记时按来源未知处理。这是 v0.0.4 的保守兼容策略，不声称 Anthropic 禁止所有跨模型回传。跨模型、跨协议或新一次 `run` 的请求投影移除旧脱敏块；可见思考文本降级为普通文本，不携带签名。经摘要/清洗失去原始结构的思考内容也不得伪装为可回传的 Anthropic 思考块；原始历史保持不变。
- 同一次含工具调用的 Anthropic 运行中，未闭合工具回合内所有 assistant 消息的 `thinking` 与 `redacted_thinking` 块必须按原顺序、原文本和原签名回传。该回合的 `system`、工具定义和签名前的消息前缀也要保持稳定：请求专用的动态环境消息固定在首次请求中的位置，后续工具步骤不得把它移到 assistant 后面；`model:before` Hook 的输出若改变已签名前缀，应清楚失败。既有剪裁/摘要不得在这段未闭合的工具回合内改写该前缀；预算不足时报告上下文溢出，待回合闭合后再允许压缩。恢复后的旧回合按历史规范闭合，开始新 `run` 时不复用其签名块。
- 序列化时不改变原始历史，也不把凭据、请求头或原始错误体写入日志。无效的工具 ID、无法映射的内容块和超过协议约束的请求应在发出请求前清楚失败。

### 1.3 流式响应

适配器解析 Anthropic SSE 的消息、带索引的内容块、增量、usage 和结束事件；允许心跳和未知的非关键事件，协议错误与缺少 `message_stop` 的响应明确失败。文本增量、可显示的思考增量、工具参数增量继续进入现有事件流。`ModelEvent` / `SessionEvent` 增加 `thinking_block_start`、带 `blockId` 的 `thinking_delta` 和 `thinking_block_stop`，用响应内稳定块标识确定边界；旧消费者仍可读取增量文本。只向 `thinking_delta` 发送服务端明确提供的可显示文本，不推断隐藏思考，也不把签名或脱敏数据送给 CLI 展示。模型以 `display: "omitted"` 返回空思考文本时不产生可见增量，但仍保留完整签名块供工具续答。

Provider 在完整响应结束时，通过 `ModelEvent.message_stop.finalContent?: ContentBlock[]` 交付按原顺序排列的 canonical 内容块，包含 `text`、`thinking`（若有签名则保留）、`redacted_thinking`、`tool_use` 和受控的 OpenAI 加密推理 Item。Loop 优先以该完整块序列组装 assistant 历史并从中提取工具调用；现有 OpenAI 兼容 Provider 可以继续使用原有增量组装路径。流式展示与最终落盘分别消费同一响应的增量和完整内容，不因两种事件并存而重复工具调用。工具 ID/名称未完整出现前不发出可执行的工具开始事件。

取消、网络断开、SSE 解析失败、HTTP 错误或工具参数不完整时，不把未完成的 assistant 工具调用写入历史或启动工具。只有完整响应通过校验后，才执行现有工具事务闭合流程。Anthropic 的 `promptTokens` 按总输入量计算，即未缓存输入、缓存读取与缓存创建 token 之和；`cachedPromptTokens` 只记录缓存读取量。未提供的 usage 保持未知，不作为零用量显示。

三个 Provider 把协议停止原因映射为 Loop 可判定的共同语义：正常最终回答为 `stop`，完整工具调用为 `tool_calls`，输出截断为 `length`，过滤/协议失败为错误。原始停止原因只用于脱敏诊断；不得仅因为出现了 `tool_use` 就覆盖 `length` 或过滤结果。摘要请求也消费相同的正常结束语义。Anthropic 的 `max_tokens` 是必填且包含思考 token；较新 Claude 5 内置模型按其默认自适应思考运行，Haiku 4.5 默认不自动启用旧式延长思考。若以后显式开启旧式思考，必须校验 `budget_tokens < max_tokens`，并按模型能力而非统一参数发送。

当前上下文预算把输出预留封顶 4096 token，原生推理模型可能在完成工具参数或最终答复前耗尽。v0.0.4 增加 `ModelProfile.maxOutputTokens?: number`，并让 `createContextBudget`、`ContextManager.prepare` 和 Provider 请求使用同一上限：内置 OpenAI 原生推理 Profile 建议 32768、Claude 5 建议 16384，其他既有兼容 Profile 保持 4096；实际发送值还须受模型上限、上下文窗口和用户显式更低配置约束。`maxTokens` 的数字表示**含推理/思考的总输出上限**，不得把它当可见文本配额。预算变化需要在 `/context` 与验收记录中可见。

参考：[Anthropic Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)、[Tool Use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)、[Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)、[Thinking troubleshooting](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting)。

### 1.4 OpenAI 原生 Responses 与兼容 Chat

现有 `OpenAICompatibleProvider` 是 Chat Completions 兼容层，服务多个第三方网关；它已有分片工具调用、`[DONE]`、用量尾帧、取消与基本错误分类。Pi 和 OpenCode 都把原生 Responses 与兼容 Chat Completions 分成独立适配器，Codex 当前主链路也使用 Responses。v0.0.4 保留兼容层，新增独立 `openai-responses`，不对第三方网关自动改写协议。

原生 Responses 以 `store: false` 手动回传 Item，保持本地历史为唯一真源，不依赖远端 `previous_response_id`。首版支持 `message`、`reasoning`、`function_call` 和相应 `function_call_output`；其他输出 Item 明确报不支持，不静默丢弃。`function_call` 的 `call_id` 映射 canonical `tool_use.id`，结果按该 ID 回填。新增 `provider_state` 内容块只封装经结构/大小校验的 `reasoning` Item，带 `version: 1`、`protocol: 'openai-responses'`、`modelId`、`runId` 和原始 Item JSON；不向日志或 CLI 过程输出暴露密文。该块按原始顺序落盘，并仅在同一 `run`、同模型且未被摘要/改写的工具链中原样回传，不作为可见思考文本。跨模型、跨协议或新 `run` 的请求投影剔除该私有块，原始历史不变。只把 API 明确给出的可见推理摘要转换为展示事件，首版不主动请求摘要。

只保存 reasoning Item 还不足以保真：Responses 的 message/function_call 需要保留源 Item ID、消息分组、原顺序和服务端给出的 assistant `phase`，函数调用 Item ID 与业务 `call_id` 分别记录。为对应 canonical 内容添加可校验的协议来源元数据，恢复同协议消息时据此重建 Item；多个 message Item 不得合并后丢失阶段。`phase` 是普通消息语义，可在新 `run` 的同协议有效历史中继续保留，不受加密推理“仅同 run 回传”规则影响。跨协议投影只保留普通文本/工具语义；摘要或改写后的内容不伪造源 Item 身份。仅有 commentary、没有工具或最终答复的响应不得宣称任务已成功，也不靠额外无界请求补齐。

Responses 工具定义使用内部标记的 function 格式；首版显式发送 `strict: false` 以保持既有工具 schema 的可选参数语义，不静默把所有可选字段改为 required。调用参数仍必须通过运行时工具输入检查。服务端明确的 refusal 转成可见拒绝回复并标记原因，不能被丢成空回复或伴随可执行工具；未知会影响执行的 Item/事件明确失败，未知非关键元数据可以忽略。参考：[Responses 迁移](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[Reasoning 的 phase 回传](https://developers.openai.com/api/docs/guides/reasoning)。

流解析按事件类型和 Item ID/索引组装，只有 `response.completed` 才可提交完整 assistant 与工具调用。`response.incomplete`、`response.failed`、错误事件、取消和缺失终止事件均不得启动工具。参数根据原生模型能力构造：`max_output_tokens` 控制总输出预算，推理模式不发送自定义 `temperature`；usage 区分输入、输出和缓存命中。原生 SSE 和 Anthropic SSE 可共享帧解析，但各自保留独立的协议状态机。

兼容 Chat 加固聚焦已经确认的缺口：`parseError` 不再交给工具端碰运气；工具参数必须是 JSON 对象，ID、名称、完成状态和 `finish_reason` 均在执行前校验；`content_filter`、`length`、中途断流不能调度工具。官方 Chat 默认要求 `finish_reason` 和 `[DONE]`；确认会省略 `[DONE]` 的第三方网关可通过显式能力配置放宽，不能靠厂商名猜测。输出上限按端点能力选 `max_completion_tokens` 或旧 `max_tokens`，可选的 `stream_options` 与采样参数同样按能力发送。既有 DeepSeek `reasoning_content` 回传策略保持显式控制，普通 OpenAI Chat 不伪造可回传的思考内容。

依据：[OpenAI Responses 迁移指南](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[GPT-6 使用指南](https://developers.openai.com/api/docs/guides/latest-model)、[Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Chat 流事件](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)、[推理模型](https://developers.openai.com/api/docs/guides/reasoning)。

## 2. 场景路由

### 2.1 选择规则

每次 `AgentSession.run` 确定一种路由角色，在运行开始时解析对应 Profile 和 Provider，并在本次工具循环中保持该角色：

| 角色 | 本次运行的所有模型步骤 | 激活方式 |
| --- | --- | --- |
| `default` | `default` | 默认 |
| `planning` | `planning` | 用户或 SDK 显式选择 |
| `execution` | `execution` | 用户或 SDK 显式选择 |
| `fast` | `fast` | 用户或 SDK 显式选择 |

“步骤”指现有工具循环中的一次模型请求。读取、搜索或其他工具调用不会自动结束规划角色；规划完成后由宿主或用户显式切换到 `execution`，下一次 `run` 才使用执行模型。角色选择不新增独立模型请求，也不根据回复文本或工具数量猜测阶段。`summary` 继续只服务上下文摘要，与上述主任务角色独立。

场景路由的产品含义是“为某类任务预设模型，使用时选择这个模型配置”。例如 `planning` 绑定用户选定的 Claude Profile，`execution` 绑定用户选定的 OpenAI Profile，`fast` 绑定用户选定的小模型 Profile；也允许几个角色绑定同一 Profile，此时不会形成速度或能力差异。角色名称本身不证明模型更快或更擅长某项工作。

它不自动制定开发计划、执行计划、追加角色提示词或修改工具权限。`planning` 请求仍可能读文件或请求写操作，写操作是否许可由既有 `SessionMode` 和授权规则裁决。若用户希望强制只读规划，应显式使用现有 `Plan` 权限模式；模型角色和权限模式是两项独立选择。规划回复与执行回复在同一会话中通过普通消息历史衔接，v0.0.4 不新增“规划已获批”状态或自动阶段切换。

显式模式必须验证所需角色已绑定可用 Profile 和密钥；缺失时在启动模型请求前报出角色和配置问题，不静默退回默认模型。默认模式保持既有回退语义。模式只改变模型选择，不改变工具权限、审批缓存、会话锁或消息存储边界。

### 2.2 Session 与 CLI 契约

Core 提供宿主无关的角色选择入口，并让 `AgentLoop` 使用该角色绑定的 Provider。上下文窗口校验、压缩预算、请求 usage、模型错误和日志均使用**本次运行实际使用的 Profile**；运行汇总继续累加整次任务的指标。切换角色只能在 Session 空闲时进行。

CLI 将 `modelRouting` 中已配置的 `planning`、`execution`、`fast`、`summary` 绑定到对应角色。`/model <role> <id>` 管理角色 Profile，`/model route default|planning|execution|fast` 选择当前 CLI 会话的主任务角色；单次 CLI 请求可用 `--role`，SDK 用 `run(..., { role })`，合法值和缺绑定语义一致。命令注册、参数校验和帮助共用现有命令目录。角色 Profile 写入全局用户配置时采用 `loadGlobalSettingsForWrite()`，保留同厂商密钥分组规则。当前角色是 CLI 进程内会话状态，重新启动时回到 `default`；历史恢复不从旧文件恢复角色，CLI 内切换历史会话保留当前明确选择。普通 `/model <id>` 更新默认角色并将当前 CLI 角色切回 `default`，避免提示已切模型而任务仍使用 planning 模型。

CLI 在状态与错误信息中区分当前路由模式、角色绑定和本步骤实际模型。显式路由不在非交互模式隐式提示或等待补密钥；需要密钥时按现有安全输入路径处理，无法交互时明确失败。

`/model key` 未指定 ID 时指向当前任务角色的实际 Profile，同组密钥更新后同步失效相关 Provider 绑定；不能只刷新 default 而让 planning 使用旧密钥。`summary` 未绑定时仍按既有规则使用 default 绑定，独立记账，不误标为当前 planning/execution 模型。摘要默认输出上限继续保持既有 4096 的目的预算，并受所选 Profile 更低上限约束；不能因为主任务模型配置 32768 就自动放大摘要费用。摘要消费者也要检查 finalContent 中的工具调用/拒绝和正常终态，不能仅检查增量事件。示例（以下 ID 是示意占位，不是新增内置清单）：

```text
/model planning <claude-profile-id>       # 保存规划模型绑定
/model execution <openai-profile-id>      # 保存执行模型绑定
/model fast <small-profile-id>            # 保存快速问答模型绑定
/model route planning                    # 之后的任务使用规划模型
用户：阅读项目，提出登录模块改造方案。
/model route execution                   # 用户阅读方案后，下一次任务改用执行模型
用户：按上面的方案实现登录模块改造。
/model route fast
用户：解释刚才的错误信息。
```

## 3. 配置迁移与兼容性

内置 Claude Profile 的协议字段改为 `anthropic`，内置 OpenAI Profile 的协议字段改为 `openai-responses`；内置原生推理 Profile 设置 `maxOutputTokens`，并提升 `BUILTIN_CATALOG_VERSION`，让既有用户配置通过 `migrateBuiltinCatalog()` 同步协议字段。`provider` 继续是内置目录字段；`maxOutputTokens` 是用户可覆盖的输出预算，已存显式值不得被目录升级覆盖，缺省值从内置清单继承。迁移必须保留已存 API Key、用户自建 Profile 和 `defaultModel` / `modelRouting` 引用；不把未启用的内置清单物化进全局配置。内置 ID 若没有删除，不增加无意义的旧 ID 重定向。自建 Profile 的 `provider` 不受厂商族或 URL 自动迁移，用户可继续显式选择兼容 Chat。

现有 OpenAI 兼容 Provider、默认单模型调用、摘要路由、`SessionEvent` 文本/工具事件和历史存储格式继续可用。新增的完整内容块交付能力采用增量契约，旧 Provider 无需一次性重写。已有历史中缺少 Anthropic 签名的思考块仍可保留和展示其可见文本，但不得当成可回传的签名块。旧 JSONL 记录缺少 OpenAI 原生推理 Item 时按普通历史投影，不伪造加密内容；所有新私有块均有来源和版本校验。

新增内容类型需要同时更新 JSONL 校验、`normalizeHistory`、成功交互索引、摘要源序列化、预算估算和协议投影。摘要输入只包含可摘要的文本与工具语义，剔除 provider_state、签名、脱敏密文和原生 Item 私有元数据，避免把它们作为普通文字发送给另一摘要模型。实际请求预算必须计入当前协议可回传状态和封装开销；服务端未返回 token 计数时展示估算，不把密文字符数说成精确 token。SDK 新增事件变体和内容类型可能影响穷尽 switch，迁移说明给出旧事件继续消费和新事件忽略/处理示例。

## 4. 验收与发布边界

测试采用模拟 HTTP/SSE 流，覆盖以下真实协议边界：

1. 单轮文本、多个可见或空文本的思考块、逐块签名、脱敏思考及其交错顺序与标识；多工具调用和紧邻的多结果回填。
2. 分片 JSON 参数、无效或截断参数、未知事件、心跳、HTTP/SSE 错误、取消和流提前结束；失败时工具不执行、历史不悬空。
3. 含签名思考的同模型工具续答、跨模型与跨协议切换、摘要投影与历史恢复；验证动态环境消息位置和完整前缀在工具回合内保持稳定，压缩不能破坏签名回传；原始历史保留，发送投影遵守目标协议。
4. `default` / `planning` / `execution` / `fast` 的实际模型、上下文窗口、usage、错误归属及缺失角色/密钥处理；规划角色中的多个工具回合不自动切换模型。
5. 内置清单迁移保留密钥和自定义 Profile；CLI 命令契约、非 TTY 行为，以及 Windows/POSIX 的现有回归门禁。
6. OpenAI Responses 的文本、推理 Item、并行函数调用、分片参数、`call_id` 回填、缓存用量、加密推理同模型续答；失败/不完整/断流/取消不执行工具，跨模型及新 `run` 不回传私有 Item。
7. Chat 兼容层的无效 JSON、非对象参数、缺失 ID/名称、`content_filter`、`length`、有 `finish_reason` 但缺 `[DONE]`；仅显式兼容能力可放宽已知网关差异，既有 DeepSeek 回归不退化。
8. 三适配器始终产出统一 canonical tool 消息；规划使用 Claude、后续执行使用 OpenAI、再切回 Chat 的完整历史投影与恢复；Profile/Provider 配对不匹配时零请求，协议错误不自动回退。
9. Responses 多 message Item 的 ID/phase 保真与 refusal、可选参数 schema；摘要输入无协议密文，预算计入合法回传状态；新增内容类型不把完整交互误判为中断。
10. CLI `--role`、SDK role、`/model <id>` 切回默认、当前角色密钥更新、会话恢复的角色边界；选择 planning 不改变权限，Plan 权限模式继续独立裁决。

实现完成运行 `pnpm verify`、构建及必要的 CLI 进程验收。真实 Anthropic/OpenAI API 冒烟测试仅在已有可用密钥和费用预算时执行；模拟协议测试是自动化门禁的基础。若无法运行真实调用，在验收记录中明确标为未验证，不能把模拟测试写成真实模型通过。

本版不交付自动意图分类、思考内容推断、默认折叠或点击展开 UI，也不接入 OpenAI 托管工具、`previous_response_id` 状态链或多模态输入；不改动 v0.0.3 的历史闭合、消息级落盘和权限语义。折叠展示属于后续版本，v0.0.4 只提供结构化事件基础。
