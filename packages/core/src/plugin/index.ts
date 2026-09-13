import type { HookRegistry } from '../hooks/registry.js';
import type { ToolRegistry } from '../tools/registry.js';

export interface PluginContext {
  readonly tools: ToolRegistry;
  readonly hooks: HookRegistry;
  readonly rootDir: string;
  readonly logger?: (msg: string) => void;
}

export interface AgentPlugin {
  readonly name: string;
  readonly version?: string;
  setup(ctx: PluginContext): void | Promise<void>;
  teardown?(): void | Promise<void>;
}
