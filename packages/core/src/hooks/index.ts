import type { CanonicalMessage, ModelRequest } from '../types/index.js';

export type HookPoint =
  | 'session:start'
  | 'session:end'
  | 'model:before'
  | 'model:after'
  | 'tool:before'
  | 'tool:after'
  | 'error';

export interface HookContext {
  readonly signal?: AbortSignal;
  readonly logger?: (msg: string) => void;
}

export type ToolDecision =
  | { action: 'continue' }
  | { action: 'skip'; result: string; isError?: boolean }
  | { action: 'modify'; input: Record<string, unknown> };

export interface HookHandlers {
  'session:start'?: (ctx: HookContext) => void | Promise<void>;
  'session:end'?: (ctx: HookContext) => void | Promise<void>;
  'model:before'?: (ctx: HookContext, req: ModelRequest) => ModelRequest | Promise<ModelRequest>;
  'model:after'?: (ctx: HookContext, res: { message: CanonicalMessage }) => void | Promise<void>;
  'tool:before'?: (
    ctx: HookContext,
    call: { id: string; name: string; input: Record<string, unknown> },
  ) => ToolDecision | Promise<ToolDecision>;
  'tool:after'?: (
    ctx: HookContext,
    call: { id: string; name: string; input: Record<string, unknown> },
    result: { output: string; isError: boolean },
  ) => void | Promise<void>;
  error?: (ctx: HookContext, err: Error) => void | Promise<void>;
}
