import type { CanonicalMessage, ModelRequest } from '../../types/index.js';

/**
 * 运行时钩子契约：宿主与插件在固定切点观察或调整流程。
 * 通知型切点由 HookRegistry.emit 串行触发；需要返回值的 model:before / tool:before
 * 由执行方（AgentLoop / ToolExecutor）自行遍历并消费返回值。
 */

/** 钩子切点；session:start / session:end 由会话初始化与销毁触发，其余在单次交互流程内触发。 */
export type HookPoint =
  | 'session:start'
  | 'session:end'
  | 'model:before'
  | 'model:after'
  | 'tool:before'
  | 'tool:after'
  | 'error';

/** 传给每个钩子的运行上下文；signal 与当前执行的取消联动，未提供表示该切点不可取消。 */
export interface HookContext {
  readonly signal?: AbortSignal;
  readonly logger?: (msg: string) => void;
}

/**
 * tool:before 的裁决结果：continue 放行；skip 不执行工具，以 result 作为工具结果落盘；
 * modify 用替换后的入参继续（仍会经过后续权限裁决，不构成绕过审批的通道）。
 */
export type ToolDecision =
  | { action: 'continue' }
  | { action: 'skip'; result: string; isError?: boolean }
  | { action: 'modify'; input: Record<string, unknown> };

/** 各切点的处理器签名；未注册的切点直接跳过，处理器抛出的异常向上传播。 */
export interface HookHandlers {
  'session:start'?: (ctx: HookContext) => void | Promise<void>;
  'session:end'?: (ctx: HookContext) => void | Promise<void>;
  'model:before'?: (ctx: HookContext, req: ModelRequest) => ModelRequest | Promise<ModelRequest>;
  /** 收到的是即将进入历史的完整 assistant 消息；执行方会校验钩子未改动身份与受保护内容。 */
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
