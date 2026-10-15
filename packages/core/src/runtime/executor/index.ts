import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  type ApprovalChannel,
  type ApprovalRequest,
  SessionApprovalCache,
  stableJsonStringify,
} from '../../capabilities/security/approval.js';
import {
  PermissionPolicy,
  type PermissionRule,
  type SessionMode,
} from '../../capabilities/security/permissions.js';
import type { Tool, ToolContext, ToolExecutionIdentity } from '../../capabilities/tools/index.js';
import type { ToolRegistry, ToolRegistrySnapshot } from '../../capabilities/tools/registry.js';
import { KapibalaError } from '../../errors/index.js';
import type { HookRegistry } from '../../extensibility/hooks/registry.js';
import {
  type EventLogger,
  commandAuditSummary,
  createLogId,
} from '../../extensibility/logging/index.js';
import type { ToolResultBlock, ToolResultExecution, ToolUseBlock } from '../../types/index.js';

/** ToolExecutor 的构造项；审计写入需要 eventLogger 与 sessionId 同时提供，否则不产生审计。 */
/** 宿主运行级硬限制；优先于模式、审批及缓存，文案和字段不得携带凭据。 */
export interface ToolHardDenial {
  code: string;
  message: string;
  retryPolicy: ToolResultBlock['retryPolicy'];
  fields?: Record<string, unknown>;
}

