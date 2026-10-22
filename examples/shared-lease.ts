/**
 * 共享写租约示例：同一个业务宿主用**一个** `WorkspaceLeaseCoordinator` 装配多个会话与子代理。
 *
 * 约束：`AgentSession` 未收到 `leaseCoordinator` 时创建会话独占实例，两个独立 SDK 会话之间
 * 不存在任何隐含互斥；只有注入同一实例才共享租约。协调器只活在内存里，不进 wire、任务记录
 * 或模型请求，也不能序列化后恢复。自定义 runner 必须消费第三个参数取得父协调器，否则后代
 * 会退化成独占租约。
 */
import {
  AgentRuntime,
  AgentSession,
  type ModelProfile,
  OpenAICompatibleProvider,
  type SubagentSessionRunner,
  WorkspaceLeaseCoordinator,
  builtinTools,
} from '@kiturone/kapibala';

const profile: ModelProfile = {
  id: 'deepseek-v4-flash',
  name: 'DeepSeek V4 Flash',
  provider: 'openai-compatible',
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  modelName: 'deepseek-v4-flash',
};

function createProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    baseURL: profile.baseURL,
    apiKey: process.env.DEEPSEEK_API_KEY || 'mock-key',
    modelName: profile.modelName,
  });
}

/** 宿主级协调器：本文件所有会话与子代理共用它，写操作按物理工作区分桶串行。 */
const leaseCoordinator = new WorkspaceLeaseCoordinator();

function createSession(workspaceRoot: string): AgentSession {
  const session = new AgentSession({
    workspaceRoot,
    defaultProfile: profile,
    defaultProvider: createProvider(),
    leaseCoordinator,
  });
  for (const tool of builtinTools) session.tools.register(tool);
  return session;
}

/**
 * 子代理执行器：从运行上下文取父协调器注入子会话。
 * 传入 `AgentRuntime` 的 runner 若忽略该参数，子会话会自建独占协调器，父宿主失去互斥保证。
 */
const runner: SubagentSessionRunner = async (record, signal, context) => {
  const child = new AgentSession({
    workspaceRoot: record.workspaceRoot,
    defaultProfile: profile,
    defaultProvider: createProvider(),
    leaseCoordinator: context.leaseCoordinator,
  });
  for (const tool of builtinTools) child.tools.register(tool);
  let text = '';
  for await (const event of child.run(record.prompt, { signal })) {
    if (event.type === 'text_delta') text += event.text;
  }
  return { summary: text.trim(), modelId: profile.id };
};

const runtime = new AgentRuntime({ runner });
const workspaceRoot = process.argv[2] ?? process.cwd();

const runTask = async (session: AgentSession): Promise<string> => {
  await session.init();
  let text = '';
  // 同一宿主共享租约，但每个会话仍只允许一个在途 run；忙碌时抛 SessionBusyError。
  for await (const event of session.run('列出当前目录下的三个文件名')) {
    if (event.type === 'text_delta') text += event.text;
  }
  return text;
};

const summaries = await Promise.all(
  [createSession(workspaceRoot), createSession(workspaceRoot)].map(runTask),
);
console.log(`Kapibala shared-lease example finished: ${runtime.listTasks().length} tasks tracked`);
for (const summary of summaries) console.log(summary.trim());
