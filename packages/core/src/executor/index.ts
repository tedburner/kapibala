import type { HookRegistry } from '../hooks/registry.js';
import type { ToolContext } from '../tools/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResultBlock, ToolUseBlock } from '../types/index.js';

export interface ExecutorOptions {
  tools: ToolRegistry;
  hooks: HookRegistry;
  rootDir: string;
  signal?: AbortSignal;
  logger?: (msg: string) => void;
}

export class ToolExecutor {
  private readonly tools: ToolRegistry;
  private readonly hooks: HookRegistry;
  private readonly rootDir: string;
  private readonly signal?: AbortSignal;
  private readonly logger?: (msg: string) => void;

  constructor(options: ExecutorOptions) {
    this.tools = options.tools;
    this.hooks = options.hooks;
    this.rootDir = options.rootDir;
    this.signal = options.signal;
    this.logger = options.logger;
  }

  async runAll(calls: ToolUseBlock[]): Promise<ToolResultBlock[]> {
    const results: ToolResultBlock[] = [];
    for (const call of calls) {
      if (this.signal?.aborted) {
        results.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: 'Tool execution aborted',
          isError: true,
        });
        continue;
      }
      results.push(await this.executeOne(call));
    }
    return results;
  }

  async executeOne(call: ToolUseBlock): Promise<ToolResultBlock> {
    const hookCtx = { signal: this.signal, logger: this.logger };
    let currentInput = call.input;

    // 1. 触发 tool:before hooks
    const beforeHooks = this.hooks.get('tool:before');
    for (const hook of beforeHooks) {
      const decision = await hook(hookCtx, { id: call.id, name: call.name, input: currentInput });
      if (decision.action === 'skip') {
        return {
          type: 'tool_result',
          toolUseId: call.id,
          content: decision.result,
          isError: decision.isError ?? false,
        };
      }
      if (decision.action === 'modify') {
        currentInput = decision.input;
      }
    }

    // 2. 解析与执行工具
    let outputStr: string;
    let isError = false;

    try {
      const tool = this.tools.resolve(call.name);
      const toolCtx: ToolContext = {
        rootDir: this.rootDir,
        signal: this.signal,
        logger: this.logger,
      };

      const rawResult = await tool.execute(currentInput, toolCtx);
      outputStr = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult, null, 2);
    } catch (err: unknown) {
      isError = true;
      outputStr = err instanceof Error ? err.message : String(err);
    }

    const resultBlock: ToolResultBlock = {
      type: 'tool_result',
      toolUseId: call.id,
      content: outputStr,
      isError,
    };

    // 3. 触发 tool:after hooks
    const afterHooks = this.hooks.get('tool:after');
    for (const hook of afterHooks) {
      await hook(
        hookCtx,
        { id: call.id, name: call.name, input: currentInput },
        { output: outputStr, isError },
      );
    }

    return resultBlock;
  }
}
