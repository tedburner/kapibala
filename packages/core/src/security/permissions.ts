import path from 'node:path';
import type { Capability, Tool } from '../tools/index.js';

/** 本次会话的自动执行边界；FullAccess 只能由宿主为本次会话显式选择。 */
export type SessionMode = 'Approval' | 'Plan' | 'Auto' | 'FullAccess';
export type PermissionAction = 'allow' | 'ask' | 'deny';

export interface ShellScope {
  command: string;
  interpreter: string;
  executablePath?: string;
  cwd: string;
  executableDigest?: string;
  scriptDigest?: string;
  executionFingerprint?: string;
}

export interface PermissionRule {
  action: PermissionAction;
  tool?: string;
  capability?: Capability;
  shell?: ShellScope;
}

export interface PermissionRequest {
  mode: SessionMode;
  toolName: string;
  capabilities: readonly Capability[];
  dangerous?: boolean;
  hardDenied?: boolean;
  shell?: ShellScope;
  rules?: readonly PermissionRule[];
  cachedApproval?: boolean;
  cachedDenial?: boolean;
}

export interface PermissionDecision {
  decision: PermissionAction;
  source: 'hard_limit' | 'plan' | 'explicit_rule' | 'session_cache' | 'mode_default';
  ruleIndex?: number;
}

const CAPABILITIES = new Set<Capability>([
  'fs:read',
  'fs:write',
  'exec',
  'net:outbound',
  'env:read',
  'agent:spawn',
]);

/** 拒绝含糊的 Shell 前缀/通配符和结构不完整的规则。 */
export function validatePermissionRules(rules: readonly PermissionRule[]): void {
  for (const [index, rule] of rules.entries()) {
    const ruleNumber = index + 1;
    if (!['allow', 'ask', 'deny'].includes(rule.action)) {
      throw new Error(`Permission rule ${ruleNumber}: invalid action`);
    }
    const scopes =
      Number(rule.tool !== undefined) +
      Number(rule.capability !== undefined) +
      Number(rule.shell !== undefined);
    if (scopes !== 1)
      throw new Error(`Permission rule ${ruleNumber}: exactly one scope is required`);
    if (rule.capability && !CAPABILITIES.has(rule.capability)) {
      throw new Error(`Permission rule ${ruleNumber}: unknown capability`);
    }
    if (rule.tool !== undefined && (!rule.tool.trim() || /[*?]/.test(rule.tool))) {
      throw new Error(`Permission rule ${ruleNumber}: tool scope must be an exact name`);
    }
    if (rule.shell) {
      const { command, interpreter, cwd } = rule.shell;
      if (
        !command?.trim() ||
        !interpreter?.trim() ||
        !cwd?.trim() ||
        /[*?]/.test(command) ||
        /[*?]/.test(interpreter) ||
        /[*?]/.test(cwd)
      ) {
        throw new Error(
          `Permission rule ${ruleNumber}: shell rules require an exact command, interpreter and cwd`,
        );
      }
    }
  }
}

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** 纯策略裁决；宿主硬限制和 Plan 始终先于任何规则或会话缓存。 */
export class PermissionPolicy {
  decide(request: PermissionRequest): PermissionDecision {
    if (request.hardDenied) return { decision: 'deny', source: 'hard_limit' };
    if (
      request.mode === 'Plan' &&
      (request.dangerous ||
        request.capabilities.length === 0 ||
        request.capabilities.some((capability) => capability !== 'fs:read'))
    ) {
      return { decision: 'deny', source: 'plan' };
    }
    const matches = (rule: PermissionRule): boolean => {
      if (rule.tool !== undefined) return rule.tool === request.toolName;
      if (rule.capability !== undefined) return request.capabilities.includes(rule.capability);
      if (!rule.shell || !request.shell) return false;
      return (
        rule.shell.command === request.shell.command &&
        rule.shell.interpreter === request.shell.interpreter &&
        samePath(rule.shell.cwd, request.shell.cwd)
      );
    };
    const rules = request.rules ?? [];
    for (const action of ['deny', 'ask'] as const) {
      const ruleIndex = rules.findIndex((rule) => rule.action === action && matches(rule));
      if (ruleIndex >= 0) return { decision: action, source: 'explicit_rule', ruleIndex };
      if (action === 'deny' && request.cachedDenial)
        return { decision: 'deny', source: 'session_cache' };
    }
    if (request.cachedApproval) return { decision: 'allow', source: 'session_cache' };
    if (request.capabilities.length === 0) return { decision: 'ask', source: 'mode_default' };
    const allowIndex = rules.findIndex(
      (rule) =>
        rule.action === 'allow' &&
        matches(rule) &&
        (request.toolName !== 'run_command' || rule.shell !== undefined),
    );
    if (allowIndex >= 0)
      return { decision: 'allow', source: 'explicit_rule', ruleIndex: allowIndex };
    if (request.capabilities.length === 0 || (request.dangerous && request.mode !== 'FullAccess')) {
      return { decision: 'ask', source: 'mode_default' };
    }
    if (request.mode === 'FullAccess') return { decision: 'allow', source: 'mode_default' };
    if (request.capabilities.every((capability) => capability === 'fs:read')) {
      return { decision: 'allow', source: 'mode_default' };
    }
    if (
      request.mode === 'Auto' &&
      request.capabilities.every(
        (capability) => capability === 'fs:read' || capability === 'fs:write',
      )
    ) {
      return { decision: 'allow', source: 'mode_default' };
    }
    return { decision: 'ask', source: 'mode_default' };
  }
}

/** 只向模型展示当前模式与整项拒绝规则允许请求的工具。 */
export function visibleTools(
  tools: readonly Tool[],
  mode: SessionMode,
  rules: readonly PermissionRule[] = [],
): Tool[] {
  const policy = new PermissionPolicy();
  return tools.filter(
    (tool) =>
      policy.decide({
        mode,
        toolName: tool.name,
        capabilities: tool.metadata?.permissions ?? [],
        dangerous: tool.metadata?.dangerous,
        rules,
      }).decision !== 'deny',
  );
}
