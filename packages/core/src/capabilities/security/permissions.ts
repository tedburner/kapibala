import path from 'node:path';
import type { Capability, Tool } from '../tools/index.js';

/** 本次会话的自动执行边界；FullAccess 只能由宿主为本次会话显式选择。 */
export type SessionMode = 'Approval' | 'Plan' | 'Auto' | 'FullAccess';
/** 规则动作与裁决结果共用同一词表；ask 表示交人工审批，不是放行。 */
export type PermissionAction = 'allow' | 'ask' | 'deny';

/** 一次 Shell 执行的精确目标；字段组合构成审批与缓存命中的身份，任何维度都不允许通配。 */
export interface ShellScope {
  command: string;
  interpreter: string;
  executablePath?: string;
  cwd: string;
  /** 解释器身份摘要（路径、大小、mtime 推导）；解释器被替换后规则与缓存即失配。 */
  executableDigest?: string;
  /** 命令直接引用的工作目录内脚本的内容摘要；仅单脚本命令可计算，组合命令缺省。 */
  scriptDigest?: string;
  /** 执行前复核用指纹；审批后重新推导不一致时按目标漂移拒绝执行。 */
  executionFingerprint?: string;
}

/** 宿主提供的显式规则；tool / capability / shell 三种范围必须恰好声明一个。 */
export interface PermissionRule {
  action: PermissionAction;
  tool?: string;
  capability?: Capability;
  shell?: ShellScope;
}

/** 权限裁决的全部输入；硬限制与缓存命中由宿主查询后以标志位传入，策略本身不持有状态。 */
export interface PermissionRequest {
  mode: SessionMode;
  toolName: string;
  capabilities: readonly Capability[];
  /** 危险性来自工具元数据；未命中 allow 规则时，非 FullAccess 模式一律降级为 ask。 */
  dangerous?: boolean;
  /** 宿主硬限制；命中即拒绝，优先级高于一切规则与缓存。 */
  hardDenied?: boolean;
  shell?: ShellScope;
  /** 规则表须先经 validatePermissionRules 校验；同动作规则按声明顺序取首个命中。 */
  rules?: readonly PermissionRule[];
  /** 会话缓存命中标志（来自 SessionApprovalCache）；仅在 deny / ask 规则都未命中时生效。 */
  cachedApproval?: boolean;
  /** 会话缓存拒绝标志；在 deny 规则之后、ask 规则之前生效。 */
  cachedDenial?: boolean;
}

/** 裁决结果及其来源；source 供审计区分硬限制、Plan、规则、缓存与模式默认。 */
export interface PermissionDecision {
  decision: PermissionAction;
  source: 'hard_limit' | 'plan' | 'explicit_rule' | 'session_cache' | 'mode_default';
  /** 命中规则在 rules 中的下标；仅 source 为 explicit_rule 时存在。 */
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
  /**
   * 裁决顺序固定：硬限制 → Plan 收窄 → deny 规则 → 会话缓存拒绝 → ask 规则 →
   * 会话缓存允许 → allow 规则（run_command 必须带 shell 范围，工具级 allow 不能放行命令）
   * → 模式默认。同一输入总是得到同一裁决，不读取任何外部状态。
   */
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
