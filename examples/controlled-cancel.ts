/**
 * 受控取消示例：区分「外部信号取消」与「消费者提前结束迭代」两条路径。
 *
 * 约束：两条路径都必须在释放会话锁前完成在途工具清理，并闭合已写入历史的工具事务
 * （`tool_use` 之后必须紧跟对应 `tool_result`）。已经跑完的工具保留真实结果，不因取消而回滚；
 * 取消请求成功只代表意图已传达，不代表进程或外部副作用已停止，失败轮次以
 * `OUTCOME_UNKNOWN` 语义由调用方决定是否复查系统状态。
 */
import {
  AgentSession,
  type ModelProfile,
  OpenAICompatibleProvider,
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

function createSession(workspaceRoot: string): AgentSession {
  const session = new AgentSession({
    workspaceRoot,
    defaultProfile: profile,
    defaultProvider: new OpenAICompatibleProvider({
      baseURL: profile.baseURL,
      apiKey: process.env.DEEPSEEK_API_KEY || 'mock-key',
      modelName: profile.modelName,
    }),
  });
  for (const tool of builtinTools) session.tools.register(tool);
  return session;
}

const workspaceRoot = process.argv[2] ?? process.cwd();

// 1) AbortSignal 取消：信号触发后 run 抛错，for-await 的 finally 已等待工具清理完成。
const abortSession = createSession(workspaceRoot);
await abortSession.init();
const controller = new AbortController();
setTimeout(() => controller.abort(), 1_500);
try {
  for await (const event of abortSession.run('统计当前项目里 TypeScript 文件的行数', {
    signal: controller.signal,
  })) {
    if (event.type === 'tool_start') console.log(`started: ${event.name}`);
  }
  console.log('run finished without cancellation');
} catch (error) {
  console.log(`cancelled: ${(error as Error).message}`);
}
console.log(`lock released after abort: ${!abortSession.isBusy()}`);

// 2) 消费者提前 return：break 之后生成器的清理同样必须走完，历史里不留下悬空 tool_use。
const earlySession = createSession(workspaceRoot);
await earlySession.init();
let firstDelta = '';
for await (const event of earlySession.run('用三句话介绍这个项目')) {
  if (event.type === 'text_delta') {
    firstDelta = event.text;
    break;
  }
}
console.log(`lock released after early return: ${!earlySession.isBusy()}`);
console.log(
  `history still closed: ${earlySession.getHistory().length > 0}, first delta: ${JSON.stringify(firstDelta)}`,
);
