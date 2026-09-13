import type { ModelProvider } from '../../src/models/index.js';
import { defineTool } from '../../src/tools/index.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type {
  CanonicalMessage,
  ModelEvent,
  ModelRequest,
  ToolResultBlock,
} from '../../src/types/index.js';

/**
 * 按脚本逐轮回放 ModelEvent 的 mock provider —— 单测全程不触碰真实网络。
 * 与真实 Provider 一样，`assembleToolResults` 负责把结果装配成协议要求的消息形态。
 */
export class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted';
  /** 每轮请求实际看到的 canonical 历史副本(用于断言回填时序) */
  readonly requests: CanonicalMessage[][] = [];
  private readonly turns: ModelEvent[][];

  constructor(turns: ModelEvent[][]) {
    this.turns = [...turns];
  }

  async *create(req: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(req.messages.map((m) => ({ role: m.role, content: [...m.content] })));
    const events = this.turns.shift() ?? [{ type: 'message_stop' } as ModelEvent];
    for (const event of events) {
      yield event;
    }
  }

  assembleToolResults(results: ToolResultBlock[]): CanonicalMessage[] {
    return results.map((result) => ({
      role: 'tool' as const,
      content: [result],
      timestamp: Date.now(),
    }));
  }
}

/** 流到一半抛错的 provider，用来模拟生成过程中的用户中断 / 传输故障 */
export class ThrowingProvider implements ModelProvider {
  readonly name = 'throwing';

  constructor(private readonly error: Error) {}

  async *create(): AsyncIterable<ModelEvent> {
    yield { type: 'text_delta', text: 'partial' };
    throw this.error;
  }

  assembleToolResults(results: ToolResultBlock[]): CanonicalMessage[] {
    return results.map((result) => ({
      role: 'tool' as const,
      content: [result],
      timestamp: Date.now(),
    }));
  }
}

/** 构造一个只含 `echo` 工具的注册表，behavior 可注入失败/中断等行为 */
export function makeEchoToolRegistry(
  behavior?: (input: Record<string, unknown>) => string | Promise<string>,
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    defineTool({
      name: 'echo',
      description: 'Echo back the provided value.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
      },
      metadata: { source: 'test', permissions: ['fs:read'] },
      async execute(input: { value?: string }) {
        if (behavior) return behavior(input as Record<string, unknown>);
        return `echo:${input.value ?? ''}`;
      },
    }),
  );
  return registry;
}

/** 列出没有对应 tool_result 的 tool_use id —— 即"会让下游 400"的悬挂调用 */
export function findDanglingToolUses(history: CanonicalMessage[]): string[] {
  const dangling: string[] = [];

  for (let i = 0; i < history.length; i++) {
    const msg = history[i]!;
    if (msg.role !== 'assistant') continue;

    const satisfied = new Set<string>();
    for (let j = i + 1; j < history.length && history[j]!.role === 'tool'; j++) {
      for (const block of history[j]!.content) {
        if (block.type === 'tool_result') satisfied.add(block.toolUseId);
      }
    }

    for (const block of msg.content) {
      if (block.type === 'tool_use' && !satisfied.has(block.id)) dangling.push(block.id);
    }
  }

  return dangling;
}

export function makeUserMessage(text: string): CanonicalMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 };
}
