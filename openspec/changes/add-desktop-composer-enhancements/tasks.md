# Tasks

## 1. CLI 侧准备

- [x] 1.1 命令定义新增交互分级元数据（无需交互 / 需 question / 需 select / 需密钥），`commands/*` 逐个标注；CLI 既有测试回归
- [x] 1.2 dispatcher 补全接口确认（`getDefinitions` 已含用法摘要；不足则补），不改变 CLI REPL 行为

## 2. 桌面命令宿主（run.command）

- [x] 2.1 `shared/contracts.ts` 新增 `run.command`（PARAMS/RESULTS）与 `interaction.requested` / `interaction.reply`（三形态 + 取消语义）
- [x] 2.2 `agent-host/` 新增 CommandHostService：CommandContext 适配器（托管会话 / 宿主层 settings / 输出收集 / homeDir·settingsPath 透传）、按能力门禁解锁命令（question/select/readSecret 经对话框真实承接）；依赖 CLI 宿主回调或收据管线的命令（model/exit/prompt）在 dispatch 前拦截并返回明确不可用反馈，`run.commandList` 同步过滤（审查修正：初版占位回调会假成功，已改为能力门禁 + 兜底抛错）
- [x] 2.3 `/skill` 直发通道：context.runSkill 注入托管会话，事件流复用 run 通道；`/skill` 名称补全走会话技能目录
- [x] 2.4 desktop 单测：分发路由、忙碌门禁与 CLI 一致性、输出回传、interaction 应答/超时/关闭取消、readSecret 不落日志

## 3. 文件枚举服务（workspace.listFiles）

- [x] 3.1 `agent-host/` 新增 FileListService：沙箱根内有界枚举（深度/条目预算、忽略目录清单）、相对路径返回；contracts 注册 RPC
- [x] 3.2 单测：边界约束（沙箱外零返回）、预算截断明示、未信任工作区拒绝、跨工作区刷新

## 4. Composer UI

- [x] 4.1 抽取共享补全面板组件与触发状态机（`/` 命令态、`@` 文件态互斥；键盘导航/Tab/Enter/Esc）
- [x] 4.2 接入 `run.command`：`/` 输入拦截、未知命令反馈、命令反馈消息渲染（与模型消息区分）
- [x] 4.3 接入 `@` 引用：候选过滤/模糊匹配、不存在路径提示、轻量语义文案（引用仅为路径提示）
- [x] 4.4 交互对话框：select/question/readSecret 三形态（脱敏输入框），复用审批面板的排队/聚焦模式
- [x] 4.5 e2e：`/skills` 反馈、`/nosuchcmd` 不发模型、`/skill` 直发全授权流、`@` 边界内补全与轻量语义落盘、未信任工作区不枚举

## 5. 门禁与文档

- [x] 5.1 `check-desktop` 回归（新组件遵循 Kumo/token 规则）；`pnpm verify` 全链
- [x] 5.2 手动验收：/skill 直发与 CLI 行为对照、交互命令对话框落地（/model）、@ 引用在真实会话中模型经 read 工具取文
- [x] 5.3 文档：桌面使用说明补斜杠命令与 @ 引用小节；与 resource-management 提案的依赖关系注明（/mcp /skills 命令读资源服务，两变更实施顺序无强依赖）
