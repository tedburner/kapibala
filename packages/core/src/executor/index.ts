import { createHash } from 'node:crypto';
import { KapibalaError } from '../errors/index.js';
import type { HookRegistry } from '../hooks/registry.js';
import { type EventLogger, commandAuditSummary, createLogId } from '../logging/index.js';
import {
  type ApprovalChannel,
  type ApprovalRequest,
  SessionApprovalCache,
  stableJsonStringify,
} from '../security/approval.js';
import {
  PermissionPolicy,
  type PermissionRule,
  type SessionMode,
} from '../security/permissions.js';
import type { ToolContext } from '../tools/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResultBlock, ToolUseBlock } from '../types/index.js';

export interface ExecutorOptions {
  tools: ToolRegistry;
  hooks: HookRegistry;
  rootDir: string;
  signal?: AbortSignal;
  logger?: (msg: string) => void;
  /** 单次工具执行超时(毫秒)。异步挂起的工具超时后返回 isError 结果，避免永久卡死会话循环 */
  toolTimeoutMs?: number;
  eventLogger?: EventLogger;
  sessionId?: string;
  runId?: string;
  mode?: SessionMode | (() => SessionMode);
  permissionRules?: readonly PermissionRule[];
  approvalChannel?: ApprovalChannel;
  approvalCache?: SessionApprovalCache;
}

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

export class ToolExecutor {
  private readonly tools: ToolRegistry;
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

  async runAll(
    calls: ToolUseBlock[],
    onProgress?: (event: {
      id: string;
      name: string;
      elapsedMs: number;
      outputBytes: number;
    }) => void,
  ): Promise<ToolResultBlock[]> {
    const results: ToolResultBlock[] = [];
    let requiresUserAction = false;
    for (const call of calls) {
      const result = await this.executeOne(call, onProgress, requiresUserAction);
      results.push(result);
      if (result.retryPolicy === 'after_user_action') requiresUserAction = true;
    }
    return results;
  }

  /** 在最终参数上裁决并审计一次调用，所有拒绝和异常均闭合为工具结果。 */
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
    const startedAt = Date.now();
    const operationId = createLogId();
    const failure = (
      message: string,
      errorCode: string,
      retryPolicy: ToolResultBlock['retryPolicy'] = 'never',
    ): ToolResultBlock => ({
      type: 'tool_result',
      toolUseId: call.id,
      content: JSON.stringify({ code: errorCode, retryPolicy, message }),
      isError: true,
      errorCode,
      retryPolicy,
      durationMs: Math.max(0, Date.now() - startedAt),
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
      return failure('Tool preparation failed', 'HOOK_ERROR');
    }

    let tool: ReturnType<ToolRegistry['resolve']>;
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
      );
    }
    try {
      return await this.executeResolved(
        call,
        currentInput,
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
      );
    }
  }

  private async executeResolved(
    call: ToolUseBlock,
    currentInput: Record<string, unknown>,
    tool: ReturnType<ToolRegistry['resolve']>,
    startedAt: number,
    audit: (event: string, fields?: Record<string, unknown>) => Promise<void>,
    failure: (
      content: string,
      errorCode: string,
      retryPolicy?: ToolResultBlock['retryPolicy'],
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
      shell = tool.approvalScope?.(currentInput, this.rootDir);
    } catch {
      try {
        await audit('tool.decided', { decision: 'deny', decisionSource: 'invalid_target' });
        await audit('tool.finished', { status: 'failed', errorCode: 'INVALID_TARGET' });
      } catch {
        /* Execution has not begun. */
      }
      return failure('Invalid tool execution target', 'INVALID_TARGET');
    }
    let auditFields: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 2; attempt++) {
      const request: ApprovalRequest = {
        toolName: call.name,
        capabilities: tool.metadata?.permissions ?? [],
        input: currentInput,
        rootDir: this.rootDir,
        ...(shell ? { shell } : {}),
        // 只有无参数的解释器内建查询能确认不依赖外部脚本；其余命令仅允许单次批准。
        sessionAllowed:
          !shell ||
          /^(?:pwd|get-location)$/i.test(shell.command.trim()) ||
          shell.scriptDigest !== undefined,
      };
      const repeatKey = createHash('sha256')
        .update(stableJsonStringify([call.name, currentInput]))
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
          );
        }
        return failure(
          'Identical failed tool call cannot be repeated in this run',
          'REPEAT_BLOCKED',
        );
      }
      const cached = this.approvalCache.get(request);
      const decision = this.policy.decide({
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
        : {};
      try {
        await audit('tool.decided', {
          decision: permitted ? 'allow' : 'deny',
          decisionSource: source,
          ...(approvalChoice ? { approvalChoice } : {}),
          ...auditFields,
        });
      } catch {
        return failure(
          'Audit unavailable; tool was not started',
          'AUDIT_UNAVAILABLE',
          'after_user_action',
        );
      }
      if (!permitted || this.signal?.aborted) {
        const code = this.signal?.aborted ? 'ABORTED' : 'PERMISSION_DENIED';
        try {
          await audit('tool.finished', { status: 'denied', errorCode: code });
        } catch {
          return failure('Audit result unavailable', 'AUDIT_UNAVAILABLE', 'after_user_action');
        }
        return failure(
          this.signal?.aborted ? 'Operation cancelled' : 'Tool permission denied',
          code,
          'after_user_action',
        );
      }
      if (shell) {
        try {
          const next = tool.approvalScope?.(currentInput, this.rootDir);
          if (next?.executionFingerprint !== shell.executionFingerprint) {
            if (attempt === 0 && next) {
              try {
                await audit('tool.target_changed', { status: 'redeciding' });
              } catch {
                return failure(
                  'Audit unavailable; tool was not started',
                  'AUDIT_UNAVAILABLE',
                  'after_user_action',
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
      break;
    }
    try {
      await audit('tool.started', { status: 'started', ...auditFields });
    } catch {
      return failure(
        'Audit unavailable; tool was not started',
        'AUDIT_UNAVAILABLE',
        'after_user_action',
      );
    }

    let outputStr: string;
    let isError = false;
    let errorCode: string | undefined;
    let retryPolicy: ToolResultBlock['retryPolicy'];
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
          ? await tool.execute(currentInput, toolCtx)
          : await this.withTimeout(
              tool.execute(currentInput, toolCtx),
              call.name,
              executionController,
            );
        outputStr = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult, null, 2);
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
    }

    const resultBlock: ToolResultBlock = {
      type: 'tool_result',
      toolUseId: call.id,
      content: outputStr,
      isError,
      ...(errorCode ? { errorCode, retryPolicy } : {}),
    };
    if (resultBlock.isError && resultBlock.errorCode) {
      resultBlock.content = JSON.stringify({
        code: resultBlock.errorCode,
        retryPolicy: resultBlock.retryPolicy,
        message: outputStr,
      });
    }

    // 3. 触发 tool:after hooks
    try {
      for (const hook of this.hooks.get('tool:after')) {
        await hook(
          hookCtx,
          { id: call.id, name: call.name, input: currentInput },
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
    }

    resultBlock.durationMs = Math.max(0, Date.now() - startedAt);
    if (resultBlock.isError && resultBlock.retryPolicy === 'never') {
      this.neverFailures.add(
        createHash('sha256')
          .update(stableJsonStringify([call.name, currentInput]))
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
      return failure(
        'Tool outcome is unknown because the audit result could not be written',
        'OUTCOME_UNKNOWN',
        'after_user_action',
      );
    }

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
