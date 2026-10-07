# Tasks

完成状态：2026-10-07，41/41。实现、失败回归、全量门禁、跨平台进程与 SDK 文档证据见 [v0.0.4 验收记录](../../../docs/verification/v0.0.4.md)。8.3 按缺少已批准费用预算的条件交付未验证说明，不表示真实 API 已验收。

技术方案已于 2026-10-06 确认。按 1→2→3→4→5→6→7→8 顺序实施；每组的针对性测试和文档随实现完成，最后一组只做跨组集成与交付验收。先用失败回归证明具体风险，再完成实现；不为已有绿灯反复扩大无关测试。勾选任务必须对应已完成实现或明确验证材料，规划完成不代表任务完成。

规范入口：[proposal](proposal.md) 的九个 capability；技术边界见 [design](design.md)。所有 Git 写操作遵守 AGENTS 授权，本列表不授权暂存、提交、合并、推送或发布。

## 1. 共享协议契约与工具执行安全

- [x] 1.1 扩展 `models/router.ts` 的协议类型和 `types/index.ts` 的最终有序内容、思考块边界与可选来源契约；以 SDK 类型用例和 `pnpm typecheck` 验证旧增量字段仍可用。
- [x] 1.2 为内置 Provider 建立可校验的原子绑定信息并修复 `switchModel` 省略 Provider 的错配复用；用 model-profile/session 用例验证相同绑定可复用、变更协议/模型/端点错配时零请求且不改有效绑定。
- [x] 1.3 提取必要的 HTTP/完整 SSE 帧辅助，保留旧 parser 包装；用 CRLF、多行 data、UTF-8 字节分片、EOF、abort 和 reader.cancel/releaseLock 测试验证 framing 与清理。
- [x] 1.4 修改 `runtime/loop/index.ts` 优先消费 finalContent 并要求合法完成边界；用增量与最终内容重叠用例验证顺序、assistant 装配、usage 和每个工具都只处理一次。
- [x] 1.5 在任何工具调度前校验整批参数对象、parseError、名称/ID、重复与停止原因；用畸形 JSON、数组/null、重复调用、过滤、length、缺终态和一好一坏整批用例验证零工具执行且无悬空历史。
- [x] 1.6 统一 `assembleToolResults` 的 canonical tool 装配并保留 SDK 接口，跑 canonical-history/session-cancellation 相关回归验证取消先清理闭合再解锁；同步 `docs/migration/v0.0.4.md` 的 SDK 事件/绑定和工具安全变更说明。

## 2. 协议来源、历史与消费者

- [x] 2.1 定义并校验 origin、版本化 reasoning provider_state 和 Responses message/function_call Item ID/phase/原参数串元数据；用合法、未知版本、坏结构、越界和来源未知的旧记录测试验证加载边界。
- [x] 2.2 更新 `context/history.ts`、JSONL/SessionStore 和交互索引，保持 canonical tool 事务及不同 phase/Item 边界；用旧记录、新状态块、重复恢复和完整终态测试验证身份、来源和成功判断不漂移。
- [x] 2.3 实现同 run/模型/端点私有状态回传与跨协议独立投影，必要时做确定性 ID 别名；验证发送调用/结果一致、跨 run 丢弃密文但保留普通 phase、原始历史完全不变。
- [x] 2.4 修改 `context/summary.ts` 的源序列化以排除签名/密文/私有元数据；使用捕获摘要请求的用例验证只有文本/工具语义且原始历史仍保留全部来源。
- [x] 2.5 更新上下文估算和来源失效规则，使实际可回传状态与 wire 封装进入估算；验证密文不按零开销、未知用量标估算、摘要/改写内容不冒用源 Item 身份。
- [x] 2.6 补充迁移说明的历史、私有状态和旧版读取限制；以跨模型恢复示例及 JSONL round-trip 用例验证文档与实现一致。

## 3. Chat Completions 兼容层加固

- [x] 3.1 在 Chat 流状态机校验 finish_reason 和 DONE，提供已知网关显式 DONE 例外；用有原因无 DONE、仅 DONE、EOF/网络错误、显式例外用例验证严格默认且工具未提前执行。
- [x] 3.2 按最小显式 compat 能力构造 max_tokens/max_completion_tokens、usage 和采样字段；捕获请求测试验证只发送合法字段，旧兼容参数基线保留。
- [x] 3.3 保留既有 DeepSeek reasoning_content 回传并剔除未经允许的原生状态；用多工具续答、普通 OpenAI Chat 和新类型历史回归验证请求/结果完整性。
- [x] 3.4 更新兼容配置说明及有证据的网关例外 fixture，运行 openai-sse/model-errors 针对性用例；文档明确断流不能靠默认宽容判成功。

## 4. Anthropic 原生 Messages

- [x] 4.1 新增 `models/anthropic/` 独立 Provider 与 SDK 导出，处理版本/鉴权/workspace/端点、system、input_schema 和 canonical→wire 投影；用捕获请求测试验证结果在 user content 前、URL 不重复版本且历史仍为 tool。
- [x] 4.2 实现按索引文本/工具/thinking/signature/redacted 内容块组装与思考边界事件；用多块交错、分片参数、空/omitted 思考和未知非关键事件测试验证 finalContent 保序且私有数据不展示。
- [x] 4.3 在 Session 请求准备固定环境锚点并对含签名工具链冻结前缀；用第二次工具请求、Hook 修改和压缩/溢出用例验证合法前缀稳定、破坏前缀时零续答请求。
- [x] 4.4 映射 message_stop、stop_reason、HTTP/SSE 错误、取消与 usage；用缓存读/写、缺终态、max_tokens 截断及流错误测试验证完整输入统计和失败时零工具执行。
- [x] 4.5 更新 SDK 原生 Anthropic 配置/历史续答示例和验证记录的模拟证据；运行新 Anthropic 测试及相关历史/取消回归，明确 Haiku 默认不额外开启旧式思考。

