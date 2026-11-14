import { createHash } from 'node:crypto';
import {
  type ApprovalChannel,
  type ApprovalRequest,
  type SessionApprovalCache,
  stableJsonStringify,
} from '../../capabilities/security/approval.js';
import type {
  PermissionPolicy,
  PermissionRule,
  SessionMode,
  ShellScope,
} from '../../capabilities/security/permissions.js';
import type { Tool, ToolExecutionIdentity } from '../../capabilities/tools/index.js';
import { commandAuditSummary } from '../../extensibility/logging/index.js';
import type { ToolResultBlock, ToolResultExecution, ToolUseBlock } from '../../types/index.js';
import type { ToolHardDenial } from './types.js';

/** 工具审批裁决的依赖集合；裁决所需全部状态由执行器显式注入，函数不读全局状态。 */
export interface ToolApprovalDeps {
  call: ToolUseBlock;
  finalInput: Record<string, unknown>;
  tool: Tool;
  /** 初始执行目标范围；目标指纹变化时在函数内更新并随结果返回。 */
  shell: ShellScope | undefined;
  executionIdentity: ToolExecutionIdentity | undefined;
  rootDir: string;
  executionCwd: string;
  mode: SessionMode | (() => SessionMode);
  permissionRules: readonly PermissionRule[];
  approvalChannel?: ApprovalChannel;
  approvalCache: SessionApprovalCache;
  hardDenial?: (tool: Tool, input: Record<string, unknown>) => ToolHardDenial | undefined;
  /** 本 run 内已出现的 never 失败指纹；同一参数的重复失败直接拒绝。 */
  neverFailures: Set<string>;
  policy: PermissionPolicy;
  signal?: AbortSignal;
  audit: (event: string, fields?: Record<string, unknown>) => Promise<void>;
  failure: (
    content: string,
    errorCode: string,
    retryPolicy?: ToolResultBlock['retryPolicy'],
    execution?: ToolResultExecution,
  ) => ToolResultBlock;
}

/** 审批裁决产物：result 存在表示已闭合的拒绝/中止结果；否则放行并携带最新 shell 与审计字段。 */
export interface ToolApprovalOutcome {
  result?: ToolResultBlock;
  shell?: ShellScope;
  /** 仅放行路径携带；拒绝路径为 undefined，调用方以空对象兜底。 */
  auditFields?: Record<string, unknown>;
}

/**
 * 工具执行前的完整裁决循环：硬拒绝 → 策略 → 宿主审批 → 审计 → 目标身份复核。
 *
 * 保证与边界：
 * - 最多两轮：shell 指纹在审批后发生变化时重跑一轮裁决（防 TOCTOU），第二轮再变
 *   即 TARGET_CHANGED fail-closed；MCP 身份四元组变化同理拒绝；
 * - 审计写入失败一律返回 AUDIT_UNAVAILABLE（not_sent），工具绝不无审计执行；
 * - 中止信号或拒绝都以 after_user_action 闭合，调用方据此短路同批后续调用；
 * - 函数不抛出工具裁决错误——所有失败都以 isError 结果闭合返回。
 */
