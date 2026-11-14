import path from 'node:path';
import {
  type ApprovalChannel,
  SessionApprovalCache,
} from '../../capabilities/security/approval.js';
import {
  type WorkspaceLeaseCoordinator,
  type WorkspaceWriteLease,
  isWriteOperation,
} from '../../capabilities/security/lease.js';
import {
  PermissionPolicy,
  type PermissionRule,
  type SessionMode,
  type ShellScope,
} from '../../capabilities/security/permissions.js';
import type { PathSandbox } from '../../capabilities/security/sandbox.js';
import type { ParentPolicySnapshot } from '../../capabilities/security/subagent-policy.js';
import type { Tool, ToolContext, ToolExecutionIdentity } from '../../capabilities/tools/index.js';
import type { ToolRegistry, ToolRegistrySnapshot } from '../../capabilities/tools/registry.js';
import { KapibalaError } from '../../errors/index.js';
import type { HookRegistry } from '../../extensibility/hooks/registry.js';
import { type EventLogger, createLogId } from '../../extensibility/logging/index.js';
import type { ToolResultBlock, ToolResultExecution, ToolUseBlock } from '../../types/index.js';
import { resolveToolApproval } from './approval.js';
import { closeToolResult } from './result.js';
import { withToolTimeout } from './timeout.js';
import { DEFAULT_TOOL_TIMEOUT_MS, type ExecutorOptions, type ToolHardDenial } from './types.js';

// 构造项与硬限制类型在 ./types.js 定义；此处在包根保持原导出面不变。
export type { ExecutorOptions, ToolHardDenial } from './types.js';

/**
 * 工具执行器：按「审计 → 钩子裁决 → 权限裁决 → 执行 → 结果闭合」处理单次调用。
 * 所有拒绝与异常都闭合为 isError 的工具结果，不向调用方抛出；
 * 同一 run 内参数完全相同的 never 失败会被拒绝重复执行。
 */
export class ToolExecutor {
  private readonly hardDenial?: ExecutorOptions['hardDenial'];
  private readonly onToolResult?: ExecutorOptions['onToolResult'];
  private readonly tools: ToolRegistry | ToolRegistrySnapshot;
  private readonly hooks: HookRegistry;
  private readonly workspaceRoot: string;
  private readonly executionCwd: string;
  private readonly sandbox?: PathSandbox;
  private readonly leaseCoordinator?: WorkspaceLeaseCoordinator;
  private readonly rootDir: string;
  private readonly signal?: AbortSignal;
  private readonly logger?: (msg: string) => void;
  private readonly toolTimeoutMs: number;
  private readonly eventLogger?: EventLogger;
  private readonly sessionId?: string;
  private readonly runId?: string;
  private readonly branchId?: string;
  private readonly rootTaskId?: string;
  private readonly depth?: number;
  private readonly agentId?: string;
  private readonly committedActions: Array<() => void | Promise<void>> = [];
  private readonly rollbackActions: Array<() => void | Promise<void>> = [];
  private readonly mode: SessionMode | (() => SessionMode);
  private readonly permissionRules: readonly PermissionRule[];
  private readonly approvalChannel?: ApprovalChannel;
  private readonly approvalCache: SessionApprovalCache;
  private readonly policy = new PermissionPolicy();
  private readonly neverFailures = new Set<string>();
  private readonly cancellation = new AbortController();

  constructor(options: ExecutorOptions) {
    this.hardDenial = options.hardDenial;
    this.onToolResult = options.onToolResult;
    this.tools = options.tools;
    this.hooks = options.hooks;
    this.workspaceRoot = options.workspaceRoot ?? options.rootDir;
    this.executionCwd = options.executionCwd ?? options.rootDir;
    this.sandbox = options.sandbox;
    this.leaseCoordinator = options.leaseCoordinator;
    this.rootDir = options.rootDir;
    this.signal = options.signal
      ? AbortSignal.any([options.signal, this.cancellation.signal])
      : this.cancellation.signal;
    this.logger = options.logger;
    this.toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.eventLogger = options.eventLogger;
    this.sessionId = options.sessionId;
    this.runId = options.runId;
    this.branchId = options.branchId;
    this.rootTaskId = options.rootTaskId;
    this.depth = options.depth;
    this.agentId = options.agentId;
    this.mode = options.mode ?? 'Approval';
    this.permissionRules = options.permissionRules ?? [];
    this.approvalChannel = options.approvalChannel;
    this.approvalCache = options.approvalCache ?? new SessionApprovalCache();
  }

