import { createHash } from 'node:crypto';
import { stableJsonStringify } from '../../capabilities/security/approval.js';
import type { Tool } from '../../capabilities/tools/index.js';
import type { HookRegistry } from '../../extensibility/hooks/registry.js';
import type { ToolResultBlock, ToolResultExecution, ToolUseBlock } from '../../types/index.js';

/** 结果闭合的依赖集合；执行产物与审计/钩子依赖由执行器显式注入。 */
export interface ToolResultCloseDeps {
  call: ToolUseBlock;
  tool: Tool;
  finalInput: Record<string, unknown>;
  hookCtx: { signal?: AbortSignal; logger?: (msg: string) => void };
  hooks: HookRegistry;
  /** 本 run 内已出现的 never 失败指纹集合；同参数 never 失败记录进去防止重复执行。 */
  neverFailures: Set<string>;
  audit: (event: string, fields?: Record<string, unknown>) => Promise<void>;
  onToolResult?: (
    tool: Tool,
    input: Record<string, unknown>,
    result: ToolResultBlock,
  ) => void | Promise<void>;
  startedAt: number;
  /** 工具执行原始产物；闭合函数据此构造最终 ToolResultBlock。 */
  output: {
    content: string;
    isError: boolean;
    errorCode?: string;
    retryPolicy?: ToolResultBlock['retryPolicy'];
    execution?: ToolResultExecution;
  };
}

/**
 * 执行产物闭合为最终 ToolResultBlock：错误内容重包装 → tool:after 钩子 →
 * 计时与 never 失败指纹 → 完成审计 → onToolResult 回调。
 *
 * 保证与边界：
 * - tool:after 钩子失败不丢弃真实输出，而是把结果改写为 HOOK_ERROR（after_user_action）；
 * - 完成审计失败时改写为 OUTCOME_UNKNOWN（审计不可用视为结果不可信）；
 * - never 失败以（工具名 + 最终输入）的稳定序列化指纹记录，同 run 内同参数重放会被拒绝；
 * - onToolResult 在审计完成后调用，回调异常向上传播（宿主收紧状态失败必须可见）。
 */
export async function closeToolResult(deps: ToolResultCloseDeps): Promise<ToolResultBlock> {
  const { call, tool, finalInput, hookCtx, hooks, neverFailures, audit, onToolResult, startedAt } =
    deps;
  const resultBlock: ToolResultBlock = {
    type: 'tool_result',
    toolUseId: call.id,
    content: deps.output.content,
    isError: deps.output.isError,
    ...(deps.output.errorCode
      ? { errorCode: deps.output.errorCode, retryPolicy: deps.output.retryPolicy }
      : {}),
    execution: deps.output.execution,
  };
  if (resultBlock.isError && resultBlock.errorCode) {
    resultBlock.content = JSON.stringify({
      code: resultBlock.errorCode,
      retryPolicy: resultBlock.retryPolicy,
      message: deps.output.content,
    });
  }

  // 触发 tool:after hooks
  try {
    for (const hook of hooks.get('tool:after')) {
      await hook(
        hookCtx,
        { id: call.id, name: call.name, input: finalInput },
        { output: deps.output.content, isError: deps.output.isError },
      );
    }
  } catch {
    resultBlock.content = JSON.stringify({
      code: 'HOOK_ERROR',
      retryPolicy: 'after_user_action',
      message: 'Tool finished but result processing failed',
    });
    resultBlock.isError = true;
    resultBlock.errorCode = 'HOOK_ERROR';
    resultBlock.retryPolicy = 'after_user_action';
    resultBlock.execution = {
      version: 1,
      dispatchOutcome: resultBlock.execution?.dispatchOutcome ?? 'failed',
      hostError: {
        phase: 'hook',
        code: 'HOOK_ERROR',
      },
    };
  }

  resultBlock.durationMs = Math.max(0, Date.now() - startedAt);
  if (resultBlock.isError && resultBlock.retryPolicy === 'never') {
    neverFailures.add(
      createHash('sha256')
        .update(stableJsonStringify([call.name, finalInput]))
        .digest('hex'),
    );
  }

  try {
    await audit('tool.finished', {
      status: resultBlock.isError ? 'failed' : 'completed',
      ...(resultBlock.errorCode ? { errorCode: resultBlock.errorCode } : {}),
      durationMs: resultBlock.durationMs,
    });
  } catch {
    resultBlock.isError = true;
    resultBlock.errorCode = 'OUTCOME_UNKNOWN';
    resultBlock.retryPolicy = 'after_user_action';
    resultBlock.content = JSON.stringify({
      code: 'OUTCOME_UNKNOWN',
      retryPolicy: 'after_user_action',
      message: 'Tool outcome is unknown because the audit result could not be written',
    });
    resultBlock.execution = {
      version: 1,
      dispatchOutcome: resultBlock.execution?.dispatchOutcome ?? 'succeeded',
      hostError: {
        phase: 'audit',
        code: 'AUDIT_UNAVAILABLE',
      },
    };
    return resultBlock;
  }

  await onToolResult?.(tool, finalInput, resultBlock);
  return resultBlock;
}
