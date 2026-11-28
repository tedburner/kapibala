import { createHash } from 'node:crypto';
import type { Capability, ToolExecutionIdentity } from '../tools/index.js';
import type { ShellScope } from './permissions.js';

/**
 * 人工审批的五选一结果。allow_once / deny_once 只作用于本次执行；
 * allow_session / deny_session 由执行器按精确调用范围写入会话缓存（allow_session 还要求请求允许会话级缓存）；
 * cancel 表示放弃审批，一律拒绝且绝不进入缓存。
 */
export type ApprovalChoice =
  | 'allow_once'
  | 'allow_session'
  | 'deny_once'
  | 'deny_session'
  | 'cancel';

/**
 * 子代理向父会话冒泡人工审批时的来源身份快照。
 *
 * 约束：多层嵌套（root → A → B）冒泡时保留最内层实际发起调用的子代理身份，
 * 仅供宿主渲染来源提示与路由，不改变权限裁决逻辑或会话级审批缓存键。
 */
export interface SubagentApprovalOrigin {
  readonly agentId: string;
  readonly role: string;
  readonly description: string;
  readonly childSessionId?: string;
  readonly parentSessionId: string;
}

/** 宿主展示实际执行目标并取得人工选择；无通道视为非交互拒绝。 */
export interface ApprovalRequest {
  toolName: string;
  capabilities: readonly Capability[];
  input: Record<string, unknown>;
  rootDir: string;
  shell?: ShellScope;
  /**
   * 本次调用的外部执行身份；深度哈希纳入审批缓存键，断连重连或目录变更后旧会话批准自动失效。
   */
  executionIdentity?: ToolExecutionIdentity;
  /** 宿主是否允许本次请求写入会话级允许缓存；deny_session 的缓存不受此限制。 */
  sessionAllowed: boolean;
  /** 子代理冒泡审批时的最内层发起者身份；根会话直接调用时缺省。 */
  readonly subagentOrigin?: SubagentApprovalOrigin;
}

/** 宿主实现的审批入口；未提供通道时执行器按非交互直接拒绝，通道抛错视同 cancel。 */
export interface ApprovalChannel {
  requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalChoice>;
}

/** 规范化 JSON 序列化：递归对对象键按字典序排序，保证相同的输入结构产生一致的字符串和 Hash。 */
export function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJsonStringify(obj[k])}`).join(',')}}`;
}

/** 只在当前 Session 内复用精确调用范围，不存储原始工具参数。 */
export class SessionApprovalCache {
  private readonly choices = new Map<string, 'allow' | 'deny'>();

  key(request: ApprovalRequest): string {
    return createHash('sha256')
      .update(
        stableJsonStringify([
          request.toolName,
          [...request.capabilities].sort(),
          request.input,
          request.rootDir,
          request.shell ?? null,
          request.executionIdentity ?? null,
        ]),
      )
      .digest('hex');
  }

  get(request: ApprovalRequest): 'allow' | 'deny' | undefined {
    return this.choices.get(this.key(request));
  }

  set(request: ApprovalRequest, choice: 'allow' | 'deny'): void {
    this.choices.set(this.key(request), choice);
  }
}
