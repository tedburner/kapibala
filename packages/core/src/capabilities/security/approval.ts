import { createHash } from 'node:crypto';
import type { Capability } from '../tools/index.js';
import type { ShellScope } from './permissions.js';

export type ApprovalChoice =
  | 'allow_once'
  | 'allow_session'
  | 'deny_once'
  | 'deny_session'
  | 'cancel';

/** 宿主展示实际执行目标并取得人工选择；无通道视为非交互拒绝。 */
export interface ApprovalRequest {
  toolName: string;
  capabilities: readonly Capability[];
  input: Record<string, unknown>;
  rootDir: string;
  shell?: ShellScope;
  sessionAllowed: boolean;
}

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