export async function resolveToolApproval(deps: ToolApprovalDeps): Promise<ToolApprovalOutcome> {
  const {
    call,
    finalInput,
    tool,
    rootDir,
    executionCwd,
    mode,
    permissionRules,
    approvalChannel,
    approvalCache,
    hardDenial,
    neverFailures,
    policy,
    signal,
    audit,
    failure,
  } = deps;
  let shell = deps.shell;
  const executionIdentity = deps.executionIdentity;
  let auditFields: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 2; attempt++) {
    const request: ApprovalRequest = {
      toolName: call.name,
      capabilities: tool.metadata?.permissions ?? [],
      input: finalInput,
      rootDir,
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
    if (neverFailures.has(repeatKey)) {
      try {
        await audit('tool.decided', { decision: 'deny', decisionSource: 'repeat_block' });
        await audit('tool.finished', { status: 'blocked', errorCode: 'REPEAT_BLOCKED' });
      } catch {
        return {
          result: failure(
            'Audit unavailable; tool was not started',
            'AUDIT_UNAVAILABLE',
            'after_user_action',
            {
              version: 1,
              dispatchOutcome: 'not_sent',
              hostError: { phase: 'audit', code: 'AUDIT_UNAVAILABLE' },
            },
          ),
        };
      }
      return {
        result: failure(
          'Identical failed tool call cannot be repeated in this run',
          'REPEAT_BLOCKED',
        ),
      };
    }
    const hardDenied = hardDenial?.(tool, finalInput);
    const cached = approvalCache.get(request);
    const decision = policy.decide({
      hardDenied: hardDenied !== undefined,
      mode: typeof mode === 'function' ? mode() : mode,
      toolName: call.name,
      capabilities: request.capabilities,
      dangerous: tool.metadata?.dangerous,
      cachedApproval: cached === 'allow',
      cachedDenial: cached === 'deny',
      rules: permissionRules,
      ...(shell ? { shell } : {}),
    });
    let permitted = decision.decision === 'allow';
    let source: string = decision.source;
    let approvalChoice: Awaited<ReturnType<ApprovalChannel['requestApproval']>> | undefined;
    if (decision.decision === 'ask') {
      let choice: Awaited<ReturnType<ApprovalChannel['requestApproval']>> = 'deny_once';
      try {
        choice = (await approvalChannel?.requestApproval(request, signal)) ?? 'deny_once';
      } catch {
        choice = 'cancel';
      }
      approvalChoice = choice;
      if (choice === 'allow_session' && request.sessionAllowed) approvalCache.set(request, 'allow');
      if (choice === 'deny_session') approvalCache.set(request, 'deny');
      permitted = choice === 'allow_once' || (choice === 'allow_session' && request.sessionAllowed);
      source = approvalChannel ? 'human' : 'non_interactive';
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
      return {
        result: failure(
          'Audit unavailable; tool was not started',
          'AUDIT_UNAVAILABLE',
          'after_user_action',
          {
            version: 1,
            dispatchOutcome: 'not_sent',
            hostError: { phase: 'audit', code: 'AUDIT_UNAVAILABLE' },
          },
        ),
      };
    }
    if (!permitted || signal?.aborted) {
      const code = signal?.aborted ? 'ABORTED' : (hardDenied?.code ?? 'PERMISSION_DENIED');
      try {
        await audit('tool.finished', { status: 'denied', errorCode: code });
      } catch {
        return {
          result: failure('Audit result unavailable', 'AUDIT_UNAVAILABLE', 'after_user_action', {
            version: 1,
            dispatchOutcome: 'not_sent',
            hostError: { phase: 'audit', code: 'AUDIT_UNAVAILABLE' },
          }),
        };
      }
      return {
        result: failure(
          signal?.aborted
            ? 'Operation cancelled'
            : (hardDenied?.message ?? 'Tool permission denied'),
          code,
          signal?.aborted ? 'after_user_action' : (hardDenied?.retryPolicy ?? 'after_user_action'),
        ),
      };
    }
    if (shell) {
      try {
        const next = tool.approvalScope?.(finalInput, rootDir, executionCwd);
        if (next?.executionFingerprint !== shell.executionFingerprint) {
          if (attempt === 0 && next) {
            try {
              await audit('tool.target_changed', { status: 'redeciding' });
            } catch {
              return {
                result: failure(
                  'Audit unavailable; tool was not started',
                  'AUDIT_UNAVAILABLE',
                  'after_user_action',
                  {
                    version: 1,
                    dispatchOutcome: 'not_sent',
                    hostError: { phase: 'audit', code: 'AUDIT_UNAVAILABLE' },
                  },
                ),
              };
            }
            shell = next;
            continue;
          }
          await audit('tool.finished', { status: 'target_changed', errorCode: 'TARGET_CHANGED' });
          return {
            result: failure(
              'Execution target changed after approval',
              'TARGET_CHANGED',
              'after_user_action',
            ),
          };
        }
      } catch {
        return {
          result: failure(
            'Execution target changed after approval',
            'TARGET_CHANGED',
            'after_user_action',
          ),
        };
      }
    }
    if (executionIdentity) {
      try {
        const nextIdentity = tool.executionIdentity?.(finalInput, rootDir);
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
          return {
            result: failure(
              'Tool execution identity changed after approval',
              'MCP_TOOL_CHANGED',
              'after_user_action',
              {
                version: 1,
                dispatchOutcome: 'not_sent',
                hostError: { phase: 'validation', code: 'MCP_TOOL_CHANGED' },
              },
            ),
          };
        }
      } catch {
        return {
          result: failure(
            'Tool execution identity check failed after approval',
            'MCP_TOOL_CHANGED',
            'after_user_action',
            {
              version: 1,
              dispatchOutcome: 'not_sent',
            },
          ),
        };
      }
    }
    break;
  }
  return { shell, auditFields };
}
