import type { ToolRegistry } from '../../capabilities/tools/registry.js';
import type { HookRegistry } from '../hooks/registry.js';

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
