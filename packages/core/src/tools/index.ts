import type { ShellScope } from '../security/permissions.js';
import type { ToolDefinition } from '../types/index.js';
export type { ToolDefinition };

export type Capability =
  | 'fs:read'
  | 'fs:write'
  | 'exec'
  | 'net:outbound'
  | 'env:read'
  | 'agent:spawn';

export interface ToolMetadata {
  source?: string;
  dangerous?: boolean;
  /** 所需能力的声明；v0.0.1 不据此授权，v0.0.2 的执行前权限决策才会消费。 */
  permissions?: Capability[];
  /** 工具自身等待进程资源回收，执行器不可再使用通用 Promise.race 超时。 */
  managesTimeout?: boolean;
}

export interface ToolContext {
  rootDir: string;
  signal?: AbortSignal;
  logger?: (message: string) => void;
  /** 命令工具在真实进程创建后调用；审计失败时须先回收进程再报告结果未知。 */
  onProcessSpawned?: () => Promise<void>;
  onProgress?: (progress: { elapsedMs: number; outputBytes: number }) => void;
}

export interface Tool<TInput = Record<string, unknown>, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>; // JSON Schema
  readonly metadata?: ToolMetadata;
  approvalScope?(input: TInput, rootDir: string): ShellScope;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
}

export function defineTool<TInput = Record<string, unknown>, TOutput = unknown>(
  tool: Tool<TInput, TOutput>,
): Tool<TInput, TOutput> {
  return tool;
}

export function toToolDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}
