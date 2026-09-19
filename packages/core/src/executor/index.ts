import { ToolError } from '../errors/index.js';
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
  /** 单次工具执行超时(毫秒)。异步挂起的工具超时后返回 isError 结果，避免永久卡死会话循环 */
  toolTimeoutMs?: number;
}

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

export class ToolExecutor {
  private readonly tools: ToolRegistry;
  private readonly hooks: HookRegistry;
  private readonly rootDir: string;
  private readonly signal?: AbortSignal;
  private readonly logger?: (msg: string) => void;
  private readonly toolTimeoutMs: number;

  constructor(options: ExecutorOptions) {
    this.tools = options.tools;
    this.hooks = options.hooks;
    this.rootDir = options.rootDir;
    this.signal = options.signal;
    this.logger = options.logger;
    this.toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
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
      const executionController = new AbortController();
      const abortFromSession = () => executionController.abort();
      if (this.signal?.aborted) {
        executionController.abort();
      } else {
        this.signal?.addEventListener('abort', abortFromSession, { once: true });
      }
      const toolCtx: ToolContext = {
        rootDir: this.rootDir,
        signal: executionController.signal,
        logger: this.logger,
      };

      try {
        const rawResult = await this.withTimeout(
          tool.execute(currentInput, toolCtx),
          call.name,
          executionController,
        );
        outputStr = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult, null, 2);
      } finally {
        this.signal?.removeEventListener('abort', abortFromSession);
      }
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

  /**
   * 给工具执行加超时护栏：Promise.race 在超时后reject，循环拿到 isError 结果继续运转，
   * 不会因某个异步工具(如未来接入的网络/exec 工具)挂起而永久卡死。
   *
   * 局限：同步 CPU 密集型实现会阻塞事件循环，timer 同样无法触发；
   * 因此内置工具仍需避免执行用户可控的同步高复杂度计算。
   */
  private withTimeout<T>(
    promise: Promise<T>,
    toolName: string,
    executionController: AbortController,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new ToolError(`Tool '${toolName}' timed out after ${this.toolTimeoutMs}ms`);
        reject(error);
        executionController.abort(error);
      }, this.toolTimeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}
