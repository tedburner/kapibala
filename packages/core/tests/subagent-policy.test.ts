/**
 * @fileoverview 子代理权限求交（ChildGrant）与角色模型路由单元测试。
 *
 * 验证：
 * 1. 角色预设与场景模型路由（explore->fast, planner->planning, implement->execution, advisor->planning, custom->inherit）；
 * 2. 逐轴求交与模式收紧（Plan 模式硬限制，子模式不得放宽）；
 * 3. 祖先 deny 规则并集继承与 ask 规则保留；
 * 4. 只读角色（explore / planner / advisor）写权限与执行权限剥离；
 * 5. custom 角色强制要求白名单与未知工具防伪造拦截（TOOL_NOT_DELEGATABLE）；
 * 6. 工作区逃逸防御（WORKSPACE_ESCAPE）；
 * 7. 派生深度熔断与 spawn_agent 剔除。
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  ROLE_PRESETS,
  deriveChildPolicy,
  getRolePreset,
  tightenMode,
} from '../src/capabilities/security/subagent-policy.js';
import type {
  ChildGrant,
  ParentPolicySnapshot,
} from '../src/capabilities/security/subagent-policy.js';

describe('子代理权限求交与角色路由 (ChildGrant & deriveChildPolicy)', () => {
  const dummyWorkspace = path.resolve('temp/workspace-root');
  const dummyCwd = path.resolve('temp/workspace-root/src');

  const standardParentTools = [
    { name: 'read_file', metadata: { permissions: ['fs:read' as const] } },
    { name: 'list_dir', metadata: { permissions: ['fs:read' as const] } },
    { name: 'write_file', metadata: { permissions: ['fs:write' as const] } },
    { name: 'edit_file', metadata: { permissions: ['fs:write' as const] } },
    { name: 'run_command', metadata: { permissions: ['exec' as const] } },
    { name: 'spawn_agent', metadata: { permissions: ['agent:spawn' as const] } },
  ];

  const defaultParentSnapshot: ParentPolicySnapshot = {
    mode: 'Approval',
    rules: [],
    availableTools: standardParentTools,
    workspaceRoot: dummyWorkspace,
    executionCwd: dummyCwd,
    currentDepth: 0,
    currentPrimaryRole: 'execution',
  };

  describe('角色预设与场景模型路由单一真源', () => {
    it('角色预设完整且包含对应首选场景', () => {
      expect(ROLE_PRESETS.explore.preferredRole).toBe('fast');
      expect(ROLE_PRESETS.planner.preferredRole).toBe('planning');
      expect(ROLE_PRESETS.implement.preferredRole).toBe('execution');
      expect(ROLE_PRESETS.advisor.preferredRole).toBe('planning');
      expect(ROLE_PRESETS.custom.preferredRole).toBe('inherit');
    });

    it('getRolePreset 命中合法角色与拒绝非法角色', () => {
      expect(getRolePreset('explore').role).toBe('explore');
      expect(() => getRolePreset('super_admin')).toThrowError(/Unknown subagent role/i);
    });

    it('custom 角色继承父级 primaryRole', () => {
      const derived = deriveChildPolicy(
        { ...defaultParentSnapshot, currentPrimaryRole: 'planning' },
        { role: 'custom', allowedTools: ['read_file'] },
      );
      expect(derived.preferredRole).toBe('planning');
    });
  });

  describe('模式收紧（tightenMode）', () => {
    it('子模式不可比父模式更宽松', () => {
      // 父为 Approval (1)，子申请 Auto (2) -> 收紧为 Approval
      expect(tightenMode('Approval', 'Auto')).toBe('Approval');
      // 父为 Auto (2)，子申请 FullAccess (3) -> 收紧为 Auto
      expect(tightenMode('Auto', 'FullAccess')).toBe('Auto');
      // 父为 Plan (0)，子申请任何模式 -> 强制为 Plan
      expect(tightenMode('Plan', 'Auto')).toBe('Plan');
      expect(tightenMode('Plan', 'FullAccess')).toBe('Plan');
      // 父为 Auto (2)，子申请更严格的 Approval (1) -> 允许收紧为 Approval
      expect(tightenMode('Auto', 'Approval')).toBe('Approval');
    });
  });

  describe('祖先规则并集继承与 Ask 保留', () => {
    it('祖先的所有 deny 与 ask 规则完整继承，子无法削弱', () => {
      const parentSnapshot: ParentPolicySnapshot = {
        ...defaultParentSnapshot,
        rules: [
          { action: 'deny', tool: 'run_command' },
          { action: 'ask', tool: 'edit_file' },
        ],
      };

      const grant: ChildGrant = {
        role: 'implement',
        permissionRules: [
          // 子代理试图添加针对 run_command 的 allow 规则
          { action: 'allow', tool: 'run_command' },
        ],
      };

      const derived = deriveChildPolicy(parentSnapshot, grant);

      // 规则列表中祖先的 deny 和 ask 必须排在前面并完整保留
      expect(derived.rules[0]).toEqual({ action: 'deny', tool: 'run_command' });
      expect(derived.rules[1]).toEqual({ action: 'ask', tool: 'edit_file' });
      expect(derived.rules.length).toBe(3);
    });
  });

  describe('只读角色与工具/能力剥离', () => {
    it('explore 角色剥离所有写操作、执行与派生能力', () => {
      const derived = deriveChildPolicy(defaultParentSnapshot, { role: 'explore' });

      expect(derived.allowedCapabilities).toContain('fs:read');
      expect(derived.allowedCapabilities).not.toContain('fs:write');
      expect(derived.allowedCapabilities).not.toContain('exec');
      expect(derived.allowedCapabilities).not.toContain('agent:spawn');

      expect(derived.allowedTools).toEqual(['read_file', 'list_dir']);
      expect(derived.preferredRole).toBe('fast');
      expect(derived.canSpawnSubagent).toBe(false);
    });

    it('planner 角色仅保留只读分析能力', () => {
      const derived = deriveChildPolicy(defaultParentSnapshot, { role: 'planner' });

      expect(derived.allowedCapabilities).toEqual(['fs:read', 'env:read']);
      expect(derived.allowedTools).toEqual(['read_file', 'list_dir']);
      expect(derived.preferredRole).toBe('planning');
    });

    it('advisor 角色工具集合严格为空', () => {
      const derived = deriveChildPolicy(defaultParentSnapshot, { role: 'advisor' });

      expect(derived.allowedCapabilities).toEqual([]);
      expect(derived.allowedTools).toEqual([]);
      expect(derived.preferredRole).toBe('planning');
    });

    it('implement 角色在父允许时可获得写与执行能力，但默认无 spawn_agent', () => {
      const derived = deriveChildPolicy(defaultParentSnapshot, { role: 'implement' });

      expect(derived.allowedCapabilities).toContain('fs:read');
      expect(derived.allowedCapabilities).toContain('fs:write');
      expect(derived.allowedCapabilities).toContain('exec');
      expect(derived.allowedCapabilities).not.toContain('agent:spawn');

      expect(derived.allowedTools).toContain('write_file');
      expect(derived.allowedTools).toContain('edit_file');
      expect(derived.allowedTools).toContain('run_command');
      expect(derived.allowedTools).not.toContain('spawn_agent');
      expect(derived.preferredRole).toBe('execution');
    });
  });

  describe('custom 角色与未知工具防伪造拦截', () => {
    it('custom 角色未提供 allowedTools 时抛出 CONFIG_INVALID', () => {
      expect(() =>
        deriveChildPolicy(defaultParentSnapshot, { role: 'custom' as any }),
      ).toThrowError(/requires an explicit "allowedTools" whitelist array/i);
    });

    it('custom 角色请求合法工具子集成功求交', () => {
      const derived = deriveChildPolicy(defaultParentSnapshot, {
        role: 'custom',
        allowedTools: ['read_file', 'write_file'],
      });

      expect(derived.allowedTools).toEqual(['read_file', 'write_file']);
    });

    it('请求父级不存在的未知工具名立即抛出 TOOL_NOT_DELEGATABLE', () => {
      expect(() =>
        deriveChildPolicy(defaultParentSnapshot, {
          role: 'custom',
          allowedTools: ['read_file', 'secret_internal_tool'],
        }),
      ).toThrowError(/Requested tool "secret_internal_tool" is unknown or not delegatable/i);
    });

    it('非 custom 角色传入显式白名单包含未知工具同样被拒绝', () => {
      try {
        deriveChildPolicy(defaultParentSnapshot, {
          role: 'explore',
          allowedTools: ['read_file', 'non_existent_tool'],
        });
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('TOOL_NOT_DELEGATABLE');
        expect(err.message).toMatch(/unknown or not delegatable/i);
      }
    });
  });

  describe('Plan 模式绝对拦截 agent:spawn 与破坏性能力', () => {
    it('父为 Plan 模式时无论子角色为何，绝对拦截 agent:spawn 与写能力', () => {
      const planParent: ParentPolicySnapshot = {
        ...defaultParentSnapshot,
        mode: 'Plan',
      };

      const derived = deriveChildPolicy(planParent, {
        role: 'implement',
      });

      expect(derived.mode).toBe('Plan');
      expect(derived.allowedCapabilities).toEqual(['fs:read']);
      expect(derived.allowedTools).toEqual(['read_file', 'list_dir']);
      expect(derived.canSpawnSubagent).toBe(false);
    });
  });

  describe('工作区与执行目录越界拦截 (WORKSPACE_ESCAPE)', () => {
    it('子执行目录位于父工作区内部时正常解析', () => {
      const subCwd = path.join(dummyWorkspace, 'packages', 'core');
      const derived = deriveChildPolicy(defaultParentSnapshot, {
        role: 'explore',
        executionCwd: subCwd,
      });

      expect(derived.executionCwd.toLowerCase()).toBe(path.resolve(subCwd).toLowerCase());
    });

    it('子执行目录越出父工作区根范围时抛出 WORKSPACE_ESCAPE', () => {
      const outsideCwd = path.resolve('temp/other-dir');
      expect(() =>
        deriveChildPolicy(defaultParentSnapshot, {
          role: 'explore',
          executionCwd: outsideCwd,
        }),
      ).toThrowError(/escapes parent workspace/i);
    });
  });

  describe('派生深度与熔断限制', () => {
    it('根会话 (depth 0) 派生子会话深度推进至 1', () => {
      const derived = deriveChildPolicy(defaultParentSnapshot, {
        role: 'custom',
        allowedTools: ['read_file', 'spawn_agent'],
      });

      expect(derived.depth).toBe(1);
      expect(derived.canSpawnSubagent).toBe(true);
      expect(derived.allowedTools).toContain('spawn_agent');
    });

    it('达到最大深度限制时强制剥离 agent:spawn 能力与工具', () => {
      // 当前深度为 2，派生后为 3，达到默认上限 3
      const deepParent: ParentPolicySnapshot = {
        ...defaultParentSnapshot,
        currentDepth: 2,
        maxDepth: 3,
      };

      const derived = deriveChildPolicy(deepParent, {
        role: 'custom',
        allowedTools: ['read_file', 'spawn_agent'],
      });

      expect(derived.depth).toBe(3);
      expect(derived.canSpawnSubagent).toBe(false);
      expect(derived.allowedTools).not.toContain('spawn_agent');
      expect(derived.allowedCapabilities).not.toContain('agent:spawn');
    });
  });

  describe('限额预算收紧', () => {
    it('子限额只能比父限额更严格，不能放宽', () => {
      const parentSnapshot: ParentPolicySnapshot = {
        ...defaultParentSnapshot,
        limits: { maxSteps: 10, timeoutMs: 120_000 },
      };

      // 子请求更大的步数 (20) 与超时 (600_000)
      const derived = deriveChildPolicy(parentSnapshot, {
        role: 'explore',
        limits: { maxSteps: 20, timeoutMs: 600_000 },
      });

      // 必须被截断为父级的严格限制
      expect(derived.limits.maxSteps).toBe(10);
      expect(derived.limits.timeoutMs).toBe(120_000);
    });

    it('子请求更严格的限额时采纳子限额', () => {
      const parentSnapshot: ParentPolicySnapshot = {
        ...defaultParentSnapshot,
        limits: { maxSteps: 15, timeoutMs: 300_000 },
      };

      const derived = deriveChildPolicy(parentSnapshot, {
        role: 'explore',
        limits: { maxSteps: 5, timeoutMs: 60_000 },
      });

      expect(derived.limits.maxSteps).toBe(5);
      expect(derived.limits.timeoutMs).toBe(60_000);
    });
  });
});
