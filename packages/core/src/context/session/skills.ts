import type {
  ApprovalChannel,
  ApprovalRequest,
  SessionApprovalCache,
} from '../../capabilities/security/approval.js';
import {
  PermissionPolicy,
  type PermissionRule,
  type SessionMode,
} from '../../capabilities/security/permissions.js';
import type { SkillRuntime } from '../../capabilities/skills/loader.js';
import type { SkillResourceInput, SkillResourcePage } from '../../capabilities/skills/resources.js';
import { skillDigest, skillFailure } from '../../capabilities/skills/scanner.js';
import type { SkillContentSource } from '../../capabilities/skills/types.js';
import { KapibalaError } from '../../errors/index.js';
import type { EventLogger } from '../../extensibility/logging/index.js';
import type { SessionEvent } from '../../types/index.js';

/**
 * 构造 SkillRuntime 的资源读取审计回调。
 *
 * 保证：审计失败 fail-closed —— 抛出 AUDIT_UNAVAILABLE（retryPolicy
 * after_user_action）终止本轮，而不是在未审计的情况下放行资源内容；
 * 记录内容摘要而非正文，避免敏感资源进入审计日志。
 */
export function createSkillResourceAuditor(
  eventLogger: EventLogger,
  sessionId: string,
): (
  source: SkillContentSource,
  input: SkillResourceInput,
  page: SkillResourcePage,
) => Promise<void> {
  return async (source, input, page) => {
    try {
      await eventLogger.recordAudit({
        level: 'info',
        event: 'skill.resource_read',
        sessionId,
        runId: source.runId,
        fields: {
          skillName: source.name,
          contentDigest: source.contentDigest,
          invocationId: source.invocationId,
          pathDigest: skillDigest(input.path),
          resourceDigest: skillDigest(page.text),
          outputBytes: Buffer.byteLength(page.text),
          outputTruncated: page.truncated,
          offset: input.offset,
          startLine: input.startLine,
          endLine: input.endLine,
        },
      });
    } catch {
      throw new KapibalaError('Skill resource audit unavailable', {
        code: 'AUDIT_UNAVAILABLE',
        retryPolicy: 'after_user_action',
        safeMessage: '技能资源读取审计不可用，本轮停止',
      });
    }
  };
}

/** 技能提交审计的依赖集合；全部由会话显式注入，不从全局状态隐式获取。 */
export interface SkillCommitDeps {
  skillRuntime: SkillRuntime | undefined;
  eventLogger: EventLogger;
  sessionId: string;
  runId: string;
  /** 落盘通道标记：有持久 Store 为 'disk'，纯内存会话为 'memory'。 */
  persistence: 'disk' | 'memory';
}

/**
 * 完整消息提交后完成技能审计并返回技能事件。
 *
 * 保证：审计失败保留真实历史，停止本轮且不发布成功事件（AUDIT_UNAVAILABLE
 * fail-closed）；无技能运行时返回空数组，不产生额外事件。
 */
export async function commitSkillEvents(deps: SkillCommitDeps): Promise<SessionEvent[]> {
  const { skillRuntime, eventLogger, sessionId, runId, persistence } = deps;
  if (!skillRuntime) return [];
  return skillRuntime.commit(async (source, messageId) => {
    try {
      await eventLogger.recordAudit({
        level: 'info',
        event: 'skill.loaded',
        sessionId,
        runId,
        fields: {
          skillName: source.name,
          skillScope: source.scope,
          contentDigest: source.contentDigest,
          renderedDigest: source.renderedDigest,
          pathDigest: skillDigest(source.filePath),
          caller: source.caller,
          invocationId: source.invocationId,
          messageId,
        },
      });
    } catch {
      throw new KapibalaError('Skill commit audit unavailable', {
        code: 'AUDIT_UNAVAILABLE',
        retryPolicy: 'after_user_action',
        safeMessage: '技能提交审计不可用，本轮停止',
      });
    }
  }, persistence);
}

/** 显式技能授权的依赖集合；权限裁决的全部输入必须来自当前会话快照。 */
export interface SkillAuthorizeDeps {
  name: string;
  runId: string;
  signal?: AbortSignal;
  rootDir: string;
  mode: SessionMode;
  permissionRules: readonly PermissionRule[];
  approvalChannel?: ApprovalChannel;
  approvalCache: SessionApprovalCache;
  eventLogger: EventLogger;
  sessionId: string;
}

/**
 * 显式技能加载的权限裁决 + 宿主审批 + 审计。
 *
 * 保证：仍按同一读取策略（load_skill 同名请求）走精确缓存与 PermissionPolicy
 * 裁决；宿主询问异常按 cancel 处理 fail-closed；拒绝/取消/审计失败时抛出
 * SKILL_INVOCATION_FORBIDDEN，调用方不追加用户任务；允许时 signal 已中止也
 * 会在末尾 throwIfAborted 拒绝继续。
 */
export async function authorizeExplicitSkill(deps: SkillAuthorizeDeps): Promise<void> {
  const {
    name,
    runId,
    signal,
    rootDir,
    mode,
    permissionRules,
    approvalChannel,
    approvalCache,
    eventLogger,
    sessionId,
  } = deps;
  const request: ApprovalRequest = {
    toolName: 'load_skill',
    capabilities: ['fs:read'],
    input: { name },
    rootDir,
    sessionAllowed: true,
  };
  const cached = approvalCache.get(request);
  const decision = new PermissionPolicy().decide({
    toolName: request.toolName,
    capabilities: request.capabilities,
    mode,
    rules: permissionRules,
    cachedApproval: cached === 'allow',
    cachedDenial: cached === 'deny',
  });
  let permitted = decision.decision === 'allow';
  let approvalChoice: Awaited<ReturnType<ApprovalChannel['requestApproval']>> | undefined;
  if (decision.decision === 'ask') {
    try {
      approvalChoice = (await approvalChannel?.requestApproval(request, signal)) ?? 'deny_once';
    } catch {
      approvalChoice = 'cancel';
    }
    permitted = approvalChoice === 'allow_once' || approvalChoice === 'allow_session';
    if (approvalChoice === 'allow_session') approvalCache.set(request, 'allow');
    if (approvalChoice === 'deny_session') approvalCache.set(request, 'deny');
  }
  await eventLogger.recordAudit({
    level: 'info',
    event: 'skill.decided',
    sessionId,
    runId,
    fields: {
      skillName: name,
      caller: 'user',
      decision: permitted && !signal?.aborted ? 'allow' : 'deny',
      decisionSource:
        decision.decision === 'ask'
          ? approvalChannel
            ? 'human'
            : 'non_interactive'
          : decision.source,
      approvalChoice,
    },
  });
  if (!permitted) throw skillFailure('SKILL_INVOCATION_FORBIDDEN', '宿主权限禁止显式技能读取');
  signal?.throwIfAborted();
}
