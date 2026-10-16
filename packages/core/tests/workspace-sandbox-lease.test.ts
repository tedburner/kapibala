/**
 * @fileoverview 工作区沙箱隔离、写租约排队互斥与超时取消单测。
 *
 * 验证：
 * 1. 同进程内多工作区沙箱独立：相对路径互不串扰，跨工作区访问严格拦截；
 * 2. 共享工作区写租约排队互斥：先来先得、释放唤醒、异工作区并发无阻；
 * 3. 排队取消与超时保护：AbortSignal 与 timeout 安全移出队列，不影响后续唤醒；
 * 4. 写操作识别（isWriteOperation）与 ToolExecutor 自动获取/释放写租约。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WorkspaceLeaseCoordinator,
  type WorkspaceWriteLease,
  isWriteOperation,
} from '../src/capabilities/security/lease.js';
import { PathSandbox } from '../src/capabilities/security/sandbox.js';
import { type Tool, defineTool } from '../src/capabilities/tools/index.js';
import { ToolRegistry } from '../src/capabilities/tools/registry.js';
import { toNativePhysicalPath } from '../src/context/workspace.js';
import { HookRegistry } from '../src/extensibility/hooks/registry.js';
import { ToolExecutor } from '../src/runtime/executor/index.js';

describe('工作区沙箱隔离与写租约排队互斥', () => {
  let tempBaseDir: string;
  let workspaceA: string;
  let workspaceB: string;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-sandbox-lease-'));
    workspaceA = path.join(tempBaseDir, 'ws-a');
    workspaceB = path.join(tempBaseDir, 'ws-b');
    fs.mkdirSync(workspaceA, { recursive: true });
    fs.mkdirSync(workspaceB, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {
      // 忽略清理异常
    }
  });

  describe('PathSandbox 多工作区物理隔离', () => {
    it('两工作区独立沙箱解析相对路径互不串扰', () => {
      const sandboxA = new PathSandbox({ workspaceRoot: workspaceA });
      const sandboxB = new PathSandbox({ workspaceRoot: workspaceB });

      const resolvedA = sandboxA.resolveSafePath('config/app.json');
      const resolvedB = sandboxB.resolveSafePath('config/app.json');

      const nativeA = toNativePhysicalPath(workspaceA);
      const nativeB = toNativePhysicalPath(workspaceB);

      expect(resolvedA.toLowerCase()).toBe(path.join(nativeA, 'config', 'app.json').toLowerCase());
      expect(resolvedB.toLowerCase()).toBe(path.join(nativeB, 'config', 'app.json').toLowerCase());
      expect(resolvedA.toLowerCase()).not.toBe(resolvedB.toLowerCase());
    });

    it('沙箱 A 拒绝访问沙箱 B 内部的文件路径（越界拦截）', () => {
      const sandboxA = new PathSandbox({ workspaceRoot: workspaceA });
      const fileInB = path.join(workspaceB, 'secret.key');
      fs.writeFileSync(fileInB, 'confidential');

      // 无论以相对路径还是绝对路径越界，都应被拦截
      expect(() => sandboxA.resolveSafePath(fileInB)).toThrowError();
      expect(() => sandboxA.resolveSafePath('../ws-b/secret.key')).toThrowError();
    });
  });

  describe('WorkspaceLeaseCoordinator 写租约排队互斥', () => {
    it('同一工作区排队互斥，先持有者释放后唤醒下一个排队者', async () => {
      const coordinator = new WorkspaceLeaseCoordinator();

      expect(coordinator.isLocked(workspaceA)).toBe(false);

      const lease1 = await coordinator.acquire(workspaceA, 'agent-1');
      expect(coordinator.isLocked(workspaceA)).toBe(true);
      expect(coordinator.getActiveLease(workspaceA)?.ownerId).toBe('agent-1');

      let agent2Acquired = false;
      const agent2Promise = coordinator.acquire(workspaceA, 'agent-2').then((lease) => {
        agent2Acquired = true;
        return lease;
      });

      // 此时 agent 2 必须在排队中，尚未获取租约
      expect(agent2Acquired).toBe(false);

      // agent 1 释放
      lease1.release();

      const lease2 = await agent2Promise;
      expect(agent2Acquired).toBe(true);
      expect(coordinator.getActiveLease(workspaceA)?.ownerId).toBe('agent-2');

      // agent 2 释放
      lease2.release();
      expect(coordinator.isLocked(workspaceA)).toBe(false);
    });

    it('异工作区并发获取写租约互不阻塞', async () => {
      const coordinator = new WorkspaceLeaseCoordinator();

      const leaseA = await coordinator.acquire(workspaceA, 'agent-a');
      const leaseB = await coordinator.acquire(workspaceB, 'agent-b');

      expect(coordinator.isLocked(workspaceA)).toBe(true);
      expect(coordinator.isLocked(workspaceB)).toBe(true);
      expect(coordinator.getActiveLease(workspaceA)?.ownerId).toBe('agent-a');
      expect(coordinator.getActiveLease(workspaceB)?.ownerId).toBe('agent-b');

      leaseA.release();
      expect(coordinator.isLocked(workspaceA)).toBe(false);
      expect(coordinator.isLocked(workspaceB)).toBe(true);

      leaseB.release();
      expect(coordinator.isLocked(workspaceB)).toBe(false);
    });

    it('支持 AbortSignal 取消排队，安全移出队列且不影响后续排队者唤醒', async () => {
      const coordinator = new WorkspaceLeaseCoordinator();

      const lease1 = await coordinator.acquire(workspaceA, 'agent-1');

      const controller = new AbortController();
      const cancelPromise = coordinator.acquire(workspaceA, 'agent-cancel', {
        signal: controller.signal,
      });

      let agent3Acquired = false;
      const agent3Promise = coordinator.acquire(workspaceA, 'agent-3').then((lease) => {
        agent3Acquired = true;
        return lease;
      });

      // 取消 agent-cancel
      controller.abort();
      await expect(cancelPromise).rejects.toThrowError();

      // 释放 lease1，agent-3 必须被正常唤醒
      lease1.release();
      const lease3 = await agent3Promise;
      expect(agent3Acquired).toBe(true);
      expect(coordinator.getActiveLease(workspaceA)?.ownerId).toBe('agent-3');

      lease3.release();
      expect(coordinator.isLocked(workspaceA)).toBe(false);
    });

    it('支持超时保护，超时后安全移出队列并抛出 LEASE_TIMEOUT', async () => {
      const coordinator = new WorkspaceLeaseCoordinator();

      const lease1 = await coordinator.acquire(workspaceA, 'agent-1');

      const timeoutPromise = coordinator.acquire(workspaceA, 'agent-timeout', {
        timeoutMs: 40,
      });

      await expect(timeoutPromise).rejects.toThrowError(/timed out/i);

      // lease1 释放后无其他排队者，直接恢复非锁定状态
      lease1.release();
      expect(coordinator.isLocked(workspaceA)).toBe(false);
    });

    it('withWriteLease 在操作抛错时依然安全在 finally 释放写租约', async () => {
      const coordinator = new WorkspaceLeaseCoordinator();

      await expect(
        coordinator.withWriteLease(workspaceA, 'agent-fail', async () => {
          expect(coordinator.isLocked(workspaceA)).toBe(true);
          throw new Error('boom');
        }),
      ).rejects.toThrowError('boom');

      expect(coordinator.isLocked(workspaceA)).toBe(false);
    });
  });

  describe('isWriteOperation 判定规则', () => {
    it('正确区分内置读工具与写工具', () => {
      const readTool = defineTool({
        name: 'read_file',
        description: 'Read file',
        parameters: { type: 'object' },
        metadata: { source: 'builtin', permissions: ['fs:read'], readOnlyHint: true },
        execute: async () => 'content',
      });

      const writeTool = defineTool({
        name: 'write_file',
        description: 'Write file',
        parameters: { type: 'object' },
        metadata: { source: 'builtin', permissions: ['fs:write'] },
        execute: async () => 'ok',
      });

      const cmdTool = defineTool({
        name: 'run_command',
        description: 'Run command',
        parameters: { type: 'object' },
        metadata: { source: 'builtin', permissions: ['exec'] },
        execute: async () => ({ exitCode: 0 }),
      });

      expect(isWriteOperation(readTool)).toBe(false);
      expect(isWriteOperation(writeTool)).toBe(true);
      expect(isWriteOperation(cmdTool)).toBe(true);
    });

    it('外部 MCP 工具未声明 readOnlyHint 默认视为写操作，声明后视为只读', () => {
      const mcpWrite = defineTool({
        name: 'mcp_db_update',
        description: 'Update db',
        parameters: { type: 'object' },
        metadata: { source: 'mcp:db' },
        execute: async () => 'updated',
      });

      const mcpReadOnly = defineTool({
        name: 'mcp_db_query',
        description: 'Query db',
        parameters: { type: 'object' },
        metadata: { source: 'mcp:db', readOnlyHint: true },
        execute: async () => 'rows',
      });

      expect(isWriteOperation(mcpWrite)).toBe(true);
      expect(isWriteOperation(mcpReadOnly)).toBe(false);
    });
  });

  describe('ToolExecutor 中写租约自动协同执行', () => {
    it('执行写工具时自动持有写租约并在完成时释放', async () => {
      const coordinator = new WorkspaceLeaseCoordinator();
      const tools = new ToolRegistry();

      let writeToolStarted = false;
      let checkLockedDuringExecution = false;

      tools.register(
        defineTool({
          name: 'custom_write',
          description: 'write test',
          parameters: { type: 'object' },
          metadata: { permissions: ['fs:write'] },
          execute: async () => {
            writeToolStarted = true;
            checkLockedDuringExecution = coordinator.isLocked(workspaceA);
            return 'written';
          },
        }),
      );

      const executor = new ToolExecutor({
        tools,
        hooks: new HookRegistry(),
        workspaceRoot: workspaceA,
        rootDir: workspaceA,
        leaseCoordinator: coordinator,
        mode: 'FullAccess',
      });

      const [result] = await executor.runAll([
        { type: 'tool_use', id: 'call-1', name: 'custom_write', input: {} },
      ]);

      expect(result.isError).toBe(false);
      expect(writeToolStarted).toBe(true);
      expect(checkLockedDuringExecution).toBe(true);
      // 执行完毕后租约安全释放
      expect(coordinator.isLocked(workspaceA)).toBe(false);
    });

    it('执行读工具时不占用写租约', async () => {
      const coordinator = new WorkspaceLeaseCoordinator();
      const tools = new ToolRegistry();

      let checkLockedDuringExecution = true;

      tools.register(
        defineTool({
          name: 'custom_read',
          description: 'read test',
          parameters: { type: 'object' },
          metadata: { source: 'builtin', permissions: ['fs:read'], readOnlyHint: true },
          execute: async () => {
            checkLockedDuringExecution = coordinator.isLocked(workspaceA);
            return 'data';
          },
        }),
      );

      const executor = new ToolExecutor({
        tools,
        hooks: new HookRegistry(),
        workspaceRoot: workspaceA,
        rootDir: workspaceA,
        leaseCoordinator: coordinator,
        mode: 'FullAccess',
      });

      const [result] = await executor.runAll([
        { type: 'tool_use', id: 'call-2', name: 'custom_read', input: {} },
      ]);

      expect(result.isError).toBe(false);
      expect(checkLockedDuringExecution).toBe(false);
      expect(coordinator.isLocked(workspaceA)).toBe(false);
    });
  });
});
