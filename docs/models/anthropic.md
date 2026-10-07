# Anthropic Messages

`AnthropicProvider` 是独立的原生 Messages 适配器，使用与其他协议相同的
`AgentSession`、canonical 历史、权限与工具执行器。Core 不读取环境变量或 CLI 设置。

```ts
import { AnthropicProvider } from '@kiturone/kapibala';

const provider = new AnthropicProvider({
  baseURL: 'https://api.anthropic.com/v1',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  modelName: 'your-enabled-claude-model',
  // workspaceId: 'wrkspc_...',
  // connectTimeoutMs: 60_000,
});
```

`baseURL` 是包含版本前缀的服务基址，适配器仅追加一次 `/messages`。
请求明确发送 `Authorization: Bearer ...`、`anthropic-version: 2023-06-01`，
配置工作区时发送 `anthropic-workspace-id`。多工作区密钥需要指定工作区；
无效密钥、权限、端点或工作区会形成脱敏模型错误，错误不包含原始响应正文。
请求头约定见 [官方 API 概览](https://platform.claude.com/docs/en/api/overview)。

系统指令放入独立 `system` 字段，工具定义使用 `input_schema`。
`assembleToolResults()` 始终返回 canonical `tool` 消息，实际发送时才将连续工具结果
转换为下一条 `user` 消息中的 `tool_result` 块，并排列在普通用户文本之前。
调用和结果使用同一个稳定 ID 映射，跨协议 ID 不会修改持久历史。

响应按内容块索引保留 `text`、`thinking`、`redacted_thinking` 与 `tool_use` 顺序。
签名增量拼回所属思考块，脱敏密文保留为独立块；这些私有数据不作为文本事件展示。
可见思考输出 `thinking_block_start`、带 `blockId` 的 `thinking_delta` 和
`thinking_block_stop`。省略展示的思考仅保存签名，不伪造思考文字。

只有收到合法 `message_stop`，且所有块已结束、工具参数为完整 JSON 对象时，
适配器才提供 `message_stop.finalContent`。该字段是有序落盘来源；同时产生的增量
用于宿主展示。缺少终态、重复工具 ID、无效参数、流错误或未知关键内容块都会失败。
`end_turn`/`stop_sequence` 映射为 `stop`，`tool_use` 映射为 `tool_calls`，
`max_tokens`/`model_context_window_exceeded` 映射为 `length`；拒绝标记为
`content_filter`。Loop 根据完整终态统一拒绝截断或过滤响应中的工具执行。
`pause_turn` 表示服务端工具循环暂停，需要继续请求；本版不支持该续答，返回
`MODEL_INVALID_RESPONSE` 并保留 `providerCode: 'pause_turn'`，不标记任务完成，
也不执行该响应附带的客户端工具或自动重发请求。
暂停语义见 [官方结束原因说明](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons#pause_turn)。
事件与累计计数见 [官方流式协议](https://platform.claude.com/docs/en/build-with-claude/streaming)。

上下文超限除明确错误码外，还识别 Anthropic `invalid_request_error` 的完整
`prompt is too long` 或 `prompt is too long: N tokens > N maximum` 格式；HTTP 错误须为
400/413/422，流式错误使用同一识别规则。诊断仍不回显原始错误正文，其他协议不启用
该格式匹配。仅在尚无输出且压缩确实缩短请求时，Loop 才允许一次溢出恢复；签名续答
仍保持原有前缀保护。服务端超限行为见 [官方说明](https://platform.claude.com/docs/en/build-with-claude/context-windows#context-window-overflow-behavior)。

`ModelRequest.maxTokens` 直接发送为 `max_tokens`，包含思考消耗；独立 SDK 请求缺省为
4096，非正整数在请求前失败。适配器沿用模型原生默认思考行为，不根据能力标签发送
旧式思考开关或预算。`temperature` 仅在调用者明确提供时发送。

输入用量为 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，
`cachedPromptTokens` 仅计缓存读取。`output_tokens` 使用服务端最新累计值，不重复累加。
缺失完整用量时省略 `usage`，不把未知费用报告为零。

思考与脱敏块记录非秘密来源：协议、模型、run、Profile 身份、端点/工作区范围。
仅有来源匹配的同 run 工具续答可以回传签名与密文；换模型、端点、工作区或 run 后，
可见思考成为普通文本，私有状态不再发送。直接调用 SDK 若需同 run 续答，必须在各次
`create()` 中传入相同的有效 `context: { runId, modelId }`；缺失上下文不能复用私有状态。
Session 同 run 还会保护签名前的请求前缀；Hook 或压缩破坏前缀时必须停止续答。

取消与消费者提前退出会等待流 reader 清理，并解除 HTTP 请求的取消监听。
适配器不自动重试、重放工具或降级协议。离线回归覆盖请求投影、多个工具、签名顺序、
省略展示、来源隔离、usage、错误与取消；真实 API 可用性及模型质量需要独立付费验收。
