import path from 'node:path';
import type { ShellCommandClass } from '../shell/command-class.js';
import type { ShellCommandSafety } from '../shell/command-safety.js';
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
  /**
   * Auto 模式专用：shell 命令安全分级（执行器经 classifyShellCommandSafety 对最终 ShellScope
   * 计算）。仅参与模式默认值裁决，`safe` 允许 Auto 自动放行静态 dangerous 的 shell 工具；
   * `unsafe`/`unknown` 与缺省（非 shell 工具）维持原有降级路径，显式规则与会话缓存仍先于此生效。
   * 提供 `commandClass` 时本字段不参与裁决，仅用于兼容旧调用方。
   */
  shellSafety?: ShellCommandSafety;
  /**
   * Shell 命令的风险类别（执行器经 classifyShellCommandClass 计算）。提供后按类别两轴裁决：
   * `read` 在 Approval / Auto 放行；`workspace-write` / `vcs-write` 仅 Auto 与 FullAccess 放行；
   * `network` / `destructive` / `escape` / `unknown` 仅 FullAccess 放行。显式规则与会话缓存
   * 仍先于此生效；未提供时回退 `shellSafety` 的旧语义。
   */
  commandClass?: ShellCommandClass;
  /**
   * shell 命令可静态识别、且命中硬禁区的写入目标（workspace 相对路径）。
   * 提供时在硬限制之后、任何规则/缓存/模式之前直接 `deny`，FullAccess 也不能放行；
   * 与 PathSandbox 的硬禁区共用同一份判定，避免 shell 成为绕过通道。
   */
  protectedTarget?: string;
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
  source:
    | 'hard_limit'
    | 'protected_path'
    | 'plan'
    | 'explicit_rule'
    | 'session_cache'
    | 'mode_default';
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
  'external:call',
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
   * → 两轴类别裁决（提供 `commandClass` 时）→ 模式默认。同一输入总是得到同一裁决，
   * 不读取任何外部状态。
   */
  decide(request: PermissionRequest): PermissionDecision {
    if (request.hardDenied) return { decision: 'deny', source: 'hard_limit' };
    // shell 写硬禁区与 PathSandbox 同源：命中即拒绝，不产生审批请求，FullAccess 也不放行。
    if (request.protectedTarget !== undefined)
      return { decision: 'deny', source: 'protected_path' };
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
    const allowIndex = rules.findIndex(
      (rule) =>
        rule.action === 'allow' &&
        matches(rule) &&
        (request.toolName !== 'run_command' || rule.shell !== undefined),
    );
    if (allowIndex >= 0)
      return { decision: 'allow', source: 'explicit_rule', ruleIndex: allowIndex };
    // FullAccess 是「不询问」档：能力表为空或不危险的未知工具也必须放行；
    // 硬限制与显式规则仍在上面优先，因此这不是无条件信任。
    if (request.mode === 'FullAccess') return { decision: 'allow', source: 'mode_default' };
    // 两轴裁决：类别决定「能力上限」，模式决定「何时找人」。Approval 不能复用三值的
    // safe 判断，必须额外看 class === 'read'；规则与会话缓存已在上方优先处理。
    if (request.commandClass !== undefined && request.shell !== undefined) {
      const commandClass = request.commandClass;
      if (commandClass === 'read') return { decision: 'allow', source: 'mode_default' };
      if (commandClass === 'workspace-write' || commandClass === 'vcs-write') {
        return {
          decision: request.mode === 'Auto' ? 'allow' : 'ask',
          source: 'mode_default',
        };
      }
      return { decision: 'ask', source: 'mode_default' };
    }
    // 兼容路径：调用方未提供 `commandClass` 时，仍按三值 `shellSafety` 判断 Auto 放行；
    // unsafe/unknown 维持询问（fail-closed）。
    if (request.mode === 'Auto' && request.dangerous && request.shellSafety === 'safe') {
      return { decision: 'allow', source: 'mode_default' };
    }
    if (request.capabilities.length === 0 || request.dangerous) {
      return { decision: 'ask', source: 'mode_default' };
    }
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
