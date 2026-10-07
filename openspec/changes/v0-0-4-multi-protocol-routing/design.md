# Design

## Context

动机与范围见 [proposal.md](proposal.md)，用户确认的详细依据见 [技术设计](../../../docs/superpowers/specs/2026-10-05-v0-0-4-multi-protocol-routing-design.md)。当前代码只有 `models/openai-compatible/`；`ModelProfile.provider` 只有兼容 Chat，CLI `index.ts` 工厂也固定构造该实现。`ModelRole` 已有五种角色，但 Session 主任务的 Provider、预算和记录仍固定取 default。`SimpleModelRouter` 查询缺角色会默认回退，SDK `switchModel` 省略 Provider 会复用旧实例，新增显式路由必须绕开这些不安全的隐式行为。

`normalizeHistory` 通过连续 canonical tool 消息闭合事务；输出为 Anthropic wire user 消息会破坏这一约定。Loop 目前忽略 `parseError`，Chat 只在 DONE 和 finish_reason 都缺失时拒绝流，不能作为新增原生 Provider 的执行前门禁。`context/summary.ts` 会序列化源消息内容，新私有块需要在这里剔除。`createContextBudget` 当前输出预留封顶 4096，摘要和主任务的目的预算需要区分。

已有检查点：`openai-sse.test.ts`、`canonical-history.test.ts`、`session-cancellation.test.ts`、`session-context.test.ts`、`summary.test.ts`、`context-budget.test.ts`、CLI `model-command.test.ts` / `command-catalog.test.ts` / `active-session.test.ts`。OpenSpec 主规范暂为空，前两个已完成版本的变更文件保留作为基线，不归档或改写。

## Goals / Non-Goals

**Goals:**

- 三个独立适配器接入同一 ModelProvider、Loop、Session、Executor 和 Store；保持运行时零第三方依赖及 Headless。
- 成功终止、参数验证和工具事务闭合在任何协议中采用同一执行边界。
- 协议原始内容与 canonical 语义可校验映射，便于同模型保真续答和跨协议恢复。
- 保持默认用户路径，同时让宿主显式选择角色并获得正确的模型/预算/usage。

**Non-Goals:**

- 不另建厂商专属 Agent 循环、完整通用 SDK 或任意 JSON Schema 引擎。
- 不用角色自动开启权限、附加提示词、识别意图或判断计划批准状态。
- 不依赖远端会话链；不引入新发布方式或提前改变工作区版本号。

## Decisions

### 1. 三个独立协议适配器，薄宿主工厂

保留 `OpenAICompatibleProvider`，新增 `models/anthropic/AnthropicProvider` 和 `models/openai-responses/OpenAIResponsesProvider` 并公开导出。各自实现请求翻译、流状态机、终态、错误和 usage。CLI 将凭据解析与类型化协议选项交给 `createProvider(profile, key)`，Core SDK 由宿主构造并绑定，Core 不读取环境/设置。

HTTP 辅助只共享建连 timeout、abort 联动和 reader 清理；SSE 辅助输出完整 event/data 帧，处理 CRLF、UTF-8 分片、多行 data 和注释，协议层自行处理心跳与终态。保留现有解析入口作为兼容包装，避免无关调用迁移。模型实例和工厂参数不得出现在脱敏错误中。

未采用“一个 Provider 用 switch 管三协议”，因为请求结构、消息角色和流 Item 生命周期不同；也未将所有网关改用 Responses，因为存量 Chat 端点需要保留。

### 2. 原子绑定与执行前完成边界

将 Profile/Provider 当成一个绑定快照；内置适配器提供可比较的模型/协议/端点信息，验证 SDK 传入配对。相同绑定可继续复用，改变模型、协议或端点必须提供匹配实例；不依赖 SimpleModelRouter 的默认回退验证显式角色。切换失败不更新有效绑定，只有空闲时才允许修改。

`ModelEvent.message_stop` 增加可选 `finalContent`，必要的协议来源随内容/消息一起交付。Loop 优先使用完整内容，只从最终内容提取工具；旧 Provider 的增量路径仍支持，但也必须收到合法 message_stop。停止语义统一为 stop/tool_calls/length 或错误。一次响应的所有工具在任何一个调度之前完成 JSON 对象、名称、ID、重复和终态校验；不把 `{ _raw }` 当合法输入，不把 length/content_filter 改成工具成功。工具定义和工具自身的输入边界继续验证，不实现一套完整通用 JSON Schema 校验器。