  /**
   * 父工具事务提交成功后调用，按注册顺序执行所有提交动作。
   * 动作执行成功后逐项清理对应回滚动作，若某项失败保留剩余回滚动作。
   */
  async commit(): Promise<void> {
    while (this.committedActions.length > 0) {
      const action = this.committedActions.shift()!;
      await action();
      this.rollbackActions.shift();
    }
    this.rollbackActions.length = 0;
  }

  /**
   * 父工具事务提交失败或取消时调用，按逆序执行所有回滚清理动作。
   */
  async rollback(): Promise<void> {
    const actions = [...this.rollbackActions].reverse();
    this.committedActions.length = 0;
    this.rollbackActions.length = 0;
    for (const action of actions) {
      try {
        await action();
      } catch {
        /* 忽略回滚错误 */
      }
    }
  }

  /** 中止本轮正在等待或执行的工具；调用方仍须等待 runAll 完成资源回收及结果审计。 */
  cancel(): void {
    this.cancellation.abort();
  }

  /**
   * 串行执行全部调用并返回与入参顺序一致的结果；某个结果要求用户介入后，其余调用直接拒绝。
   * onResult 在每个最终结果（含拒绝/失败）产生后提供独立快照，供在途预算估算，不代表历史已提交；回调不得抛错。
   */
  async runAll(
    calls: ToolUseBlock[],
    onProgress?: (event: {
      id: string;
      name: string;
      elapsedMs: number;
      outputBytes: number;
    }) => void,
    onResult?: (result: ToolResultBlock) => void,
  ): Promise<ToolResultBlock[]> {
    const results: ToolResultBlock[] = [];
    let requiresUserAction = false;
    for (const call of calls) {
      const result = await this.executeOne(call, onProgress, requiresUserAction);
      results.push(result);
      onResult?.(structuredClone(result));
      if (result.retryPolicy === 'after_user_action') requiresUserAction = true;
    }
    return results;
  }

