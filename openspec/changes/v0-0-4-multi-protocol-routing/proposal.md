# Proposal

## Why

Kapibala 当前仅有 Chat Completions 兼容适配器，内置 Claude 和较新 OpenAI 推理模型的原生工具协议无法完整接入；现有 Loop 还会忽略无效工具参数标记。v0.0.4 需要在 v0.0.3 的合法历史与完整工具事务基础上，让三种协议共用同一个运行时，并把已定义的场景角色变成可显式使用的模型绑定。

用户已于 2026-10-06 确认技术方案；依据见 [技术设计](../../../docs/superpowers/specs/2026-10-05-v0-0-4-multi-protocol-routing-design.md) 与 [开发方案](../../../docs/superpowers/specs/2026-10-05-v0-0-4-development-plan.md)。

## What Changes

- 保留独立的 `OpenAICompatibleProvider`，增加独立 `AnthropicProvider` 和 `OpenAIResponsesProvider`；共用 Session、工具执行、权限、存储与恢复。
- 加固工具执行前的完成标记、停止原因、参数 JSON、ID/名称和过滤校验；异常响应不启动工具，不自动回退协议。
- 新增最终有序内容块、思考块边界、协议来源和 Responses Item/phase 元数据；持久历史统一保存 canonical tool 消息，私有状态只在合法同模型工具续答中回传。
- 落地 `default` / `planning` / `execution` / `fast` 显式角色和独立 `summary`；未选择场景时沿用默认模型，显式角色缺绑定报错，摘要未绑定回退 default。
- 按实际角色模型统一输出预留、请求上限、usage、上下文与错误归属；新增可覆盖的 `maxOutputTokens`，摘要目的上限独立。
- CLI 增加角色绑定、选择和 `--role`；迁移内置 Claude/OpenAI 的协议字段，保留密钥、自建 Profile 和用户输出预算。
- **BREAKING**：SDK 新事件/内容联合类型需要穷尽 switch 消费者处理；更换协议/模型/端点时省略匹配 Provider 不再允许静默复用旧实例；畸形或截断工具响应由宽容调度改为执行前失败。

不包含自动意图分类、自动阶段切换、角色提示词、OpenAI 托管工具、多模态、远端会话状态或折叠 UI。

## Capabilities

### New Capabilities

- `model-provider-contract`: 三独立适配器的共享运行时、绑定配对、最终内容与工具执行安全契约。
- `openai-compatible-chat`: Chat 参数能力、严格流终止、网关例外和既有 DeepSeek 回归。
- `anthropic-messages`: 原生 Messages 请求、流式内容块、签名续答、鉴权与 usage。
- `openai-responses`: 无状态 Responses、Item/phase 保真、函数调用、加密推理与终态校验。
- `canonical-history`: 在既有路径新增协议来源、统一工具结果与私有状态投影要求。
- `scenario-model-routing`: 显式角色、默认/摘要回退、权限独立及实际模型指标。
- `model-output-budget`: 模型输出上限、实际请求和上下文预留一致、独立摘要预算。
- `cli-command-contract`: 在既有路径新增模型角色命令、非 TTY 入口和当前角色密钥更新要求。
- `model-catalog-migration`: 内置协议升级、用户数据保留和安全写入。

### Modified Capabilities

无。`openspec list --specs` 当前没有主规范；v0.0.2/v0.0.3 已完成变更尚未归档。本变更使用 ADDED 的新增要求，沿用已存在变更中的能力路径，不改写或归档之前的材料。

## Impact

涉及 Core `models/`、`types/`、`runtime/loop/`、`context/` 的历史/摘要/预算消费者，以及 CLI Provider 工厂、模型命令、参数和设置迁移；新增协议与跨协议回归测试、迁移及验收文档。保持 Headless 与运行时零依赖，沿用 `pnpm verify`、构建和 Windows/POSIX 进程验收门禁。版本号、提交、推送、发布与标签不会由规划流程执行。
