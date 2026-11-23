import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ServerConfig,
  ServerStartApprovalDecision,
  ServerStartupDescriptor,
} from '@kiturone/kapibala-mcp';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MCP_APPROVAL_FILE,
  McpServerApprovalStore,
  createApprovedStartAuthorizer,
  digestServerConfig,
} from '../src/host/resource/mcp-approval.js';

const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return fs.realpathSync.native(dir);
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** 构造一个含密钥面的 stdio 配置；摘要应覆盖命令、参数与环境变量键值。 */
function stdioConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'server'],
    env: { API_KEY: 'super-secret-value' },
    ...overrides,
  } as ServerConfig;
}

function descriptor(name = 'demo'): ServerStartupDescriptor {
  return { serverName: name, source: 'global', type: 'stdio', target: 'npx' };
}

describe('McpServerApprovalStore', () => {
  it('批准后状态为已批准，记录只保存摘要不保存密钥值', () => {
    const home = temp('kpbl-mcp-approval-');
    const store = new McpServerApprovalStore({ homeDir: home });
    const target = { name: 'demo', source: 'global' as const, config: stdioConfig() };
    expect(store.status(target).approved).toBe(false);
    store.approve(target);
    expect(store.status(target).approved).toBe(true);
    const file = path.join(home, '.kapibala', MCP_APPROVAL_FILE);
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('super-secret-value');
    expect(raw).toContain(digestServerConfig(stdioConfig()).replace('sha256:', ''));
  });

  it('任一配置字段变化即重新待批准', () => {
    const home = temp('kpbl-mcp-approval-drift-');
    const store = new McpServerApprovalStore({ homeDir: home });
    store.approve({ name: 'demo', source: 'global', config: stdioConfig() });
    const changedEnv = stdioConfig({ env: { API_KEY: 'rotated-value' } } as Partial<ServerConfig>);
    expect(store.status({ name: 'demo', source: 'global', config: changedEnv }).approved).toBe(
      false,
    );
    const changedArgs = stdioConfig({ args: ['-y', 'server', '--debug'] } as Partial<ServerConfig>);
    expect(store.status({ name: 'demo', source: 'global', config: changedArgs }).approved).toBe(
      false,
    );
  });

  it('项目级批准按项目根隔离，撤销只影响本项目', () => {
    const home = temp('kpbl-mcp-approval-project-');
    const projectA = temp('kpbl-mcp-approval-a-');
    const projectB = temp('kpbl-mcp-approval-b-');
    const storeA = new McpServerApprovalStore({ homeDir: home, projectRoot: projectA });
    const storeB = new McpServerApprovalStore({ homeDir: home, projectRoot: projectB });
    const target = { name: 'repo', source: 'project' as const, config: stdioConfig() };
    storeA.approve(target);
    expect(storeA.status(target).approved).toBe(true);
    expect(storeB.status(target).approved).toBe(false);
    expect(storeA.revoke('repo', 'project')).toBe(true);
    expect(storeA.status(target).approved).toBe(false);
    expect(storeA.revoke('repo', 'project')).toBe(false);
  });

  it('批准文件损坏时按未批准处理，且不抛出', () => {
    const home = temp('kpbl-mcp-approval-corrupt-');
    fs.mkdirSync(path.join(home, '.kapibala'), { recursive: true });
    fs.writeFileSync(path.join(home, '.kapibala', MCP_APPROVAL_FILE), '{broken', 'utf8');
    const store = new McpServerApprovalStore({ homeDir: home });
    const target = { name: 'demo', source: 'global' as const, config: stdioConfig() };
    expect(store.status(target).approved).toBe(false);
    store.approve(target);
    expect(store.status(target).approved).toBe(true);
  });

  it('approve/revoke 在 owner 锁内串行：锁被占时报 BUSY 且不覆盖他人更新', () => {
    const home = temp('kpbl-mcp-approval-lock-');
    const store = new McpServerApprovalStore({ homeDir: home });
    const target = { name: 'demo', source: 'global' as const, config: stdioConfig() };
    fs.mkdirSync(path.join(home, '.kapibala'), { recursive: true });
    const lockPath = path.join(home, '.kapibala', `${MCP_APPROVAL_FILE}.lock`);
    const file = path.join(home, '.kapibala', MCP_APPROVAL_FILE);
    // 模拟另一进程（桌面端）正持有锁：本进程的 approve 立即失败，绝不抢锁。
    fs.writeFileSync(lockPath, JSON.stringify({ owner: 'other-host', pid: 999999 }));
    expect(() => store.approve(target)).toThrowError(/MCP_APPROVAL_BUSY/);
    expect(fs.existsSync(lockPath)).toBe(true);
    // 他人进程完成自己的写入后释放锁：本进程的批准追加在自己的键上，不丢他人的记录。
    fs.writeFileSync(
      file,
      `${JSON.stringify(
        {
          version: 1,
          approvals: {
            'global:other': {
              serverName: 'other',
              source: 'global',
              digest: 'sha256:other',
              approvedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    fs.unlinkSync(lockPath);
    store.approve(target);
    const records = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      approvals: Record<string, unknown>;
    };
    expect(Object.keys(records.approvals)).toContain('global:other');
    expect(Object.keys(records.approvals)).toContain('global:demo');
  });
});

describe('createApprovedStartAuthorizer', () => {
  it('已批准且摘要一致时静默放行，不调用交互授权', async () => {
    const home = temp('kpbl-mcp-gate-allow-');
    const store = new McpServerApprovalStore({ homeDir: home });
    const config = stdioConfig();
    store.approve({ name: 'demo', source: 'global', config });
    let calls = 0;
    const authorizer = createApprovedStartAuthorizer({
      store,
      entries: new Map([['demo', { source: 'global' as const, config }]]),
      fallback: async () => {
        calls++;
        return 'deny_once';
      },
    });
    expect(await authorizer(descriptor())).toBe('allow_once');
    expect(calls).toBe(0);
  });

  it('未批准时交给原授权，批准后持久化；配置变化后重新要求授权', async () => {
    const home = temp('kpbl-mcp-gate-prompt-');
    const store = new McpServerApprovalStore({ homeDir: home });
    const config = stdioConfig();
    let calls = 0;
    const decision: ServerStartApprovalDecision = 'allow_session';
    const authorizer = createApprovedStartAuthorizer({
      store,
      entries: new Map([['demo', { source: 'global' as const, config }]]),
      fallback: async () => {
        calls++;
        return decision;
      },
    });
    expect(await authorizer(descriptor())).toBe('allow_session');
    expect(calls).toBe(1);
    expect(store.status({ name: 'demo', source: 'global', config }).approved).toBe(true);

    // 摘要一致：第二次不再询问
    expect(await authorizer(descriptor())).toBe('allow_once');
    expect(calls).toBe(1);

    // 配置变化：旧批准失效，必须重新询问
    const changed = stdioConfig({ env: { API_KEY: 'rotated' } } as Partial<ServerConfig>);
    const rotated = createApprovedStartAuthorizer({
      store,
      entries: new Map([['demo', { source: 'global' as const, config: changed }]]),
      fallback: async () => {
        calls++;
        return 'deny_once';
      },
    });
    expect(await rotated(descriptor())).toBe('deny_once');
    expect(calls).toBe(2);
    expect(store.status({ name: 'demo', source: 'global', config: changed }).approved).toBe(false);
  });

  it('用户拒绝时不写入批准记录', async () => {
    const home = temp('kpbl-mcp-gate-deny-');
    const store = new McpServerApprovalStore({ homeDir: home });
    const config = stdioConfig();
    const authorizer = createApprovedStartAuthorizer({
      store,
      entries: new Map([['demo', { source: 'global' as const, config }]]),
      fallback: async () => 'deny_once',
    });
    expect(await authorizer(descriptor())).toBe('deny_once');
    expect(fs.existsSync(path.join(home, '.kapibala', MCP_APPROVAL_FILE))).toBe(false);
  });

  it('未登记条目时不静默放行也不持久化', async () => {
    const home = temp('kpbl-mcp-gate-unknown-');
    const store = new McpServerApprovalStore({ homeDir: home });
    const authorizer = createApprovedStartAuthorizer({
      store,
      entries: new Map(),
      fallback: async () => 'allow_once',
    });
    expect(await authorizer(descriptor('unknown'))).toBe('allow_once');
    expect(fs.existsSync(path.join(home, '.kapibala', MCP_APPROVAL_FILE))).toBe(false);
  });
});
