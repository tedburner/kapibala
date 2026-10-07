# OpenAI Compatible Chat

`OpenAICompatibleProvider` 使用 `<baseURL>/chat/completions`，协议标识始终为 `openai-compatible`。能力覆盖只调整该 Chat 端点的请求字段与完成边界。

## 显式端点能力

Profile 的 `chatCapabilities` 与 Provider 构造参数中的同名选项使用相同类型；宿主创建 Provider 时传入该配置。

| 字段 | 缺省行为 | 显式覆盖 |
| --- | --- | --- |
| `maxTokensField` | `max_tokens` | `max_completion_tokens`，始终只发一个上限字段 |
| `supportsStreamingUsage` | 发送 `stream_options: { include_usage: true }` | `false` 时省略 |
| `supportsTemperature` | 发送请求温度，未指定时为 `0.7` | `false` 时省略 |
| `requiresDone` | 合法 `finish_reason` 与 `[DONE]` 均必需 | 仅确认会省略 `[DONE]` 的网关可配置 `false` |
| `replayReasoningContent` | DeepSeek 官方 `api.deepseek.com` 端点回传可见思考，其他端点省略 | 显式布尔值优先于旧构造选项 `replayReasoningContent` |

```ts
const provider = new OpenAICompatibleProvider({
  baseURL: 'https://gateway.example/v1',
  apiKey,
  modelName: 'gateway-model',
  chatCapabilities: {
    maxTokensField: 'max_completion_tokens',
    supportsStreamingUsage: false,
    supportsTemperature: false,
    requiresDone: false, // 仅用于已验证省略 DONE 的网关。
  },
});
```

能力配置不根据厂商或模型名称推断；缺省沿用既有兼容请求字段。DeepSeek 官方思考回传保留既有端点策略，可显式关闭；自建网关需显式开启。

## 完成与工具执行边界

无工具响应只接受 `finish_reason: "stop"`，有工具响应只接受 `"tool_calls"`。默认缺少任一完成标记都报 `MODEL_STREAM_INCOMPLETE`；`requiresDone: false` 只允许在已有合法终态时省略 DONE，普通 EOF 仍失败。`length` 按截断失败处理；`content_filter`、未知终态和不匹配的工具终态均失败。

工具按响应的 `index` 收集分片。ID 和名称均出现后才发送开始事件，此前的参数增量缓存在内存中并使用最终稳定 ID 依次发送。缺失、重复或发生变化的身份不能完成；系统不会生成替代工具 ID。

所有工具参数必须是完整 JSON 对象；空字符串表示无参数对象 `{}`。坏 JSON、数组、`null` 和其他原始值都报 `MODEL_INVALID_RESPONSE`。先校验整批调用，再发送任何 `tool_call_finish`，防止前面的合法工具在后续调用无效时被执行。仅收到合法终态后产生 `message_stop`，不会把坏参数降级成 `_raw`。

响应读取支持完整 SSE 帧、UTF-8 分片、CRLF、多行 data 和心跳注释。终态 choice 后、DONE 前到达的 usage 仍被保留，包括 OpenAI `prompt_tokens_details.cached_tokens` 和 DeepSeek `prompt_cache_hit_tokens`。

## 历史与失败

所有工具结果保持 canonical `tool` 消息，发请求时转换成 Chat `tool_call_id`。DeepSeek 续答按既有策略回传完整可见 `reasoning_content`；普通 Chat 不发送思考扩展、签名、脱敏思考或 Responses 加密私有 Item。

建连超时只限制收到响应头前的等待，调用者取消在读取阶段仍联动；提前结束迭代会等待 reader 取消并释放锁。HTTP 错误和流中错误保留既有诊断分类；连接中断、无效响应和执行前校验失败均不自动重放请求、工具或切换协议。

离线验收覆盖见 `packages/core/tests/openai-chat-compatibility.test.ts` 与 `packages/core/tests/openai-sse.test.ts`，包括已声明省略 DONE 的网关 fixture；该 fixture 不代表任意真实网关都支持此例外。
