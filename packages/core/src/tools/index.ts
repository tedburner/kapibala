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
  permissions?: Capability[];
}

export interface ToolContext {
  rootDir: string;
  signal?: AbortSignal;
  logger?: (message: string) => void;
}

export interface Tool<TInput = Record<string, unknown>, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>; // JSON Schema
  readonly metadata?: ToolMetadata;
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
