/**
 * @fileoverview 子代理权限求交（ChildGrant）与角色模型路由。
 *
 * 约束、边界与为什么：
 * 1. 逐轴求交（Intersection Only）：
 *    子代理的权限永远是「父级有效策略」、「角色预设上界」与「显式 ChildGrant 请求」三者的交集。
 *    任何维度（模式、规则、能力、工具、工作区、深度、预算）只能收紧，绝对不得越级放宽。
 * 2. 祖先 Deny 并集继承与 Ask 保留：
 *    祖先链上的所有 deny 规则无条件继承，子代理无法绕过；祖先的 ask 规则必须保留，
 *    不因子代理声明 allow 规则或 FullAccess 模式而消失。
 * 3. 角色预设为单一真源：
 *    - explore：只读探索，禁用通用 Shell 与写能力，首选场景 fast；
 *    - planner：分析规划，禁用通用 Shell 与写能力，首选场景 planning；
 *    - implement：具体实施，可委派写与执行权限，首选场景 execution；
 *    - advisor：纯文本推理，工具集合严格为空，首选场景 planning；
 *    - custom：自定义工具白名单，继承父场景绑定，必须显式声明 allowedTools。
 * 4. Plan 模式硬约束与深度熔断：
 *    Plan 模式绝对禁止 agent:spawn；达到最大深度（默认 3，硬上限 5）的子代理绝对禁止继续派生。
 * 5. 防伪造与不可委派拦截：
 *    请求不存在于父可用工具列表中的工具名，立即拒绝并抛出 TOOL_NOT_DELEGATABLE。
 */

import { isPathInside, toNativePhysicalPath } from '../../context/workspace.js';
import { KapibalaError } from '../../errors/index.js';
import type { PrimaryModelRole } from '../../models/router.js';
import type { Capability, Tool } from '../tools/index.js';
import type { PermissionAction, PermissionRule, SessionMode } from './permissions.js';

/** 子代理业务角色预设。 */
export type SubagentRole = 'explore' | 'planner' | 'implement' | 'advisor' | 'custom';

/** 默认子代理派生深度限制。根代理深度为 0，深度达到 3 时不可再派生。 */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 3;

/** 运行时子代理硬上限深度。任何配置不得超过此深度。 */
export const HARD_LIMIT_MAX_SUBAGENT_DEPTH = 5;

/** 子代理限额配置。 */
export interface ChildLimits {
  /** 允许的最大模型步骤数；默认 15。 */
  maxSteps: number;
  /** 单任务最大墙钟执行时间（毫秒）；默认 300,000（5分钟）。 */
  timeoutMs: number;
}

/** 默认子代理限额。 */
export const DEFAULT_CHILD_LIMITS: Readonly<ChildLimits> = Object.freeze({
  maxSteps: 15,
  timeoutMs: 300_000,
});

/** 角色预设定义规范。 */
export interface RolePresetDefinition {
  /** 角色唯一标识。 */
  readonly role: SubagentRole;
  /** 中文说明。 */
  readonly description: string;
  /** 绑定的首选场景模型角色；custom 继承父轮。 */
  readonly preferredRole: PrimaryModelRole | 'inherit';
  /** 允许的能力上界集合；不在集合内的能力即使父级具备也被剥离。 */
  readonly allowedCapabilities: readonly Capability[];
  /** 绝对禁止的能力集合；在求交时强制剔除。 */
  readonly disallowedCapabilities: readonly Capability[];
  /** 是否允许工具集合非空；advisor 强制要求为空。 */
  readonly allowTools: boolean;
  /** 是否需要显式提供工具白名单；custom 必须显式提供。 */
  readonly requireExplicitTools: boolean;
}

/**
 * 角色预设单一真源映射表。
 */