所有 `assembleToolResults` 实现返回 canonical tool 消息。可抽取无协议语义的装配辅助，保留现有接口。增量是展示来源，最终内容是落盘来源，两者不重复执行或记账。消费者提前退出仍经过现有 executor 取消/等待、消息级落盘和锁收口，不改事务顺序。

### 3. 受控来源元数据与完整历史消费者

Anthropic thinking/redacted 块增加可选 origin，携带协议、模型、run 和端点/租户范围的非秘密标识。OpenAI reasoning 使用版本 1 的 provider_state；其 JSON 必须为合法 reasoning Item，有大小边界。message/function_call 保存与 canonical 块对应的 Item 顺序、Item ID、消息分组和 phase；工具业务 ID 使用 call_id，原 Item ID 独立记录。保留需要原样续答的原始参数串，不能只用重新 JSON.stringify 后的参数替代原请求前缀。

来源元数据只描述原始模型输出，不能被新摘要或改写内容冒用。对同协议有效历史保留普通 message phase，即使开始新 run；加密 reasoning 与签名数据的回传则仅限同 run/同模型/同端点有效工具链。跨协议保留文本与工具语义；必要的 ID wire 别名按原 ID 确定并一并映射结果，不修改 canonical 身份。旧历史来源未知时不伪造有效私有状态。

在 `types/`、SessionStore/JSONL、`history.ts`、交互索引、摘要源投影、估算器和协议序列化同时支持新类型。有 phase/Item 边界的 assistant 不能按纯文本规则合并。摘要源仅取可见文字、工具输入与结果语义，排除私有状态；实际请求估算计入协议投影和合法私有状态，未知计数使用保守估算并标明。所有转换均复制请求视图，原始历史保留。

没有把全部原始响应体当通用可执行 payload，因为工具/文本语义仍需 canonical 校验，且一般响应元数据不能替代明确的安全回传来源。

### 4. Anthropic Messages 与签名前缀

baseURL 定义为含版本前缀的服务基址，只拼一次 `/messages`；鉴权同时发送 `x-api-key` 与 `Authorization: Bearer`（官方 API 标准头为 `x-api-key`，部分网关只识别 Bearer；CLI 向导探测与 Provider 同源），并携带 `anthropic-version: 2023-06-01` 和可选 workspace。system 单独序列化，工具定义使用 input_schema；连续工具结果合并为紧邻 user content，结果在普通 user 文字前。

按内容块索引累积文本、thinking、signature、redacted_thinking 和工具 JSON；只有 message_stop 完成可提交。新增 thinking_block_start/stop，thinking_delta 可携带 blockId；不展示密文/签名，不为 omitted 生成文字。Claude 5 内置模型沿用默认自适应思考；Haiku 4.5 默认不额外开启旧式延长思考，supportsThinking 不代表已开启。

Session 每个 run 的 request-only 环境消息固定在首次投影锚点；同次用户工具链生成签名后，system/tools 和已经签名的历史前缀冻结到最终回答。Hook 若改前缀明确失败，预算不足也不通过改写前缀强行续答。通过请求上下文传递 run/model 来源，直接调用 Provider 的 SDK 若没有有效上下文，不复用来源未知的私有状态。

usage 输入等于未缓存输入+缓存读+缓存创建，cachedPromptTokens 仅缓存读。max_tokens 始终来自有效输出预算，包含思考。

### 5. OpenAI Responses 与 Chat 的差异

Responses 使用 `/responses`、`store: false` 和手动 Item 回传，不用 previous_response_id。按 Item ID/索引组装 message/reasoning/function_call，用 call_id 发送 function_call_output。保留服务端 phase，处理 refusal；只有 commentary 且无工具/最终回答不算完整成功。`response.completed` 必须伴随完整 Item；incomplete/failed/缺终态和影响执行的不支持 Item 均失败。非关键未知元数据可忽略。assistant 历史一律以 `output_text` 回传（跨协议降级后的无来源文本同属 assistant 输出，与 codex/pi/opencode 口径一致），`input_text` 仅用于 user 输入；跨协议业务 call_id 超出 `[A-Za-z0-9_-]{1,64}` 安全形状时使用确定性别名，调用与结果共用映射。

函数 schema 显式 strict false，保留旧工具可选输入语义；不静默把可选字段全部改为 required。max_output_tokens 包含推理，推理模式不发送不支持的 temperature。不主动索要推理摘要，但已有可见摘要可展示；加密状态只用于合法工具续答。