  /**
   * 在最终参数上裁决并审计一次调用，所有拒绝和异常均闭合为工具结果。
   * 为调用记录本次绝对工具根目录，供跨目录恢复后的文件事实解析；不使用历史目录授权。
   */
  async executeOne(
    call: ToolUseBlock,
    onProgress?: (event: {
      id: string;
      name: string;
      elapsedMs: number;
      outputBytes: number;
    }) => void,
    forcedDeny = false,
  ): Promise<ToolResultBlock> {
    call.executionRoot = path.resolve(this.workspaceRoot);
    const startedAt = Date.now();
    const operationId = createLogId();
    const failure = (
      message: string,
      errorCode: string,
      retryPolicy: ToolResultBlock['retryPolicy'] = 'never',
      execution?: ToolResultExecution,
    ): ToolResultBlock => ({
      type: 'tool_result',
      toolUseId: call.id,
      content: JSON.stringify({ code: errorCode, retryPolicy, message }),
      isError: true,
      errorCode,
      retryPolicy,
      durationMs: Math.max(0, Date.now() - startedAt),
      execution: execution ?? {
        version: 1,
        dispatchOutcome: 'not_sent',
      },
    });
    const audit = async (event: string, fields: Record<string, unknown> = {}): Promise<void> => {
      if (!this.eventLogger || !this.sessionId) return;
      await this.eventLogger.recordAudit({
        level: 'info',
        event,
        sessionId: this.sessionId,
        runId: this.runId,
        operationId,
        toolUseId: call.id,
        fields: { toolName: call.name, ...fields },
      });
    };
    try {
      await audit('tool.requested', { status: 'requested', processId: process.pid });
    } catch {
      return failure(
        'Audit unavailable; tool was not started',
        'AUDIT_UNAVAILABLE',
        'after_user_action',
        {
          version: 1,
          dispatchOutcome: 'not_sent',
          hostError: { phase: 'audit', code: 'AUDIT_UNAVAILABLE' },
        },
      );
    }

    if (forcedDeny) {
      try {
        await audit('tool.decided', { decision: 'deny', decisionSource: 'prior_user_action' });
        await audit('tool.finished', { status: 'skipped', errorCode: 'SKIPPED_AFTER_USER_ACTION' });
      } catch {
        return failure(
          'Audit unavailable; tool was not started',
          'AUDIT_UNAVAILABLE',
          'after_user_action',
          {
            version: 1,
            dispatchOutcome: 'not_sent',
            hostError: { phase: 'audit', code: 'AUDIT_UNAVAILABLE' },
          },
        );
      }
      return failure(
        'Earlier tool call requires user action',
        'SKIPPED_AFTER_USER_ACTION',
        'after_user_action',
      );
    }

    const hookCtx = { signal: this.signal, logger: this.logger };
    let currentInput = call.input;
    try {
      for (const hook of this.hooks.get('tool:before')) {
        const decision = await hook(hookCtx, { id: call.id, name: call.name, input: currentInput });
        if (decision.action === 'modify') currentInput = decision.input;
        if (decision.action === 'skip') {
          await audit('tool.decided', { decision: 'deny', decisionSource: 'hook' });
          await audit('tool.finished', { status: 'skipped' });
          return {
            type: 'tool_result',
            toolUseId: call.id,
            content: decision.result,
            isError: decision.isError ?? false,
            durationMs: Math.max(0, Date.now() - startedAt),
            execution: {
              version: 1,
              dispatchOutcome: 'not_sent',
            },
          };
        }
      }
    } catch {
      try {
        await audit('tool.decided', { decision: 'deny', decisionSource: 'hook' });
        await audit('tool.finished', { status: 'failed' });
      } catch {
        /* Execution has not begun. */
      }
      return failure('Tool preparation failed', 'HOOK_ERROR', 'never', {
        version: 1,
        dispatchOutcome: 'not_sent',
        hostError: { phase: 'hook', code: 'HOOK_ERROR' },
      });
    }

    /** 深度冻结对象及其嵌套属性，防御执行期间外部或插件篡改。 */
    function deepFreeze<T>(obj: T): T {
      if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) {
        return obj;
      }
      Object.freeze(obj);
      for (const key of Object.keys(obj as Record<string, unknown>)) {
        deepFreeze((obj as Record<string, unknown>)[key]);
      }
      return obj;
    }

    const finalInput: Record<string, unknown> = deepFreeze(structuredClone(currentInput));

    let tool: Tool;
    try {
      tool = this.tools.resolve(call.name);
    } catch (error: unknown) {
      const known = error instanceof KapibalaError ? error : undefined;
      try {
        await audit('tool.decided', { decision: 'deny', decisionSource: 'unavailable' });
        await audit('tool.finished', { status: 'failed' });
      } catch {
        /* Execution has not begun. */
      }
      return failure(
        known?.safeMessage ?? 'Requested tool is unavailable',
        known?.code ?? 'TOOL_NOT_FOUND',
        'never',
        {
          version: 1,
          dispatchOutcome: 'not_sent',
        },
      );
    }

    try {
      const validation = tool.validateInput?.(finalInput);
      if (validation && !validation.valid) {
        try {
          await audit('tool.decided', { decision: 'deny', decisionSource: 'validation' });
          await audit('tool.finished', { status: 'failed', errorCode: 'INVALID_INPUT' });
        } catch {
          /* Execution has not begun. */
        }
        return failure(
          validation.message || 'Tool input validation failed',
          'INVALID_INPUT',
          'never',
          {
            version: 1,
            dispatchOutcome: 'not_sent',
            hostError: { phase: 'validation', code: 'INVALID_INPUT' },
          },
        );
      }
    } catch (err: unknown) {
      try {
        await audit('tool.decided', { decision: 'deny', decisionSource: 'validation' });
        await audit('tool.finished', { status: 'failed', errorCode: 'INVALID_INPUT' });
      } catch {
        /* Execution has not begun. */
      }
      const msg = err instanceof Error ? err.message : 'Tool input validation error';
      return failure(msg || 'Tool input validation error', 'INVALID_INPUT', 'never', {
        version: 1,
        dispatchOutcome: 'not_sent',
        hostError: { phase: 'validation', code: 'INVALID_INPUT' },
      });
    }

