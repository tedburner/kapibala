# OpenAI Compatible Chat

## Purpose

保持现有第三方 Chat Completions 网关可用，并明确参数、完成标记和思考扩展的兼容边界；使安全执行前校验与必要的端点差异能够共同生效，而不会因为品牌或模型名称猜测而静默改变用户的请求协议。

## ADDED Requirements

### Requirement: Explicit request capabilities
Chat 请求 SHALL 按显式端点能力选择 max_tokens 或 max_completion_tokens、stream_options 与采样字段。既有兼容 Profile 未覆盖能力时 SHALL 保持其参数基线，协议身份 SHALL 不随字段选择变化。

#### Scenario: Gateway accepts only legacy output field
- **WHEN** Profile 声明该网关接受 max_tokens
- **THEN** 仅发送对应输出上限字段，不同时发送 max_completion_tokens

### Requirement: Strict completion with explicit gateway exception
Chat 默认 SHALL 校验 finish_reason 和 DONE。省略 DONE 的已知网关 SHALL 只能通过显式能力例外按合法 finish_reason 收口；普通 EOF、无效终态和缺终态 SHALL 不默认为成功。

#### Scenario: Stream closes after finish reason without DONE
- **WHEN** 未配置例外的响应有 finish_reason 但缺 DONE
- **THEN** 报不完整流，不调度其中的工具

#### Scenario: Verified gateway omits DONE
- **WHEN** 已声明允许省略 DONE 的网关提供合法完整 finish_reason
- **THEN** 响应可按该显式能力完成，参数校验和截断保护仍生效

### Requirement: Safe reasoning extension replay
系统 SHALL 保留既有 DeepSeek 思考续答策略；reasoning_content 的发送 SHALL 受显式端点策略控制，普通 OpenAI Chat SHALL 不伪造隐藏推理或私有状态。扩展回传 SHALL 不绕过完整工具校验。

#### Scenario: DeepSeek follows tool results
- **WHEN** 支持回传的 DeepSeek 配置继续工具步骤
- **THEN** 按既有规则回传可见思考历史并保持调用与结果闭合

#### Scenario: Standard OpenAI Chat transcript contains thinking
- **WHEN** 普通 OpenAI Chat Profile 消费含思考的统一历史
- **THEN** 不发送未经允许的 reasoning_content 或加密原生 Item
