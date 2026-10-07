# OpenAI Responses

## Purpose

让原生 OpenAI 推理模型通过无状态 Responses 完成函数工具任务，并在本地历史中保留可验证的输出 Item、消息阶段与加密推理来源；使手动回传、跨模型切换、错误和恢复都能遵循统一 Agent 工具事务规则。

## ADDED Requirements

### Requirement: Stateless local conversation ownership
原生 Responses SHALL 设置 store 为 false 并手动投影历史，不依赖 previous_response_id。首版 SHALL 支持 message、reasoning、function_call 和 function_call_output；影响执行的不支持 Item SHALL 明确失败。

#### Scenario: Session restarts
- **WHEN** 用户从本地历史恢复会话
- **THEN** 可使用统一历史继续任务，不要求取回远端 response 状态

### Requirement: Item identity and phase fidelity
系统 SHALL 保留有序 Item、消息分组、源 Item ID 和原始 assistant phase；函数调用 Item ID 与业务 call_id SHALL 分开记录。同协议有效历史 SHALL 保留普通 phase 元数据，摘要或跨协议内容 SHALL 不伪造原 Item 身份。

#### Scenario: Multiple messages have different phases
- **WHEN** 一个响应包含 commentary 与 final_answer 消息
- **THEN** 后续同协议回传保持消息边界和各自 phase，不把过程说明合并成最终回答

#### Scenario: A function output is returned
- **WHEN** 某 function_call 已执行
- **THEN** 结果匹配其 call_id，不能使用源 Item ID 代替

### Requirement: Encrypted reasoning continuation
加密 reasoning SHALL 仅在同 run、同协议、同模型、同端点范围且结构有效的工具续答中原样回传。跨模型或新 run SHALL 从请求投影剔除其密文而保留历史；只有明确提供的可见摘要 SHALL 展示，首版不主动请求摘要。

#### Scenario: User chooses another model after a tool run
- **WHEN** 后续任务切换模型或协议
- **THEN** 普通任务历史仍可用，旧加密 reasoning 不发送给目标模型

### Requirement: Terminal events and refusal are explicit
仅 completed 且全部 Item 完整合法的响应 SHALL 允许调度工具；incomplete、failed、错误或缺终态 SHALL 阻止执行。拒绝 SHALL 作为明确回复展示，不能丢成空成功或伴随工具执行；仅 commentary 且无工具/最终回答 SHALL 不算任务成功。

#### Scenario: Stream has full arguments but ends incomplete
- **WHEN** 服务端返回 incomplete，参数看似完整
- **THEN** 不执行工具并报告终止原因

### Requirement: Tool schemas preserve optional inputs
函数定义 SHALL 使用 Responses 工具格式并显式 strict false，以保留现有可选输入语义；参数 SHALL 仍经过运行时输入校验。输出上限 SHALL 使用 max_output_tokens，推理模式 SHALL 不发送不支持的采样参数。

#### Scenario: An existing tool has optional fields
- **WHEN** 同一工具从兼容 Chat 切到原生 Responses
- **THEN** 可选字段不会被静默改为必填，执行输入仍需合法
