import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ServerStartupApprovalCache,
  ServerStartupCoordinator,
  type ServerStartupDescriptor,
} from '../src/auth.js';
import type { CommandTargetInfo } from '../src/path.js';

describe('MCP Server Startup Authorization, Caching & Drift Defense (Task 3.5)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-mcp-auth-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const makeDescriptor = (
    serverName: string,
    overrides?: Partial<ServerStartupDescriptor>,
  ): ServerStartupDescriptor => ({
    serverName,
    source: 'project',
    type: 'stdio',
    target: 'node',
    args: ['./server.js'],
    cwd: tempDir,
    envVarNames: ['PATH'],
    ...overrides,
  });

  it('rejects startup in non-interactive environment without approval channel', async () => {
    const coordinator = new ServerStartupCoordinator({
      isNonInteractive: true,
      // no authorizer provided
    });

    const result = await coordinator.authorize(makeDescriptor('test-server'));
    expect(result.permitted).toBe(false);
    expect(result.reason).toMatch(/Non-interactive environment/i);
  });

  it('enforces host hard denial over any interactive approval or mode', async () => {
    const askFn = vi.fn(async () => 'allow_session' as const);
    const coordinator = new ServerStartupCoordinator({
      authorizer: askFn,
      hardDenial: (desc) => {
        if (desc.serverName === 'forbidden_server') {
          return { denied: true, reason: 'Forbidden by policy rule' };
        }
      },
    });

    const result = await coordinator.authorize(makeDescriptor('forbidden_server'));
    expect(askFn).not.toHaveBeenCalled();
    expect(result.permitted).toBe(false);
    expect(result.reason).toMatch(/Forbidden by policy rule/i);
  });

  it('caches allow_session and invalidates when target drifts', async () => {
    const cache = new ServerStartupApprovalCache();
    const askFn = vi.fn(async () => 'allow_session' as const);
    const coordinator = new ServerStartupCoordinator({
      authorizer: askFn,
      cache,
    });

    const desc1 = makeDescriptor('cacheable_server', { scriptDigest: 'digest_v1' });

    // 第一次调用：触发审批并写入 allow_session
    const res1 = await coordinator.authorize(desc1);
    expect(res1.permitted).toBe(true);
    expect(askFn).toHaveBeenCalledTimes(1);

    // 第二次调用：相同摘要 -> 命中会话缓存，不再次提示
    const res2 = await coordinator.authorize(desc1);
    expect(res2.permitted).toBe(true);
    expect(askFn).toHaveBeenCalledTimes(1);

    // 第三次调用：脚本摘要漂移变为了 digest_v2 -> 缓存失效，必须重新审批！
    const desc2 = makeDescriptor('cacheable_server', { scriptDigest: 'digest_v2' });
    const res3 = await coordinator.authorize(desc2);
    expect(res3.permitted).toBe(true);
    expect(askFn).toHaveBeenCalledTimes(2);
  });

  it('serializes multiple concurrent authorization requests to avoid UI clobbering', async () => {
    const executionOrder: string[] = [];
    const askFn = vi.fn(async (desc: ServerStartupDescriptor) => {
      executionOrder.push(`start_${desc.serverName}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      executionOrder.push(`end_${desc.serverName}`);
      return 'allow_once' as const;
    });

    const coordinator = new ServerStartupCoordinator({ authorizer: askFn });

    // 并发触发 3 个 Server 的授权请求
    const p1 = coordinator.authorize(makeDescriptor('server_1'));
    const p2 = coordinator.authorize(makeDescriptor('server_2'));
    const p3 = coordinator.authorize(makeDescriptor('server_3'));

    await Promise.all([p1, p2, p3]);

    // 关键断言：审批严格串行化，前一个完全结束之后后一个才开始
    expect(executionOrder).toEqual([
      'start_server_1',
      'end_server_1',
      'start_server_2',
      'end_server_2',
      'start_server_3',
      'end_server_3',
    ]);
  });

  it('aborts startup if command target drifts after user approval', async () => {
    const scriptFile = path.join(tempDir, 'drifting_script.js');
    fs.writeFileSync(scriptFile, 'initial code');

    const realStat = fs.statSync(process.execPath);
    const commandTarget: CommandTargetInfo = {
      rawCommand: 'node',
      executablePath: process.execPath,
      size: realStat.size,
      mtimeMs: realStat.mtimeMs,
      scriptPath: scriptFile,
      scriptDigest: 'original_digest',
    };

    const askFn = vi.fn(async () => {
      // 模拟审批期间外部篡改了脚本内容
      fs.writeFileSync(scriptFile, 'tampered script content');
      return 'allow_once' as const;
    });

    const coordinator = new ServerStartupCoordinator({ authorizer: askFn });

    const result = await coordinator.authorize(makeDescriptor('drift_test'), {
      commandTarget,
    });

    expect(askFn).toHaveBeenCalledTimes(1);
    // 关键断言：批准后复核阻断
    expect(result.permitted).toBe(false);
    expect(result.reason).toMatch(/content digest changed after approval/i);
  });

  it('emits comprehensive audit records during authorization lifecycle', async () => {
    const auditEvents: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const auditFn = async (event: any, fields: Record<string, unknown>) => {
      auditEvents.push({ event, fields });
    };

    const coordinator = new ServerStartupCoordinator({
      authorizer: async () => 'deny_once',
      audit: auditFn,
    });

    const result = await coordinator.authorize(makeDescriptor('audit_server'));
    expect(result.permitted).toBe(false);

    expect(auditEvents.length).toBeGreaterThanOrEqual(3);
    expect(auditEvents.map((e) => e.event)).toEqual([
      'server.requested',
      'server.decided',
      'server.denied',
    ]);
  });
});
