# 场景模型路由

v0.0.4 的场景路由已在工作区实现，门禁和真实进程验收见 [验收记录](../verification/v0.0.4.md)；工作区版本仍为 0.0.3，尚未正式发布。

## 角色与作用范围

| 角色 | 用途 | 未配置时 |
| --- | --- | --- |
| `default` | 普通主任务，来自当前 default 绑定 | 启动时提供默认绑定 |
| `planning` | 用户选择的规划模型 | 请求前报错，零模型请求 |
| `execution` | 用户选择的执行模型 | 请求前报错，零模型请求 |
| `fast` | 用户选择的快速任务模型 | 请求前报错，零模型请求 |
| `summary` | 独立上下文摘要 | 未配置回退 `default`；已配置但缺密钥时调用前失败 |

没有显式选择的普通 `run()` 使用 `default`；内置初始默认仍为 `deepseek-flash`，用户更新默认模型后由新绑定决定后续默认任务。SDK 的 `selectModelRole(role)` 可明确设置后续选择，单次 `run(..., { role })` 只覆盖本次任务。配置 `modelRouting` 本身不会自动分类输入，也不会增加意图识别请求。

一次 run 固定 Profile/Provider 快照。选中 `planning` 后即使经过多个读取、搜索或其它工具回合，全部主任务模型步骤仍使用 planning；后续独立任务可选择 execution。模型请求序号、工具调用次数和提示词内容都不会自动改变阶段。

角色只选择模型。选择 planning 不自动进入只读 Plan 模式、追加计划提示词或批准计划；选择 execution 也不自动开放写权限。只读规划需要宿主/用户独立选择 Plan 权限模式，所有工具仍由现有权限和审批规则裁决。

## CLI

在空闲时绑定角色并选择当前任务角色：

```text
/model planning claude-opus-5
/model execution gpt-6-astra
/model fast deepseek-flash
/model route planning
```

完成规划后显式切换：

```text
/model route execution
```

| 命令 | 行为 |
| --- | --- |
| `/model <role> <id>` | 保存 planning/execution/fast/summary 绑定 |
| `/model route <role>` | 选择 default/planning/execution/fast 主任务角色 |
| `/model <id>` | 更新当前 default 绑定，并切回 default 角色 |
| `/model key` | 为当前实际任务角色的模型更新密钥 |
| `/model key <id>` | 为明确指定的模型更新密钥 |
| `/settings default <id>` | 只修改下次默认启动模型，不热切当前角色 |

角色配置持久化成功后才激活；失败保留原有效绑定。运行中不得修改绑定或角色。当前状态同时展示角色与实际模型，非法参数不进入用户历史，也不调用模型。

单次问答与普通 REPL 启动共用角色取值：

```sh
kpbl --role planning -p "检查现有实现并列出改动方案"
kpbl --role execution -p "按已确认的方案实现"
kpbl --model deepseek-flash --role planning -p "检查代码"
```

第三条命令中的 `--model` 配置当前 default 绑定；本次主任务仍由 `--role planning` 对应映射决定。planning 未配置时明确失败，不静默改用 `--model` 选择的默认模型。summary 不是合法主任务 `--role` 或 route 值。

新进程缺少 `--role` 时选择 default；CLI 内恢复或切换历史保留当前显式角色。恢复不会采用旧历史中的旧角色、旧权限模式或审批缓存。非 TTY 缺密钥时不等待交互秘密输入。

## SDK

SDK 宿主为每个角色提供匹配的 Profile 和 Provider，再显式选择主任务角色。以下示例假定已有 `defaultProfile`、`defaultProvider`、`planningProfile`、`planningProvider`、`executionProfile`、`executionProvider` 和事件消费者：

```ts
const session = new AgentSession({ defaultProfile, defaultProvider });
session.switchModel(planningProfile, 'planning', planningProvider);
session.switchModel(executionProfile, 'execution', executionProvider);
await session.init();
try {
  for await (const event of session.run('检查实现并形成方案', { role: 'planning' })) {
    consume(event);
  }
  for await (const event of session.run('实现已确认方案', { role: 'execution' })) {
    consume(event);
  }
} finally {
  await session.destroy();
}
```

`switchModel(profile, role, provider)` 在空闲时原子替换绑定。协议、模型名、端点或 workspace 改变时必须提供匹配 Provider；省略 Provider 只适用于实际请求目标未改变的配置更新。绑定错误发生在网络前，失败不会激活一半配置。旧自定义 Provider 可继续使用已有增量契约，宿主仍须保证实际绑定正确。

每 run 的预算、上下文窗口、usage、日志和错误归属实际主任务绑定。planning 触发的独立摘要未配置 summary 时回退 default，摘要用量单独记录，不把它算作 planning 请求。

## 协议、预算和凭据

Profile 的 `provider` 明确选择协议：`openai-compatible`、`anthropic` 或 `openai-responses`。厂商名和模型名不会覆盖该字段；Claude 名称的 Chat 网关仍请求 `/chat/completions`。协议失败不会自动降级。

| 主任务模型配置 | 缺省输出目的上限 |
| --- | --- |
| 既有兼容 Chat Profile | 4096 |
| 内置原生 OpenAI 推理 Profile | 32768 |
| 内置 Claude 5 Profile | 16384 |
| 独立 summary 目的 | 4096，再受所选 Profile 更低上限约束 |

`maxOutputTokens` 是包含推理/思考的总输出预算，可设更低的合法正整数；有效值同时进入上下文预留和实际协议输出字段，并受已知模型/窗口限制约束。切到较小窗口的 execution 模型时，下一 run 会重新检查已有历史能否装入，不能借用 planning 的窗口。

同厂商族只需一份密钥；未知厂商按端点 host 分组。同组密钥更新后刷新相关角色 Provider，后续任务使用新凭据，配置只保留一份密钥。Core 不自行读 CLI 配置或环境变量。

跨模型任务保留普通文本和 canonical 工具事务；签名、脱敏 thinking 和加密 reasoning 按同 run/模型/端点规则剔除于请求投影。原历史保留，恢复不重放工具。预算和生命周期细节见 [迁移说明](../migration/v0.0.4.md)；协议接入见 [Anthropic](anthropic.md)、[Responses](openai-responses.md) 和 [Chat](openai-compatible.md)。
