# Model Output Budget

## Purpose

把模型输出上限与上下文预留、思考消耗和实际协议字段统一起来，使原生推理模型有明确可覆盖的预算，同时让现有兼容模型与摘要保持可预测的费用边界，避免界面估算和真正发送请求的限制各算一套。

## ADDED Requirements

### Requirement: One effective output ceiling
Profile SHALL 支持正整数 maxOutputTokens；有效上限 SHALL 同时约束上下文输出预留和实际请求，并受模型/窗口限制及用户显式更低值约束。非法预算 SHALL 在请求前失败，包含思考/推理总输出。

#### Scenario: User lowers the output budget
- **WHEN** Profile 的上限低于内置建议且合法
- **THEN** 上下文预留与协议输出字段使用相同有效值，不能仍发送旧的较高上限

### Requirement: Native reasoning defaults remain explicit
内置 OpenAI 原生推理 Profile SHALL 使用 32768 的建议上限、Claude 5 使用 16384；无覆盖的现有兼容 Profile SHALL 保持 4096。这些值 SHALL 作为可覆盖默认值，不代表可见文本配额或保证模型一定耗尽预算。

#### Scenario: Existing DeepSeek settings are loaded
- **WHEN** 旧兼容 Profile 没有输出上限覆盖
- **THEN** 保持原输出目的上限，不因新增原生适配器扩大请求预算

### Requirement: Summary purpose budget is separate
摘要默认输出上限 SHALL 保持 4096，并受所选 Profile 更低上限和窗口限制约束；主任务原生推理默认 SHALL 不自动扩大摘要预算。摘要的最终内容 SHALL 同样校验工具尝试、拒绝与正常终态。

#### Scenario: Default native model also produces a summary
- **WHEN** 主任务模型上限为 32768 且 summary 回退该模型
- **THEN** 摘要输出目的上限仍不超过 4096，实际缺完整结果时报告摘要失败

### Requirement: Context display distinguishes measured and estimated use
上下文展示 SHALL 使用实际绑定的有效预算；没有当前请求 usage 时 SHALL 标注估算，不将协议私有状态当零开销或将密文字符数称作精确 token。

#### Scenario: Native request returns no usage
- **WHEN** 原生模型没有提供用量
- **THEN** 展示当前模型的估算占用并明确未知实际消耗