Chat 使用最小类型化 compat 选项控制上限字段、usage/采样和 DONE 例外。默认 require finish_reason+DONE，例外必须显式并有网关 fixture。继续支持既有 DeepSeek reasoning_content 策略，普通 Chat 不发送原生加密 Item。任何运行中失败不自动降级到另一协议，避免改变副作用和费用来源。截断（`length`）不在 Provider 层提前收口：与 Anthropic 一致交付到 Loop，由 Loop 统一裁决——无工具的截断文本按最终回答交付，有工具的整批拒绝执行；Anthropic 的 `pause_turn` 表示服务端工具循环暂停，本版不支持其续答，明确返回 `MODEL_INVALID_RESPONSE` 并保留 `providerCode: 'pause_turn'`，不标记任务完成、不调度客户端工具且不自动重发请求，未知停止原因携带原始 `providerCode` 明确失败。

### 6. 显式角色与宿主入口

SDK `run(input, { signal, role })` 缺 role 使用 default；CLI 保存当前角色并传入每次 run。planning/execution/fast 显式缺配置报错，summary 缺配置按既有默认回退。每 run 快照实际绑定，更新 Session 主任务准备、存储 run_started、错误、usage、context 与 status 中固定 default 的代码位置，摘要仍独立。

CLI `/model <role> <id>` 持久保存绑定，`/model route <role>` 选择主任务角色，`--role` 供非交互/启动选择。既有 `--model` 仍配置当前 default 绑定，显式 `--role` 决定主任务取哪个角色；帮助说明这一组合，不能静默覆盖角色映射。`/model <id>` 选择 default 并切回 default 角色，`/settings default` 仍只改下次启动。未指定 ID 的 `/model key` 更新当前角色模型，同组凭据刷新全部相关绑定。启动默认 default，CLI 内切历史保留当前角色，新进程恢复不恢复旧角色/授权。

角色不新增提示词或权限；只读规划由现有 Plan 规则控制。一次 run 不按模型步骤号切阶段，规划工具调用也留在 planning。没有默认自动分类请求，默认单模型用户不增加调用数。

### 7. 输出上限与目的预算

`ModelProfile.maxOutputTokens` 是用户可覆盖预算，内置原生 OpenAI 默认32768、Claude 5 默认16384，兼容 Profile 缺值沿用4096。按模型支持上限/窗口和用户更低值计算一次有效输出值，再同时供 ContextBudget、ContextManager.prepare 和 Provider 使用；数字代表含推理总输出。非法值在请求前失败。

摘要目的上限默认4096，再受 Profile 更低值约束，避免把主任务较高预算传播到摘要费用。摘要消费者检查最终内容以及增量中的工具/拒绝，按统一终态收口。`/context` 和真实请求同源，usage 缺失仍区分估算与真实费用。

## Risks / Trade-offs

- [签名或 Item 前缀被改写] → 同 run 冻结、来源验证与故障测试；预算不足停止，不通过自动协议回退掩盖。
- [网关 DONE 差异导致升级拒绝] → 只为有证据的网关提供显式例外并附回归用例。
- [SDK 联合类型扩大] → 保留旧增量字段/装配入口，迁移说明列出穷尽 switch 和 Provider 配对要求。
- [加密状态增加历史和预算开销] → 来源/结构/大小校验，摘要排除私有数据，估算标识，不删除原记录。
- [默认输出预留增长] → 仅原生 Profile 默认改变，用户更低覆盖保留，摘要上限独立；真实质量和费用单独记录。
- [主规范尚未归档] → 仅新增独立要求，不修改先前版本；将来按版本顺序同步规范，本次不执行归档。

## Migration Plan

1. 先更新共享契约/消费者并跑旧历史回归，再加固 Chat，随后接入 Anthropic、Responses；暂不切内置协议，避免工厂尚不可用。
2. 完成 SDK/CLI 绑定、路由、预算和凭据同步后，提升 BUILTIN_CATALOG_VERSION，切内置 Claude/OpenAI provider。maxOutputTokens 保留用户显式值，缺省继承内置，不进入强制覆盖目录字段。
3. 通过原始全局配置安全写入，仅同步已存内置 Profile，保留 API Key、角色引用、自建 Profile；坏文件中止写入，不物化未启用模型。
4. 验收同会话 Claude→OpenAI→Chat、JSONL重启、默认路径、取消与权限；完成 `pnpm verify`、build 和 Windows/POSIX 进程验收，写发布/迁移/验证文档。真实 API 冒烟仅在密钥和费用预算可用时执行，缺证据记未验证。
5. 工作区版本保持0.0.3到正式发布。撤销升级时保留原始设置与历史，不能为了旧代码读取而删除新块；需要明确迁移备份和版本读取限制，不承诺旧版能识别所有新增私有元数据。提交/合并/推送/标签另依 AGENTS 授权进行。