## 5. OpenAI 原生 Responses

- [x] 5.1 新增 `models/openai-responses/` 独立 Provider 与 SDK 导出，构造 store:false、输入 Item、strict:false 函数和 max_output_tokens；捕获请求验证无远端状态依赖、可选 schema 语义与推理采样限制。
- [x] 5.2 实现有序 message/reasoning/function_call 流组装、Item ID/phase 与 call_id 回填；用多个消息阶段、多个函数和参数分片测试验证 finalContent 与合法同模型后续 Item 保真。
- [x] 5.3 对 encrypted reasoning 实施来源与同 run 回传校验并支持已有可见摘要事件；测试跨模型/新 run 剔除密文、普通 phase 保留、密文不展示和历史不改写。
- [x] 5.4 映射 completed/incomplete/failed/error、refusal、仅 commentary 及不支持 Item；用完整参数后 incomplete、缺终态和拒绝用例验证不误报成功、不执行工具且错误脱敏。
- [x] 5.5 解析输入/输出/缓存 usage 并更新 SDK 原生 Responses 示例、迁移与模拟验收记录；运行新 Responses 和共享取消/事务回归，验证手动历史工具续答。

## 6. Core 输出预算与场景模型路由

- [x] 6.1 接入可覆盖 maxOutputTokens 与模型/窗口约束，统一 `createContextBudget`、prepare 与协议实际上限；用4096/16384/32768、用户更低值和非法值测试验证同源预算和请求前失败。
- [x] 6.2 实现 `run(...,{role})` 的主任务快照和显式角色严格解析；以未配路由、planning 多步读取、显式缺绑定/密钥、在途切换测试验证默认路径及固定角色、零静默回退。
- [x] 6.3 替换 Session 主任务记录/usage/错误/context/status 中固定 default 的归属；捕获 run_started、usage、错误和上下文用例验证实际角色模型与窗口一致。
- [x] 6.4 保持 summary 未绑定回退 default，独立目的上限4096并检查 finalContent 中的工具/拒绝；用 planning 主任务加默认原生摘要模型测试验证来源和预算不串用。
- [x] 6.5 验证角色选择不增加提示词或修改权限；用 Plan 下 planning/execution 写操作拒绝测试证明现有授权规则生效，并更新 SDK 路由、预算和默认/摘要兜底示例。

## 7. CLI、凭据与目录迁移

- [x] 7.1 在 CLI 引入按 provider 显式构造的工厂和角色绑定装载；测试三协议对应实例、自建 Claude Chat 网关及缺密钥诊断，避免启动时触发额外分类请求。
- [x] 7.2 扩展统一 `/model` 目录/处理器实现角色绑定、route 和直接 model 切回 default；用 model-command/command-catalog 用例验证参数、帮助、空闲限制、写失败不激活和 default 设置旧语义。
- [x] 7.3 接入 `--role`、REPL/oneshot 和当前角色状态，明确其与既有 --model/default 绑定的组合；用非 TTY、非法值、无映射和进程重启用例验证不挂起、不恢复旧角色或审批。
- [x] 7.4 让未指定 ID 的 `/model key` 指向当前实际角色，并刷新全部同组 Provider 绑定；用同组两个角色换密钥用例验证后续请求用新凭据、文件只留一份且输出脱敏。
- [x] 7.5 提升内置目录版本并迁移 Claude/OpenAI 协议，加载继承原生输出默认且保留用户更低覆盖；用 settings/migration 用例验证密钥、引用、自建 Profile、坏文件和未启用内置模型不物化。
- [x] 7.6 更新 CLI 帮助、README、`docs/migration/v0.0.4.md` 和已有版本路线图引用；以命令目录测试和默认/显式/摘要兜底示例验证文档对应实际入口。

## 8. 跨协议集成与发布准备

- [x] 8.1 添加同一会话 Claude planning→OpenAI execution→Chat fast、恢复 JSONL 与中途取消的集成用例；验证工具事务闭合、角色/预算/权限一致、私有状态投影正确且原始历史不丢失。
- [x] 8.2 执行 `pnpm verify`、`pnpm build` 和必要的 Windows/POSIX CLI 真实进程验收；在 `docs/verification/v0.0.4.md` 记录门禁结果、环境、命令和具体限制，不把 build 代替类型检查。
- [x] 8.3 在已有可用密钥和费用预算时运行小规模 Anthropic/OpenAI 工具冒烟；若条件不足，交付明确的未验证项与原因记录，模拟结果不能充当真实模型证据。
- [x] 8.4 整理 `docs/releases/v0.0.4.md`、迁移与验收交叉引用及剩余风险；核对文件/SDK/配置行为和全部任务证据，版本号保持0.0.3直到正式发布。

## Workflow follow-up

- 实现通过后按项目流程审核与提交，再安排主干合并、`pnpm release 0.0.4` 和独立授权的 main/tag 推送；本变更不自动执行这些操作。
- 完成后续规范同步或归档时保留 v0.0.2/v0.0.3 的要求，按版本顺序核对已有完整变更，避免主规范缺失导致重复/覆盖。
