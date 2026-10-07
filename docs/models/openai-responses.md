# OpenAI Responses 原生适配器

`OpenAIResponsesProvider` 将 canonical 历史投影到原生 `/responses`，并把流响应映射为统一 `ModelEvent`。Core 不读取环境变量、CLI 设置或终端；宿主显式传入端点、密钥、模型和本次 run 来源。

```ts
const provider = new OpenAIResponsesProvider({
  baseURL: 'https://api.openai.com/v1',
  apiKey,
  modelName: 'your-native-model',
  supportsThinking: true,
});
```

`baseURL` 是含版本前缀的服务基址，适配器去掉尾部斜杠并拼一次 `/responses`。`binding` 公开实际协议、模型与基址，供 Session 检查 Profile/Provider 配对。错误不会触发协议降级。

## 请求和预算

- 固定发送 `store: false`、`stream: true` 和手动 `input`；不发送 `previous_response_id`，也不依赖远端历史。
- `systemPrompt` 作为 `instructions`；普通消息、函数调用和 canonical 工具结果分别映射为 message、function_call 和 function_call_output。
- 工具使用平铺的 Responses function 定义及显式 `strict: false`，保留已有 JSON Schema 的可选输入；执行器仍校验工具输入。
- `maxTokens` 映射为 `max_output_tokens`，代表包括推理在内的总输出预算；非法非正整数在请求前失败。
- `supportsThinking: true` 时不发送 `temperature`；缺省输出预算由宿主的目的预算计算负责。
- 通过 `include: ['reasoning.encrypted_content']` 取得无状态续答所需密文；首版不主动请求可见推理摘要。

上述无状态回传与工具格式依据 [Responses API Reference](https://developers.openai.com/api/reference/typescript/resources/responses) 和 [Responses 迁移指南](https://developers.openai.com/api/docs/guides/migrate-to-responses)。

## Item、阶段和私有状态

最终内容保留服务端 Item 顺序。每个 message 的文本块保存 Item ID、Item 索引、内容索引、`commentary` / `final_answer` 阶段和 output_text/refusal 来源；后续同协议、同模型、同端点请求保持 message 边界与阶段，即使切换到新 run。API 的 null phase 视作没有阶段标签。

function_call 的 `id` 是源 Item ID，`call_id` 是执行与结果闭合身份。canonical `tool_use.id` 使用 `call_id`；源 Item ID 和原始参数串独立保存于 `protocolMeta`。回传结果使用 `function_call_output.call_id`，不会误用 Item ID。同协议回传原始参数串，同时检查其解析结果与 canonical input 一致。

reasoning 只保存受控 `provider_state` 字段：类型、ID、密文、明确可见的 summary 和状态。只在同 run、同协议、同模型、同 Profile、同端点且确有工具续答时回传；跨模型、跨端点、新 run 和来源未知的请求投影剔除私有状态，原历史保留。最终回复之后的独立用户问题不会复用它。密文不生成展示事件；只有服务端明确返回的可见摘要生成 thinking 事件。API 的 null encrypted_content 视作没有密文。

Item 与流事件格式依据 [Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events)。

## 完成边界和错误

增量文本与工具开始/参数事件供宿主展示。工具完成及 `message_stop.finalContent` 只在 `response.completed`、全部最终 Item、工具参数与 usage 校验后交付；Loop 以完整最终内容落盘并调度一次。

`response.incomplete`、failed、error、缺少终态、未完成 Item、非法或非对象工具参数、重复 Item/调用身份、流与最终内容冲突都使响应失败。只有 commentary 且无工具或最终回答也失败。拒绝生成明确文本及 `refusal: true`；拒绝与工具混合的响应失败。

首版支持 message、reasoning、function_call、function_call_output；不支持 hosted tools、多模态或远端 response 链。影响执行的未知 Item/事件明确失败，普通非关键元数据不影响完成判断。

HTTP/流错误保留安全状态和错误码，不回显服务端正文、请求内容或密文。usage 缺失保持未知；存在时 input/output/total 和缓存 token 必须为合法非负整数。output_tokens 已包括推理 token，不重复累加。

共享 HTTP 工具保持调用者 abort 在整个流读取期间生效；SSE reader 在取消、消费者提前退出、成功或失败时清理。

## 验证范围

`packages/core/tests/openai-responses-provider.test.ts` 使用真实 `Response`/ReadableStream 与本地模拟 fetch，覆盖请求格式、阶段与 Item 保真、多个函数结果、受控密文回放、可见摘要、拒绝、终态异常、流内容冲突、usage 和取消。测试不调用付费 API；真实服务权限、实际模型质量和费用未在本测试中验证。
