# Proposal

## Why

v0.0.2 将同一工作目录的所有任务追加到一份 `history.jsonl`，无法浏览和选择历史会话，`/clear` 会删除历史，长历史还会同时拖慢加载并占满模型窗口。v0.0.3 将参考 Pi 的独立会话记录与上下文投影，在本次版本交付历史会话管理，并与消息生命周期、预算和摘要检查点一起验收。

## What Changes

- 引入持久 conversationId、稳定消息 ID（推荐采用单调自增的 UUIDv7，底层 Envelope 预留 parentId 字段以向前兼容未来历史 DAG）、版本化追加记录及交互终态，保留完整工具事务与旧 JSONL 兼容。
- 每个会话一个文件，默认存于用户级 `~/.kapibala/sessions/<project-key>/`；项目按规范化工作树根归属，工作目录与 Git 分支单独记录。历史列表使用轻量元数据，不逐个加载完整会话；恢复时支持环境分支漂移感知。
- **BREAKING**：普通 `kpbl` 和未指定恢复参数的单次问答默认新建会话；使用 `/resume`、`/resume <id>`、`--resume <id>` 或 `--continue` 续答。
- 交付 `/new`、`/history`、`/resume`、`/rename`；`/clear` 在受管 CLI 会话中作为 `/new` 的兼容别名，保留旧会话。SDK 的 `AgentSession.reset()` 继续保持原有清空语义。
- 对齐参考框架的常用 Slash 命令：新增 `/context`、`/compact` 和 `/permissions`；保留 `/mode`、`/clear`、`/quit` 等兼容入口，统一模型/配置重复子命令。`/context` 提供多维分类与图形化水位展示。
- 建立统一 CLI 命令目录，集中维护主命令、别名、参数、分组帮助和空闲约束；交互菜单复用 REPL 输入协调器，非法命令不进入模型。修复默认模型写入使用合并配置的问题，持久化成功后才更新内存。
- 旧工作目录 `.kapibala/history.jsonl` 完整导入为一个可选择的历史会话，保留原文件与来源摘要，保证重试不重复导入，不猜测旧任务边界。
- 以 Pi 的会话投影与增量滚动摘要为主体实现基线，保留保守两级压缩：保护范围外的成功读取/搜索工具结果先剪裁，仍达到阈值再摘要；保护范围超限明确停止，任务内部压缩留到后续。
- 借鉴 Codex 的恢复一致性：剪裁和摘要各自校验、持久提交后激活；剪裁不改原文，后续摘要从原始结果取材。摘要输入采用有界首尾片段并检查总预算；文件详情区分成功/失败/未知。三次自动摘要操作失败仅暂停自动摘要，任务是否停止仍由最终预算决定，失败状态可恢复。
- 原始历史不因压缩删除；Summary 首版回退当前会话默认路由。稳定摘要锚点只保证未变前缀序列化一致，缓存效果独立实测，不复制 Claude Provider 专属缓存编辑或承诺零延迟。
- 提供恢复、压缩与预算事件和 CLI 统计；保证恢复与切换不复用旧会话审批缓存，不自动重放工具副作用。
- 推动 Core 内部组织结构向“六大领域分层”演进（types/、runtime/、context/、capabilities/、models/、extensibility/），彻底解耦执行引擎与上下文管理。
- 更新路线图：基本 SessionManager、历史选择和恢复从 v0.0.7 前移；v0.0.7 保留跨项目全文检索、分叉、归档增强和多智能体协调。

## Capabilities

### New Capabilities

- `session-history`: 独立会话存储、元数据发现、默认新建、历史选择与切换、旧历史导入和单写者恢复。
- `canonical-history`: 消息身份、交互终态、确定性规范化与完整工具事务恢复。
- `context-compaction`: 最终请求预算、受保护完整轮次、保守工具剪裁、滚动摘要、可恢复投影状态及失败熔断。
- `context-observability`: 宿主无关的会话恢复、压缩和预算事件，以及可区分来源的 Token 统计。
- `cli-command-contract`: 常用 Slash 命令、兼容别名、参数帮助、执行状态约束和安全配置写入的统一契约。

### Modified Capabilities

无。当前 `openspec/specs` 尚无主规范；v0.0.2 change 的执行、权限、审计和指令约束保持生效。

## Impact

- Core：实现按 `types/`、`runtime/`、`context/`、`capabilities/`、`models/`、`extensibility/` 六大领域组织，`errors/` 为基础模块；历史目录管理、规范化与上下文模块归入 context，保持 Headless 与运行时零依赖。
- CLI：启动参数、CommandContext、REPL 活动会话引用、统一输入协调、历史菜单、统一命令目录及状态/上下文展示。
- 存储：新增用户级会话目录与可重建 metadata sidecar；旧用户文件不删除。会话和工具结果仍可能含敏感正文，元数据只取有界标题，不复制密钥。
- 兼容：`MessageStore` 基础接口保持可用；新状态存储能力单独声明，旧 SDK Store 不伪装支持检查点恢复。
- 交付：Core + CLI 增量；工作区实现、完整门禁与三组真实工具任务小规模验收已完成，根/Core/CLI 均为 0.0.3。状态与限制见 [验收记录](../../../docs/verification/v0.0.3.md)；GitHub/npm 本版发布未执行。
