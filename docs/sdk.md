# SDK 使用指南（@kiturone/kapibala）

`@kiturone/kapibala` 是独立的 Headless Agent 核心包：只负责模型、循环、工具、历史、Hook 与结构化 `SessionEvent`，不包含任何终端 / GUI 组件。桌面客户端与 CLI 消费同一套能力。

```bash
npm install @kiturone/kapibala
```

## 1. 基础对话与流式事件监听

```typescript
import {
  AgentSession,
  OpenAICompatibleProvider,
  builtinTools,
  type ModelProfile,
} from '@kiturone/kapibala';

// 1. 定义模型配置
const profile: ModelProfile = {
  id: 'deepseek-flash',
  name: 'DeepSeek Flash (V4.1-Flash)',
  provider: 'openai-compatible',
  baseURL: 'https://api.deepseek.com/v1',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  modelName: 'deepseek-flash',
  supportsThinking: true,
};

// 2. 创建 OpenAI 兼容 Provider（原生 fetch + SSE 解析）
const provider = new OpenAICompatibleProvider({
  baseURL: profile.baseURL,
  apiKey: process.env.DEEPSEEK_API_KEY || 'sk-your-key',
  modelName: profile.modelName,
});

// 3. 构造 Session 会话门面（workspaceRoot 必填且必须是绝对路径）
const session = new AgentSession({
  workspaceRoot: process.cwd(),
  defaultProfile: profile,
  defaultProvider: provider,
  systemPrompt: 'You are an expert AI assistant powered by Kapibala.',
});

// 4. 注册内置安全文件工具 (read_file, write_file, edit_file, glob, grep)
for (const tool of builtinTools) {
  session.tools.register(tool);
}

// 5. 流式执行并消费事件
try {
  await session.init();
  const stream = session.run('请帮我统计当前目录下的文件');
  for await (const event of stream) {
    switch (event.type) {
      case 'text_delta':
        process.stdout.write(event.text);
        break;
      case 'thinking_delta':
        process.stdout.write(`\x1b[90m${event.thinking}\x1b[0m`);
        break;
      case 'tool_start':
        console.log(`\n[调用工具] ${event.name}...`);
        break;
      case 'tool_finish':
        console.log(`[工具结果] ${event.name}: ${event.isError ? '失败' : '完成'}`);
        break;
      case 'message_stop':
        console.log(`\n[Token 用量]`, event.usage);
        break;
    }
  }
} finally {
  await session.destroy();
}
```

## 2. 自定义业务工具 (Custom Tool)

通过 `defineTool` 注册自定义业务工具，并声明权限供执行前授权门裁决。自定义工具应自行落实其文件或网络边界；PathSandbox 不会自动包裹任意工具实现。待审批操作还需要宿主提供 `approvalChannel`。

```typescript
import { defineTool, type ToolContext } from '@kiturone/kapibala';

// 定义天气查询工具的接口；这里返回静态示例数据，不调用天气服务。
export const weatherTool = defineTool({
  name: 'get_weather',
  description: '获取指定城市的当前天气与气温',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名称，如北京、上海' },
    },
    required: ['city'],
  },
  metadata: {
    permissions: ['net:outbound'],
  },
  async execute(input: { city: string }, ctx: ToolContext) {
    return { city: input.city, weather: '晴朗', temperature: '22°C' };
  },
});

// 注册工具至会话
session.tools.register(weatherTool);
```

## 3. 持久化、Hooks 与模型路由

```typescript
import { AgentSession, SessionManager } from '@kiturone/kapibala';

// 创建独立会话并持有单写者锁；续答用 manager.open(id)，v1 旧历史自动创建 _v2 升级副本。
const workspaceRoot = process.cwd();
const manager = new SessionManager({ workspaceRoot });
const handle = await manager.create();
const session = new AgentSession({
  defaultProfile: profile, defaultProvider: provider,
  store: handle.store, conversationId: handle.conversationId,
  workspaceRoot,
});

// Hook 观察不代表授权；执行器还会裁决最终参数。
session.hooks.on('tool:before', async (_ctx, call) => {
  console.log(`即将调用工具: ${call.name}`);
  return { action: 'continue' };
});
session.hooks.on('tool:after', async (_ctx, call, result) => {
  console.log(`工具 ${call.name} 执行${result.isError ? '失败' : '完成'}`);
});

// 可另传独立的摘要 profile/provider；未绑定 summary 时回退当前 default。
session.switchModel(profile, 'summary', provider);
try {
  await session.init();
  for await (const event of session.run('请回答一句问候')) {
    if (event.type === 'text_delta') process.stdout.write(event.text);
  }
} finally {
  await session.destroy(); // 清理失败时不释放句柄，保留后续收口机会。
  await handle.release();
}
```

`JSONLMessageStore` 仍可作为旧 SDK 消息存储使用，但不具备状态存储能力，不启用可恢复压缩。原始历史与有效投影、恢复和锁边界见 [v0.0.3 迁移说明](migration/v0.0.3.md)。SDK 可以绑定 `planning`、`execution`、`fast` 槽位，通过 `run(input, { role: 'planning' })` 显式选择；每次工具循环固定该角色，缺绑定或密钥在请求前失败。

## 显式角色与原生协议

CLI 从 `modelRouting` 装载角色绑定，普通任务仍使用 `defaultModel`，首次默认保持 `deepseek-flash`。角色只选择模型，权限仍由独立的 Approval/Plan/Auto/FullAccess 规则裁决；选择 planning 不增加提示词、自动执行计划或放行写操作。

```text
/model planning claude-opus-5
/model execution gpt-6-astra
/model fast deepseek-flash
/model route planning
请先分析方案
/model route execution
按照已确认方案实现
/model route default
```

单次启动示例为 `kpbl --role planning -p "分析方案"`，必须已有可用的 planning 映射；非法角色、缺映射或选中角色缺密钥会明确失败，非交互模式不等待输入密钥。`--model` 设置本次 default 绑定；`--base-url` 与 `--api-key` 临时覆盖实际选中角色的端点和密钥，优先于环境端点覆盖，不写入配置。未使用的 default 缺密钥不会阻止已有可用角色运行，真正使用该默认绑定时再诊断。

当前角色在提示符和 `/status` 展示。CLI 内 `/new` 与 `/resume` 保留当前选择；新进程恢复历史默认回到 default，除非明确传入 `--role`。`/model <id>` 会选择 default；`/settings default <id>` 和 `/model set-default <id>` 只设置下次默认启动模型。

`summary` 只用于摘要，未绑定时回退 default；其输出目的预算不超过 4096，且受所选模型更低覆盖约束。选择 planning/execution 不会把摘要改用该角色，也不会自动扩大摘要预算。

协议由 Profile 的 `provider` 决定：`anthropic` 使用原生 Messages，`openai-responses` 使用原生 Responses，`openai-compatible` 保留 Chat Completions。自建 Claude/OpenAI 网关可以继续显式使用 Chat；不会凭模型名称猜协议。SDK 对应构造 `AnthropicProvider`、`OpenAIResponsesProvider` 或 `OpenAICompatibleProvider` 后调用 `switchModel(profile, role, provider)`；Profile 与实际 Provider 的模型、协议、端点及工作区必须一致。

内置 OpenAI 原生输出上限为 32768，Claude 为 16384，兼容模型缺省为 4096。`maxOutputTokens` 表示含思考的总输出预算，合法的用户更低配置会保留，最终还受上下文窗口约束。Chat 端点的参数和 DONE 例外通过显式 `chatCapabilities` 配置，见[兼容 Chat 说明](models/openai-compatible.md)；跨协议历史和新私有块的边界见 [v0.0.4 迁移说明](migration/v0.0.4.md)。各协议的详细差异见 [docs/models/](models/output-budget.md)。
