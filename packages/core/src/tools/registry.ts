import { ToolNotFound } from '../errors/index.js';
import type { Tool, ToolDefinition } from './index.js';
import { toToolDefinition } from './index.js';

export type ConflictPolicy = 'error' | 'prefer-builtin' | 'prefer-last';

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