export interface ExecutorOptions {
  /** 在最终参数上补充硬拒绝，不能把拒绝转为授权。 */
  hardDenial?: (tool: Tool, input: Record<string, unknown>) => ToolHardDenial | undefined;
  /** 结果钩子和执行审计完成后调用；用于在同批次下一调用前安装宿主收紧状态。 */
  onToolResult?: (
    tool: Tool,
    input: Record<string, unknown>,
    result: ToolResultBlock,
  ) => void | Promise<void>;
  tools: ToolRegistry | ToolRegistrySnapshot;
  hooks: HookRegistry;
  /** 工具执行的绝对根目录；路径解析与审批均以此为基准。 */
  rootDir: string;
  /** 会话级取消信号；与 cancel() 的内部信号合并生效。 */
  signal?: AbortSignal;
  logger?: (msg: string) => void;
  /** 单次工具执行超时(毫秒)。异步挂起的工具超时后返回 isError 结果，避免永久卡死会话循环 */
  toolTimeoutMs?: number;
  eventLogger?: EventLogger;
  sessionId?: string;
  runId?: string;
  /** 固定模式或每次裁决时读取的取值函数；宿主可中途切换。 */
  mode?: SessionMode | (() => SessionMode);
  permissionRules?: readonly PermissionRule[];
  /** 审批入口；缺省视为非交互环境，需要询问的调用一律拒绝。 */
  approvalChannel?: ApprovalChannel;
  /** 会话内 allow_session / deny_session 审批缓存；缺省使用实例私有缓存。 */
  approvalCache?: SessionApprovalCache;
}

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

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
  private readonly rootDir: string;
  private readonly signal?: AbortSignal;
  private readonly logger?: (msg: string) => void;
  private readonly toolTimeoutMs: number;
  private readonly eventLogger?: EventLogger;
  private readonly sessionId?: string;
  private readonly runId?: string;
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
    this.rootDir = options.rootDir;
    this.signal = options.signal
      ? AbortSignal.any([options.signal, this.cancellation.signal])
      : this.cancellation.signal;
    this.logger = options.logger;
    this.toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.eventLogger = options.eventLogger;
    this.sessionId = options.sessionId;
    this.runId = options.runId;
    this.mode = options.mode ?? 'Approval';
    this.permissionRules = options.permissionRules ?? [];
    this.approvalChannel = options.approvalChannel;
    this.approvalCache = options.approvalCache ?? new SessionApprovalCache();
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
    call.executionRoot = path.resolve(this.rootDir);
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
      shell = tool.approvalScope?.(finalInput, this.rootDir);
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
    let auditFields: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 2; attempt++) {
      const request: ApprovalRequest = {
        toolName: call.name,
        capabilities: tool.metadata?.permissions ?? [],
        input: finalInput,
        rootDir: this.rootDir,
        ...(shell ? { shell } : {}),
        ...(executionIdentity ? { executionIdentity } : {}),
        // 解释器内建查询与内容已绑定摘要的工作区直引脚本可确认不受外部脚本变更影响，
        // 允许会话级批准；其余 shell 命令仅允许单次批准。
        // 非 shell 工具（含深度绑定 executionIdentity 的外部工具）允许会话级批准。
        sessionAllowed:
          !shell ||
          /^(?:pwd|get-location)$/i.test(shell.command.trim()) ||
          shell.scriptDigest !== undefined,
      };
      const repeatKey = createHash('sha256')
        .update(stableJsonStringify([call.name, finalInput]))
        .digest('hex');
      if (this.neverFailures.has(repeatKey)) {
        try {
          await audit('tool.decided', { decision: 'deny', decisionSource: 'repeat_block' });
          await audit('tool.finished', { status: 'blocked', errorCode: 'REPEAT_BLOCKED' });
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
          'Identical failed tool call cannot be repeated in this run',
          'REPEAT_BLOCKED',
        );
      }
      const hardDenied = this.hardDenial?.(tool, finalInput);
      const cached = this.approvalCache.get(request);
      const decision = this.policy.decide({
        hardDenied: hardDenied !== undefined,
        mode: typeof this.mode === 'function' ? this.mode() : this.mode,
        toolName: call.name,
        capabilities: request.capabilities,
        dangerous: tool.metadata?.dangerous,
        cachedApproval: cached === 'allow',
        cachedDenial: cached === 'deny',
        rules: this.permissionRules,
        ...(shell ? { shell } : {}),
      });
      let permitted = decision.decision === 'allow';
      let source: string = decision.source;
      let approvalChoice: Awaited<ReturnType<ApprovalChannel['requestApproval']>> | undefined;
      if (decision.decision === 'ask') {
        let choice: Awaited<ReturnType<ApprovalChannel['requestApproval']>> = 'deny_once';
        try {
          choice =
            (await this.approvalChannel?.requestApproval(request, this.signal)) ?? 'deny_once';
        } catch {
          choice = 'cancel';
        }
        approvalChoice = choice;
        if (choice === 'allow_session' && request.sessionAllowed)
          this.approvalCache.set(request, 'allow');
        if (choice === 'deny_session') this.approvalCache.set(request, 'deny');
        permitted =
          choice === 'allow_once' || (choice === 'allow_session' && request.sessionAllowed);
        source = this.approvalChannel ? 'human' : 'non_interactive';
      }
      auditFields = shell
        ? {
            shell: shell.interpreter,
            cwdDigest: createHash('sha256').update(shell.cwd).digest('hex'),
            executableDigest: shell.executableDigest,
            executionFingerprint: shell.executionFingerprint,
            ...commandAuditSummary(shell.command),
          }
        : executionIdentity
          ? {
              serverIdentity: executionIdentity.serverIdentity,
              connectionGeneration: executionIdentity.connectionGeneration,
              catalogEpoch: executionIdentity.catalogEpoch,
              toolDigest: executionIdentity.toolDigest,
            }
          : {};
      try {
        await audit('tool.decided', {
          decision: permitted ? 'allow' : 'deny',
          decisionSource: source,
          ...(approvalChoice ? { approvalChoice } : {}),
          ...(hardDenied?.fields ?? {}),
          ...auditFields,
        });
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
      if (!permitted || this.signal?.aborted) {
        const code = this.signal?.aborted ? 'ABORTED' : (hardDenied?.code ?? 'PERMISSION_DENIED');
        try {
          await audit('tool.finished', { status: 'denied', errorCode: code });
        } catch {
          return failure('Audit result unavailable', 'AUDIT_UNAVAILABLE', 'after_user_action', {
            version: 1,
            dispatchOutcome: 'not_sent',
            hostError: { phase: 'audit', code: 'AUDIT_UNAVAILABLE' },
          });
        }
        return failure(
          this.signal?.aborted
            ? 'Operation cancelled'
            : (hardDenied?.message ?? 'Tool permission denied'),
          code,
          this.signal?.aborted
            ? 'after_user_action'
            : (hardDenied?.retryPolicy ?? 'after_user_action'),
        );
      }
      if (shell) {
        try {
          const next = tool.approvalScope?.(finalInput, this.rootDir);
          if (next?.executionFingerprint !== shell.executionFingerprint) {
            if (attempt === 0 && next) {
              try {
                await audit('tool.target_changed', { status: 'redeciding' });
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
              shell = next;
              continue;
            }
            await audit('tool.finished', { status: 'target_changed', errorCode: 'TARGET_CHANGED' });
            return failure(
              'Execution target changed after approval',
              'TARGET_CHANGED',
              'after_user_action',
            );
          }
        } catch {
          return failure(
            'Execution target changed after approval',
            'TARGET_CHANGED',
            'after_user_action',
          );
        }
      }
      if (executionIdentity) {
        try {
          const nextIdentity = tool.executionIdentity?.(finalInput, this.rootDir);
          if (
            !nextIdentity ||
            nextIdentity.serverIdentity !== executionIdentity.serverIdentity ||
            nextIdentity.connectionGeneration !== executionIdentity.connectionGeneration ||
            nextIdentity.catalogEpoch !== executionIdentity.catalogEpoch ||
            nextIdentity.toolDigest !== executionIdentity.toolDigest
          ) {
            await audit('tool.finished', {
              status: 'identity_changed',
              errorCode: 'MCP_TOOL_CHANGED',
            });
            return failure(
              'Tool execution identity changed after approval',
              'MCP_TOOL_CHANGED',
              'after_user_action',
              {
                version: 1,
                dispatchOutcome: 'not_sent',
                hostError: { phase: 'validation', code: 'MCP_TOOL_CHANGED' },
              },
            );
          }
        } catch {
          return failure(
            'Tool execution identity check failed after approval',
            'MCP_TOOL_CHANGED',
            'after_user_action',
            {
              version: 1,
              dispatchOutcome: 'not_sent',
            },
          );
        }
      }
      break;
    }
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
        rootDir: this.rootDir,
        signal: executionController.signal,
        logger: this.logger,
        onProgress: (progress) => onProgress?.({ id: call.id, name: call.name, ...progress }),
        ...(shell
          ? {
              onProcessSpawned: () =>
                audit('process.spawned', { status: 'spawned', ...auditFields }),
            }
          : {}),
      };

      try {
        const rawResult = tool.metadata?.managesTimeout
          ? await tool.execute(finalInput, toolCtx)
          : await this.withTimeout(
              tool.execute(finalInput, toolCtx),
              call.name,
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

    const resultBlock: ToolResultBlock = {
      type: 'tool_result',
      toolUseId: call.id,
      content: outputStr,
      isError,
      ...(errorCode ? { errorCode, retryPolicy } : {}),
      execution,
    };
    if (resultBlock.isError && resultBlock.errorCode) {
      resultBlock.content = JSON.stringify({
        code: resultBlock.errorCode,
        retryPolicy: resultBlock.retryPolicy,
        message: outputStr,
      });
    }

    // 触发 tool:after hooks
    try {
      for (const hook of this.hooks.get('tool:after')) {
        await hook(
          hookCtx,
          { id: call.id, name: call.name, input: finalInput },
          { output: outputStr, isError },
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
      this.neverFailures.add(
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

    await this.onToolResult?.(tool, finalInput, resultBlock);
    return resultBlock;
  }

  /**
   * 给工具执行加超时护栏：Promise.race 在超时后reject，循环拿到 isError 结果继续运转，
   * 不会因某个异步工具(如未来接入的网络/exec 工具)挂起而永久卡死。
   *
   * 局限：同步 CPU 密集型实现会阻塞事件循环，timer 同样无法触发；
   * 因此内置工具仍需避免执行用户可控的同步高复杂度计算。
   */
  private withTimeout<T>(
    promise: Promise<T>,
    toolName: string,
    executionController: AbortController,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new KapibalaError(
          `Tool '${toolName}' timed out after ${this.toolTimeoutMs}ms`,
          {
            code: 'OUTCOME_UNKNOWN',
            retryPolicy: 'after_user_action',
            safeMessage: 'Tool timed out; completion of side effects is unknown',
          },
        );
        reject(error);
        executionController.abort(error);
      }, this.toolTimeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}
