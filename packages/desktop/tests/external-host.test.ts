import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopHost } from '../src/agent-host/desktop-host.js';
import type { Notification, Output } from '../src/shared/contracts.js';

const fakeAcpScript = fileURLToPath(
  new URL('../../host/tests/fixtures/fake-acp-agent.mjs', import.meta.url),
);

const homes: string[] = [];
const hosts: DesktopHost[] = [];

afterEach(async () => {
  for (const h of hosts.splice(0)) {
    await h.disconnect().catch(() => {});
  }
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('DesktopHost external.* IPC 契约与 LatestSnapshot 通知桥接', () => {
  it('拒绝未信任工作区，并在信任工作区完整跑通草稿测试、自定义代理保存、会话订阅、异步 Prompt 与审批闭环', async () => {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-desk-ext-')));
    homes.push(home);
    const events: Notification[] = [];
    const host = new DesktopHost(home, async (event) => {
      events.push(event);
    });
    hosts.push(host);

    const untrustedDir = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-desk-ext-untrust-')),
    );
    homes.push(untrustedDir);
    const untrustedWs = host.workspaces.registerProject(untrustedDir);
    await expect(host.dispatch('external.list', { workspaceId: untrustedWs.id })).rejects.toThrow(
      /TRUST_REQUIRED/,
    );

    const ws = host.workspaces.openDefault();
    host.workspaces.confirm(ws.id, ws.trustToken, true);

    // 1. 保存前草稿测试握手（支持用户在新建表单中直接测通再保存）
    const draftProbe = (await host.dispatch('external.testHarness', {
      workspaceId: ws.id,
      draft: {
        name: 'Draft ACP',
        command: process.execPath,
        args: [fakeAcpScript, '--mode=normal'],
      },
    })) as Output<'external.testHarness'>;
    expect(draftProbe.status).toBe('ready');

    // 2. 保存自定义代理
    const saved = (await host.dispatch('external.saveHarness', {
      id: 'desk-fake-acp',
      builtin: false,
      name: 'Desktop Fake ACP',
      command: process.execPath,
      args: [fakeAcpScript, '--mode=normal'],
      enabled: true,
    })) as Output<'external.saveHarness'>;
    expect(saved.harnesses.some((h) => h.id === 'desk-fake-acp')).toBe(true);

    // 3. 打开外部会话并订阅 LatestSnapshot
    const opened = (await host.dispatch('external.open', {
      workspaceId: ws.id,
      harnessId: 'desk-fake-acp',
      title: '桌面外部代理审批测试',
    })) as Output<'external.open'>;
    expect(opened.session.status).toBe('idle');

    const subId = randomUUID();
    await host.dispatch('external.subscribe', {
      workspaceId: ws.id,
      sessionId: opened.session.id,
      subscriptionId: subId,
    });

    // 4. 非阻塞发起 Prompt（立即返回 running 快照，后续进度与审批经 external.snapshotChanged 推送）
    const immediate = (await host.dispatch('external.prompt', {
      workspaceId: ws.id,
      sessionId: opened.session.id,
      text: 'NEED_APPROVAL',
    })) as Output<'external.prompt'>;
    expect(immediate.session.status).toBe('running');

    await vi.waitFor(() => {
      const snaps = events.filter((e) => e.type === 'external.snapshotChanged');
      const withApr = snaps.find(
        (e) => e.type === 'external.snapshotChanged' && e.snapshot.approvals.length > 0,
      );
      expect(withApr).toBeDefined();
    });

    const aprSnap = events
      .filter(
        (e): e is Extract<Notification, { type: 'external.snapshotChanged' }> =>
          e.type === 'external.snapshotChanged',
      )
      .find((e) => e.snapshot.approvals.length > 0)!;

    await host.dispatch('external.approve', {
      workspaceId: ws.id,
      sessionId: opened.session.id,
      approvalId: aprSnap.snapshot.approvals[0]!.approvalId,
      optionId: 'allow-session',
    });

    await vi.waitFor(async () => {
      const latest = (await host.dispatch('external.snapshot', {
        workspaceId: ws.id,
        sessionId: opened.session.id,
      })) as Output<'external.snapshot'>;
      expect(latest.session.status).toBe('idle');
      expect(latest.messages).toHaveLength(2);
    });

    // 5. 关闭外部会话后仍可读取只读归档快照
    await host.dispatch('external.close', {
      workspaceId: ws.id,
      sessionId: opened.session.id,
    });
    const closedSnap = (await host.dispatch('external.snapshot', {
      workspaceId: ws.id,
      sessionId: opened.session.id,
    })) as Output<'external.snapshot'>;
    expect(closedSnap.session.status).toBe('ended');
    expect(closedSnap.session.hasArchive).toBe(true);
    expect(closedSnap.messages).toHaveLength(2);
  });
});
