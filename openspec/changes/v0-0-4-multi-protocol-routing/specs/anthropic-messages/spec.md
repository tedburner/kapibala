# Anthropic Messages

## Purpose

让原生 Claude 通过 Messages 协议消费统一合法历史并完成多工具任务，保留服务端给出的思考块与签名顺序；明确请求、回填、鉴权、取消和用量行为，使原生模型接入不需要另建一套权限、历史或工具运行时。

## ADDED Requirements

### Requirement: Native Messages request and tool results
原生 Anthropic SHALL 使用 Messages 端点、明确 API 版本和鉴权，支持可选 workspace；系统指令 SHALL 使用系统字段，tools SHALL 使用 input_schema。工具结果 SHALL 在发送时转换到紧邻 user 消息的 tool_result，普通文本排在结果后，历史角色不改写。

#### Scenario: Multiple tools finish
- **WHEN** assistant 请求多个工具并得到全部结果
- **THEN** 下一请求按对应工具 ID 回填 user 内容块，持久历史仍为 canonical tool 消息

#### Scenario: Endpoint or workspace is invalid
- **WHEN** 端点、鉴权或 workspace 无效
- **THEN** 清楚报告配置或服务端错误，不改协议或回显密钥

### Requirement: Ordered content blocks and visible thinking
系统 SHALL 按内容块索引保留文本、工具、思考、签名与脱敏块顺序，提供可见思考的稳定块身份和起止事件。签名、脱敏密文及被隐藏的思考 SHALL 不作为可见文本展示。

#### Scenario: Thinking has omitted display
- **WHEN** 响应提供空可见思考和签名
- **THEN** 保存签名用于合法续答，不产生伪造可见思考增量

### Requirement: Stable signed tool continuation
同 run、同模型和同端点范围的合法工具续答 SHALL 原样保留相关思考块与已签名前缀；动态环境锚点 SHALL 不移到新 assistant 之后。Hook 或压缩若破坏前缀 SHALL 清楚失败，不能伪造签名或继续工具执行。

#### Scenario: Hook changes a signed prefix
- **WHEN** 工具续答前 Hook 改动签名前的系统指令或消息
- **THEN** 请求前失败，已执行的工具结果仍闭合保留

#### Scenario: Retry merges consecutive user messages
- **WHEN** 失败或截断后的新 run 将连续用户消息合并到旧消息身份，并产生带私有状态的工具调用
- **THEN** 环境消息沿用首次请求确定的投影锚点，工具续答保持前缀稳定且工具不重复执行

### Requirement: Complete stream and accurate input usage
缺 message_stop、流错误和输出截断 SHALL 不启动工具。输入 usage SHALL 为 input_tokens、缓存读和缓存创建之和，缓存命中 SHALL 仅记录缓存读；max_tokens SHALL 包含思考消耗。

#### Scenario: Cached request completes
- **WHEN** 服务端提供未缓存输入、缓存读和缓存创建计数
- **THEN** 总输入包含三项，缓存命中不混入缓存创建

#### Scenario: Server tool turn is paused
- **WHEN** 响应的 stop_reason 为 pause_turn，无论是否夹带客户端工具调用
- **THEN** 明确报告当前不支持服务端工具续答，保留 providerCode，不标记任务完成、不启动工具且不自动重发请求