export const ROLE_PRESETS: Readonly<Record<SubagentRole, RolePresetDefinition>> = Object.freeze({
  explore: Object.freeze({
    role: 'explore',
    description: '受控读取探索；不提供通用 Shell 或写副作用工具',
    preferredRole: 'fast',
    allowedCapabilities: Object.freeze<Capability[]>(['fs:read', 'env:read']),
    disallowedCapabilities: Object.freeze<Capability[]>([
      'fs:write',
      'exec',
      'agent:spawn',
      'external:call',
    ]),
    allowTools: true,
    requireExplicitTools: false,
  }),
  planner: Object.freeze({
    role: 'planner',
    description: '受控读取与架构分析；不提供通用 Shell 与写能力',
    preferredRole: 'planning',
    allowedCapabilities: Object.freeze<Capability[]>(['fs:read', 'env:read']),
    disallowedCapabilities: Object.freeze<Capability[]>([
      'fs:write',
      'exec',
      'agent:spawn',
      'external:call',
    ]),
    allowTools: true,
    requireExplicitTools: false,
  }),
  implement: Object.freeze({
    role: 'implement',
    description: '申请父级可委派写与执行权限；需写租约或 worktree 保护',
    preferredRole: 'execution',
    allowedCapabilities: Object.freeze<Capability[]>([
      'fs:read',
      'fs:write',
      'exec',
      'net:outbound',
      'env:read',
      'external:call',
    ]),
    disallowedCapabilities: Object.freeze<Capability[]>(['agent:spawn']),
    allowTools: true,
    requireExplicitTools: false,
  }),
  advisor: Object.freeze({
    role: 'advisor',
    description: '仅任务文本推理；工具集合严格为空',
    preferredRole: 'planning',
    allowedCapabilities: Object.freeze<Capability[]>([]),
    disallowedCapabilities: Object.freeze<Capability[]>([
      'fs:read',
      'fs:write',
      'exec',
      'net:outbound',
      'env:read',
      'agent:spawn',
      'external:call',
    ]),
    allowTools: false,
    requireExplicitTools: false,
  }),
  custom: Object.freeze({
    role: 'custom',
    description: '自定义工具白名单；必须显式声明工具列表并继承父场景绑定',
    preferredRole: 'inherit',
    allowedCapabilities: Object.freeze<Capability[]>([
      'fs:read',
      'fs:write',
      'exec',
      'net:outbound',
      'env:read',
      'agent:spawn',
      'external:call',
    ]),
    disallowedCapabilities: Object.freeze<Capability[]>([]),
    allowTools: true,
    requireExplicitTools: true,
  }),
});

/** 获取指定角色的预设定义。若角色不存在抛出 CONFIG_INVALID。 */
export function getRolePreset(role: string): RolePresetDefinition {
  const preset = ROLE_PRESETS[role as SubagentRole];
  if (!preset) {
    throw new KapibalaError(`Unknown subagent role: "${role}"`, {
      code: 'CONFIG_INVALID',
      safeMessage: `未知子代理角色: "${role}"`,
    });
  }
  return preset;
}

/** 派生子代理时的请求载荷（ChildGrant）。由调用方或 spawn_agent 工具传入。 */
export interface ChildGrant {
  /** 申请的角色。 */
  role: SubagentRole;
  /** 可选工具白名单收紧；若指定必须为父可用工具子集；custom 角色必选。 */
  allowedTools?: readonly string[];
  /** 显式声明允许的能力子集；只能收紧。 */
  allowedCapabilities?: readonly Capability[];
  /** 子任务追加的补充权限规则（只能收紧）。 */
  permissionRules?: readonly PermissionRule[];
  /** 申请生效的会话模式；只能比父模式更严格或相同，不可放宽。 */
  mode?: SessionMode;
  /** 子任务执行工作目录；必须位于父工作区内部。 */
  executionCwd?: string;
  /** 子任务运行限额；只能比默认/父限额更严格。 */
  limits?: Partial<ChildLimits>;
  /** 显式场景或模型覆盖；仅在宿主允许时生效。 */
  modelOverride?: string;
}