    try {
      return await this.executeResolved(
        call,
        finalInput,
        tool,
        startedAt,
        audit,
        failure,
        hookCtx,
        onProgress,
      );
    } catch {
      try {
        await audit('tool.finished', { status: 'unknown', errorCode: 'OUTCOME_UNKNOWN' });
      } catch {
        /* Preserve the conservative unknown result. */
      }
      return failure(
        'Tool outcome is unknown after an executor failure',
        'OUTCOME_UNKNOWN',
        'after_user_action',
        {
          version: 1,
          dispatchOutcome: 'unknown',
        },
      );
    }
  }

  private async executeResolved(
    call: ToolUseBlock,
    finalInput: Record<string, unknown>,
    tool: Tool,
    startedAt: number,
    audit: (event: string, fields?: Record<string, unknown>) => Promise<void>,
    failure: (
      content: string,
      errorCode: string,
      retryPolicy?: ToolResultBlock['retryPolicy'],
      execution?: ToolResultExecution,
    ) => ToolResultBlock,
    hookCtx: { signal?: AbortSignal; logger?: (msg: string) => void },
    onProgress?: (event: {
      id: string;
      name: string;
      elapsedMs: number;
      outputBytes: number;
    }) => void,
  ): Promise<ToolResultBlock> {
    let shell: ReturnType<NonNullable<typeof tool.approvalScope>> | undefined;
    try {
      shell = tool.approvalScope?.(finalInput, this.rootDir, this.executionCwd);
    } catch {
      try {
        await audit('tool.decided', { decision: 'deny', decisionSource: 'invalid_target' });
        await audit('tool.finished', { status: 'failed', errorCode: 'INVALID_TARGET' });
      } catch {
        /* Execution has not begun. */
      }
      return failure('Invalid tool execution target', 'INVALID_TARGET');
    }
    let executionIdentity: ToolExecutionIdentity | undefined;
    try {
      executionIdentity = tool.executionIdentity?.(finalInput, this.rootDir);
    } catch {
      try {
        await audit('tool.decided', { decision: 'deny', decisionSource: 'invalid_identity' });
        await audit('tool.finished', { status: 'failed', errorCode: 'INVALID_TARGET' });
      } catch {
        /* Execution has not begun. */
      }
      return failure('Invalid tool execution identity', 'INVALID_TARGET');
    }
    const approval = await resolveToolApproval({
      call,
      finalInput,
      tool,
      shell,
      executionIdentity,
      rootDir: this.rootDir,
      executionCwd: this.executionCwd,
      mode: this.mode,
      permissionRules: this.permissionRules,
      approvalChannel: this.approvalChannel,
      approvalCache: this.approvalCache,
      hardDenial: this.hardDenial,
      neverFailures: this.neverFailures,
      policy: this.policy,
      signal: this.signal,
      audit,
      failure,
    });
    if (approval.result) return approval.result;
    shell = approval.shell;
    const auditFields = approval.auditFields ?? {};
    try {
      await audit('tool.started', { status: 'started', ...auditFields });
    } catch {
      return failure(
        'Audit unavailable; tool was not started',
        'AUDIT_UNAVAILABLE',
        'after_user_action',
        {
          version: 1,
          dispatchOutcome: 'not_sent',
          hostError: { phase: 'audit', code: 'AUDIT_UNAVAILABLE' },
        },
      );
    }

    let outputStr: string;
    let isError = false;
    let errorCode: string | undefined;
    let retryPolicy: ToolResultBlock['retryPolicy'];
    let execution: ToolResultExecution | undefined;
    try {
      const executionController = new AbortController();
      const abortFromSession = () => executionController.abort();
      if (this.signal?.aborted) {
        executionController.abort();
      } else {
        this.signal?.addEventListener('abort', abortFromSession, { once: true });
      }
      const toolCtx: ToolContext = {
        leaseCoordinator: this.leaseCoordinator,
        workspaceRoot: this.workspaceRoot,
        executionCwd: this.executionCwd,
        sandbox: this.sandbox,
        rootDir: this.rootDir,
        signal: executionController.signal,
        logger: this.logger,
        sessionId: this.sessionId,
        runId: this.runId,
        branchId: this.branchId,
        toolCallId: call.id,
        rootTaskId: this.rootTaskId,
        depth: this.depth,
        agentId: this.agentId,
        parentPolicy: this.deriveParentPolicySnapshot(),
        onCommitted: (action) => this.committedActions.push(action),
        onRollback: (action) => this.rollbackActions.push(action),
        onProgress: (progress) => onProgress?.({ id: call.id, name: call.name, ...progress }),
        ...(shell
          ? {
              onProcessSpawned: () =>
                audit('process.spawned', { status: 'spawned', ...auditFields }),
            }
          : {}),
      };

      let lease: WorkspaceWriteLease | undefined;
      try {
        if (this.leaseCoordinator && isWriteOperation(tool)) {
          lease = await this.leaseCoordinator.acquire(
            this.workspaceRoot,
            this.sessionId ?? 'anonymous',
            { signal: executionController.signal },
          );
        }

        const rawResult = tool.metadata?.managesTimeout
          ? await tool.execute(finalInput, toolCtx)
          : await withToolTimeout(
              tool.execute(finalInput, toolCtx),
              call.name,
              this.toolTimeoutMs,
              executionController,
            );
        if (typeof tool.toExecutionResult === 'function') {
          try {
            const converted = tool.toExecutionResult(rawResult);
            outputStr = converted.content;
            isError = converted.isError ?? false;
            errorCode = converted.errorCode;
            retryPolicy = converted.retryPolicy;
            execution = converted.execution ?? {
              version: 1,
              dispatchOutcome: isError ? 'failed' : 'succeeded',
            };
          } catch (convErr: unknown) {
            isError = true;
            errorCode = 'MCP_RESULT_INVALID';
            retryPolicy = 'after_user_action';
            outputStr =
              convErr instanceof Error ? convErr.message : 'Tool result projection failed';
            execution = {
              version: 1,
              dispatchOutcome: 'succeeded',
              hostError: {
                phase: 'projection',
                code: 'MCP_RESULT_INVALID',
              },
            };
          }
        } else {
          outputStr =
            typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult, null, 2);
          if (
            call.name === 'run_command' &&
            typeof rawResult === 'object' &&
            rawResult !== null &&
            'exitCode' in rawResult &&
            rawResult.exitCode !== 0
          ) {
            isError = true;
            errorCode = 'COMMAND_EXIT_NONZERO';
            retryPolicy = 'never';
            execution = {
              version: 1,
              dispatchOutcome: 'failed',
            };
          } else {
            execution = {
              version: 1,
              dispatchOutcome: 'succeeded',
            };
          }
        }
      } finally {
        this.signal?.removeEventListener('abort', abortFromSession);
        lease?.release();
      }
    } catch (err: unknown) {
      isError = true;
      const known = err instanceof KapibalaError ? err : undefined;
      outputStr = known?.safeMessage ?? 'Tool execution failed';
      errorCode = known?.code ?? 'TOOL_FAILED';
      retryPolicy = known?.retryPolicy ?? 'never';
      const outcome =
        known?.dispatchOutcome ??
        (errorCode === 'OUTCOME_UNKNOWN' || (known && known.retryPolicy === 'after_user_action')
          ? 'unknown'
          : 'failed');
      execution = {
        version: 1,
        dispatchOutcome: outcome,
      };
    }

    return closeToolResult({
      call,
      tool,
      finalInput,
      hookCtx,
      hooks: this.hooks,
      neverFailures: this.neverFailures,
      audit,
      onToolResult: this.onToolResult,
      startedAt,
      output: { content: outputStr, isError, errorCode, retryPolicy, execution },
    });
  }

  /**
   * 构建当前会话在派生时刻的父权限策略快照。
   */
  private deriveParentPolicySnapshot(): ParentPolicySnapshot {
    const currentMode = typeof this.mode === 'function' ? this.mode() : this.mode;
    return {
      mode: currentMode,
      rules: this.permissionRules,
      availableTools: this.tools.list(),
      workspaceRoot: this.workspaceRoot,
      executionCwd: this.executionCwd,
      currentDepth: this.depth ?? 0,
    };
  }
}
