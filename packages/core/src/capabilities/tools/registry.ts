import { ToolNotFound } from '../../errors/index.js';
import type { Tool, ToolDefinition } from './index.js';
import { toToolDefinition } from './index.js';

/** 同名工具冲突策略：error 直接抛错；prefer-builtin 保留既有内置注册；prefer-last 后到者覆盖。 */
export type ConflictPolicy = 'error' | 'prefer-builtin' | 'prefer-last';

/**
 * 按名称索引的工具注册表。冲突按构造时给定的策略处理，胜出条目的来源标签保持不变；
 * 来源标签支持按源批量注册与注销，注销只移除以该标签注册的工具，不回收冲突中保留的内置实现。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly toolSources = new Map<string, string>(); // toolName -> source
  private readonly conflictPolicy: ConflictPolicy;

  constructor(options?: { conflictPolicy?: ConflictPolicy }) {
    this.conflictPolicy = options?.conflictPolicy ?? 'error';
  }

  register(tool: Tool, opts?: { source?: string }): void {
    const source = opts?.source ?? tool.metadata?.source ?? 'builtin';
    const existing = this.tools.get(tool.name);

    if (existing) {
      if (this.conflictPolicy === 'error') {
        throw new Error(
          `Tool name conflict: '${tool.name}' is already registered by '${this.toolSources.get(tool.name)}'`,
        );
      }
      if (
        this.conflictPolicy === 'prefer-builtin' &&
        this.toolSources.get(tool.name) === 'builtin'
      ) {
        return; // 保留内置
      }
      // prefer-last 直接覆盖
    }

    this.tools.set(tool.name, tool);
    this.toolSources.set(tool.name, source);
  }

  registerSource(source: string, tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool, { source });
    }
  }

  unregisterSource(source: string): void {
    for (const [name, s] of this.toolSources.entries()) {
      if (s === source) {
        this.tools.delete(name);
        this.toolSources.delete(name);
      }
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 未命中时抛 ToolNotFound，并携带当前全部可用名称辅助模型自纠。 */
  resolve(name: string): Tool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolNotFound(name, Array.from(this.tools.keys()));
    }
    return tool;
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  definitions(): ToolDefinition[] {
    return this.list().map(toToolDefinition);
  }
}