/** 父会话在派生时刻的有效策略快照。 */
export interface ParentPolicySnapshot {
  /** 父会话当前模式。 */
  mode: SessionMode;
  /** 父会话当前生效的全部规则（含祖先 deny 规则）。 */
  rules: readonly PermissionRule[];
  /** 父会话可用工具详细列表或元数据。 */
  availableTools: readonly (Tool | { name: string; metadata?: { permissions?: Capability[] } })[];
  /** 父会话物理工作区根绝对路径。 */
  workspaceRoot: string;
  /** 父会话当前命令执行工作目录绝对路径。 */
  executionCwd: string;
  /** 父会话当前深度（根会话为 0）。 */
  currentDepth: number;
  /** 允许的最大深度（缺省为 DEFAULT_MAX_SUBAGENT_DEPTH）。 */
  maxDepth?: number;
  /** 父会话当前场景模型角色。 */
  currentPrimaryRole?: PrimaryModelRole;
  /** 父会话可用限额。 */
  limits?: Partial<ChildLimits>;
}

/** 逐轴求交后派生出的子代理有效策略。 */
export interface DerivedChildPolicy {
  /** 子代理最终生效的 SessionMode。 */
  readonly mode: SessionMode;
  /** 子代理最终生效的权限规则（祖先 deny 并集 + 祖先 ask 保留 + 子收紧规则）。 */
  readonly rules: readonly PermissionRule[];
  /** 子代理最终可使用的工具名称列表。 */
  readonly allowedTools: readonly string[];
  /** 子代理最终允许的能力集合。 */
  readonly allowedCapabilities: readonly Capability[];
  /** 子代理规范化命令执行绝对工作目录。 */
  readonly executionCwd: string;
  /** 子代理所在任务树深度。 */
  readonly depth: number;
  /** 子代理生效的场景模型角色。 */
  readonly preferredRole: PrimaryModelRole;
  /** 子代理是否允许继续派生（agent:spawn）。 */
  readonly canSpawnSubagent: boolean;
  /** 子代理生效的运行限额。 */
  readonly limits: Readonly<ChildLimits>;
}

/**
 * SessionMode 宽松程度层级打分：分数越低越严格。
 * Plan (0) 最严格 -> Approval (1) -> Auto (2) -> FullAccess (3) 最宽松。
 */
const MODE_SEVERITY: Readonly<Record<SessionMode, number>> = Object.freeze({
  Plan: 0,
  Approval: 1,
  Auto: 2,
  FullAccess: 3,
});

/**
 * 模式收紧计算：比较并选择两者中更严格的模式。
 * 子代理绝对不能比父模式更宽松。
 */
export function tightenMode(parentMode: SessionMode, requestedMode?: SessionMode): SessionMode {
  if (!requestedMode) {
    return parentMode;
  }
  const parentScore = MODE_SEVERITY[parentMode] ?? 1;
  const requestedScore = MODE_SEVERITY[requestedMode] ?? 1;
  // 若请求更宽松（分数更高），强制退回到父模式
  return requestedScore < parentScore ? requestedMode : parentMode;
}

/**
 * 核心纯函数：逐轴求交派生子代理有效权限与策略。
 *
 * 保证：
 * - 纯函数无外部副作用，不依赖网络、文件系统（除纯路径层级判断）或全局状态；
 * - 祖先 deny 规则取并集继承，祖先 ask 规则完整保留；
 * - 模式、能力、工具、工作区、深度与限额逐轴求交收紧；
 * - 角色预设与调用方 ChildGrant 白名单求交；
 * - 若请求未知工具名或父级未提供的工具名，立即拒绝并抛出 TOOL_NOT_DELEGATABLE；
 * - Plan 模式绝对禁止 agent:spawn；
 * - 深度达到或超过 maxDepth 时绝对禁止继续派生子代理。
 *
 * 何时失败：
 * - custom 角色未提供 allowedTools（CONFIG_INVALID）；
 * - 包含不可委派的未知工具名（TOOL_NOT_DELEGATABLE）；
 * - 子执行目录越出父工作区根范围（WORKSPACE_ESCAPE）；
 * - 父处于 Plan 模式且尝试申请破坏性能力（PERMISSION_DENIED）；
 * - 角色名称未知（CONFIG_INVALID）。
 */
export function deriveChildPolicy(
  parent: ParentPolicySnapshot,
  grant: ChildGrant,
): DerivedChildPolicy {
  const preset = getRolePreset(grant.role);

  // 1. 深度校验与派生深度
  const configuredMax = Math.min(
    parent.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH,
    HARD_LIMIT_MAX_SUBAGENT_DEPTH,
  );
  const derivedDepth = parent.currentDepth + 1;

  // 2. 模式轴求交（只能更严格，不可更宽松）
  const derivedMode = tightenMode(parent.mode, grant.mode);

  // 3. 场景模型角色路由
  let preferredRole: PrimaryModelRole;
  if (preset.preferredRole === 'inherit') {
    preferredRole = parent.currentPrimaryRole ?? 'default';
  } else {
    preferredRole = preset.preferredRole;
  }

  // 4. 工作区与执行目录校验（必须在父 workspaceRoot 内部）
  const canonicalWorkspace = toNativePhysicalPath(parent.workspaceRoot);
  let canonicalCwd: string;
  if (grant.executionCwd) {
    if (!isPathInside(canonicalWorkspace, grant.executionCwd)) {
      throw new KapibalaError(
        `Child executionCwd "${grant.executionCwd}" escapes parent workspace "${canonicalWorkspace}"`,
        {
          code: 'WORKSPACE_ESCAPE',
          safeMessage: '子代理执行目录越出工作区根范围',
        },
      );
    }
    canonicalCwd = toNativePhysicalPath(grant.executionCwd);
  } else {
    canonicalCwd = toNativePhysicalPath(parent.executionCwd);
  }

  // 5. 能力轴求交
  // 父有效能力集：从父可用工具声明的能力推断
  const parentCapabilities = new Set<Capability>();
  const parentToolMap = new Map<string, Capability[]>();

  for (const tool of parent.availableTools ?? []) {
    const name = typeof tool === 'string' ? tool : tool.name;
    const perms =
      typeof tool === 'object' && tool && 'metadata' in tool && tool.metadata?.permissions
        ? tool.metadata.permissions
        : [];
    if (name) {
      parentToolMap.set(name, [...perms]);
    }
    for (const p of perms) {
      parentCapabilities.add(p);
    }
  }

  // 角色预设允许能力
  const roleAllowedCaps = new Set<Capability>(preset.allowedCapabilities);
  // 角色预设绝对禁止能力
  const roleDisallowedCaps = new Set<Capability>(preset.disallowedCapabilities);

  // 若显式传入 allowedCapabilities，取交集；否则使用角色预设
  let candidateCaps: Set<Capability>;
  if (grant.allowedCapabilities) {
    candidateCaps = new Set(grant.allowedCapabilities.filter((c) => roleAllowedCaps.has(c)));
  } else {
    candidateCaps = new Set(roleAllowedCaps);
  }

  // 剔除角色绝对禁止的能力
  for (const dis of roleDisallowedCaps) {
    candidateCaps.delete(dis);
  }

  // 若处于 Plan 模式，绝对只允许 fs:read，剔除所有其他能力
  if (derivedMode === 'Plan') {
    for (const c of Array.from(candidateCaps)) {
      if (c !== 'fs:read') {
        candidateCaps.delete(c);
      }
    }
  }

  // 深度达到或超过上限，强制剔除 agent:spawn 能力
  const reachedDepthLimit = derivedDepth >= configuredMax;
  if (reachedDepthLimit) {
    candidateCaps.delete('agent:spawn');
  }

  // 6. 工具轴求交与防伪造检查
  if (preset.requireExplicitTools) {
    if (!grant.allowedTools || !Array.isArray(grant.allowedTools)) {
      throw new KapibalaError(
        `Role "${grant.role}" requires an explicit "allowedTools" whitelist array`,
        {
          code: 'CONFIG_INVALID',
          safeMessage: `角色 "${grant.role}" 必须显式提供 allowedTools 工具白名单`,
        },
      );
    }
  }

  let derivedTools: string[];

  if (!preset.allowTools) {
    // advisor 角色工具严格为空
    derivedTools = [];
  } else {
    // 校验 grant.allowedTools 中的每一个工具是否都存在于父可用工具中
    if (grant.allowedTools !== undefined) {
      for (const reqTool of grant.allowedTools) {
        if (!parentToolMap.has(reqTool)) {
          throw new KapibalaError(
            `Requested tool "${reqTool}" is unknown or not delegatable from parent`,
            {
              code: 'TOOL_NOT_DELEGATABLE',
              safeMessage: `请求的工具 "${reqTool}" 未知或不可从父级委派`,
            },
          );
        }
      }
    }

    // 计算候选工具名
    const availableToolNames = Array.from(parentToolMap.keys());
    const baseNames = grant.allowedTools !== undefined ? grant.allowedTools : availableToolNames;

    // 过滤：
    // a. 必须在 baseNames 内
    // b. 必须在父可用列表内
    // c. 工具所需的所有 capabilities 必须被 candidateCaps 允许
    // d. 若达到深度上限或 Plan 模式，绝对排除 spawn_agent 工具
    derivedTools = baseNames.filter((toolName) => {
      const perms = parentToolMap.get(toolName);
      if (!perms) return false;

      // 深度上限或 Plan 模式拦截派生工具
      if ((reachedDepthLimit || derivedMode === 'Plan') && toolName === 'spawn_agent') {
        return false;
      }

      // 如果工具声明了权限，所有所需权限必须都在 candidateCaps 中
      if (perms.length > 0 && !perms.every((p) => candidateCaps.has(p))) {
        return false;
      }

      return true;
    });
  }

  // 7. 规则轴求交（祖先 deny 规则并集 + 祖先 ask 保留 + 子追加规则）
  const mergedRules: PermissionRule[] = [];

  // 继承父规则中的 deny 与 ask
  for (const rule of parent.rules ?? []) {
    if (rule.action === 'deny' || rule.action === 'ask') {
      mergedRules.push({ ...rule });
    }
  }

  // 追加子 grant 规则（只允许追加 deny 或 ask，不能削弱祖先）
  if (grant.permissionRules) {
    for (const rule of grant.permissionRules) {
      mergedRules.push({ ...rule });
    }
  }

  // 8. 预算与限额收紧
  const maxSteps = Math.min(
    grant.limits?.maxSteps ?? DEFAULT_CHILD_LIMITS.maxSteps,
    parent.limits?.maxSteps ?? DEFAULT_CHILD_LIMITS.maxSteps,
  );
  const timeoutMs = Math.min(
    grant.limits?.timeoutMs ?? DEFAULT_CHILD_LIMITS.timeoutMs,
    parent.limits?.timeoutMs ?? DEFAULT_CHILD_LIMITS.timeoutMs,
  );

  const limits: ChildLimits = {
    maxSteps: Math.max(1, maxSteps),
    timeoutMs: Math.max(1000, timeoutMs),
  };

  const canSpawnSubagent =
    !reachedDepthLimit &&
    derivedMode !== 'Plan' &&
    candidateCaps.has('agent:spawn') &&
    derivedTools.includes('spawn_agent');

  return {
    mode: derivedMode,
    rules: Object.freeze(mergedRules),
    allowedTools: Object.freeze(derivedTools),
    allowedCapabilities: Object.freeze(Array.from(candidateCaps)),
    executionCwd: canonicalCwd,
    depth: derivedDepth,
    preferredRole,
    canSpawnSubagent,
    limits: Object.freeze(limits),
  };
}
