import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { LocalClient } from '@kiturone/kapibala-host/client';
import { createUserSettingsSkeleton, trustProject } from '@kiturone/kapibala-host/internal';
import { PROTOCOL_VERSION, SERVER_CAPABILITIES } from '@kiturone/kapibala-host/protocol';
import { createStdioTransport } from '@kiturone/kapibala-host/transport';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalHostServer } from '../src/local-host/server.js';

const fakeAcpScript = fileURLToPath(
  new URL('../../host/tests/fixtures/fake-acp-agent.mjs', import.meta.url),
);

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn().catch(() => {});
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

async function createPair(options: { homeDir: string; capabilities: string[] }) {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const clientTransport = createStdioTransport(s2c, c2s);
  const serverTransport = createStdioTransport(c2s, s2c);

  const server = new LocalHostServer({
    homeDir: options.homeDir,
    create: async () => {
      throw new Error('local session not used in external test');
    },
  });
  const serverAccept = server.accept(serverTransport);
  const client = await LocalClient.connect(clientTransport, {
    protocolVersion: PROTOCOL_VERSION,
    clientName: 'ext-test-client',
    capabilities: options.capabilities,
  });

  cleanups.push(async () => {
    await client.close();
    await server.shutdown();
    await serverAccept.catch(() => {});
  });

  return { client, server };
}

describe('Wire v2 external-session 能力协商与端到端调用', () => {
  it('保持 PROTOCOL_VERSION = 2，在 SERVER_CAPABILITIES 中提供 external-session，且未声明该能力的连接拒绝调用 external/*', async () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(SERVER_CAPABILITIES).toContain('external-session');

    const homeDir = makeTempDir('kpbl-wire-ext-gate-');
    const { client } = await createPair({
      homeDir,
      capabilities: ['sessions'],
    });

    await expect(client.call('external/harnesses', {})).rejects.toThrow(/PROTOCOL_MISMATCH/);
  });

  it('声明 external-session 的连接可完成外部代理注册、探测、attach 事件流推送、审批交互与只读快照读取', async () => {
    const homeDir = makeTempDir('kpbl-wire-ext-e2e-home-');
    const workspaceRoot = makeTempDir('kpbl-wire-ext-e2e-ws-');
    trustProject(createUserSettingsSkeleton(), workspaceRoot, { homeDir });

    const { client } = await createPair({
      homeDir,
      capabilities: ['sessions', 'external-session'],
    });

    const saved = await client.call('external/harnessSave', {
      id: 'wire-fake-acp',
      builtin: false,
      name: 'Wire Fake ACP',
      command: process.execPath,
      args: [fakeAcpScript, '--mode=normal'],
      enabled: true,
    });
    expect(saved.harnesses.some((h) => h.id === 'wire-fake-acp')).toBe(true);

    const probe = await client.call('external/harnessTest', {
      id: 'wire-fake-acp',
      workspaceRoot,
    });
    expect(probe.status).toBe('ready');

    const opened = await client.call('external/open', {
      workspaceRoot,
      harnessId: 'wire-fake-acp',
      title: 'Wire 外部会话测试',
    });
    expect(opened.session.status).toBe('idle');

    const receivedStatuses: string[] = [];
    const unsub = client.subscribeExternal((evt) => {
      if (evt.sessionId !== opened.session.id) return;
      receivedStatuses.push(evt.snapshot.session.status);
      if (evt.snapshot.approvals.length > 0) {
        void client.call('external/approve', {
          sessionId: opened.session.id,
          approvalId: evt.snapshot.approvals[0]!.approvalId,
          optionId: 'allow-once',
        });
      }
    });

    await client.call('external/attach', { sessionId: opened.session.id });
    const afterPrompt = await client.call('external/prompt', {
      sessionId: opened.session.id,
      text: 'NEED_APPROVAL',
    });
    unsub();

    expect(afterPrompt.session.status).toBe('idle');
    expect(afterPrompt.messages).toHaveLength(2);
    expect(receivedStatuses).toContain('waiting_approval');

    await client.call('external/close', { sessionId: opened.session.id });
    const archivedSnap = await client.call('external/snapshot', { sessionId: opened.session.id });
    expect(archivedSnap.session.status).toBe('ended');
    expect(archivedSnap.session.hasArchive).toBe(true);
    expect(archivedSnap.messages).toHaveLength(2);
  });

  it('多客户端连接同一 LocalHostServer 时强制单控制者门禁，拒绝非控制连接抢答审批或越权关闭', async () => {
    const homeDir = makeTempDir('kpbl-wire-ext-ctrl-home-');
    const workspaceRoot = makeTempDir('kpbl-wire-ext-ctrl-ws-');
    trustProject(createUserSettingsSkeleton(), workspaceRoot, { homeDir });

    const { client: clientA, server } = await createPair({
      homeDir,
      capabilities: ['sessions', 'external-session'],
    });

    const c2sB = new PassThrough();
    const s2cB = new PassThrough();
    const serverAcceptB = server.accept(createStdioTransport(c2sB, s2cB));
    const clientB = await LocalClient.connect(createStdioTransport(s2cB, c2sB), {
      protocolVersion: PROTOCOL_VERSION,
      clientName: 'observer-client',
      capabilities: ['sessions', 'external-session'],
    });
    cleanups.push(async () => {
      await clientB.close();
      await serverAcceptB.catch(() => {});
    });

    await clientA.call('external/harnessSave', {
      id: 'ctrl-acp',
      builtin: false,
      name: 'Control ACP',
      command: process.execPath,
      args: [fakeAcpScript, '--mode=normal'],
      enabled: true,
    });

    const opened = await clientA.call('external/open', {
      workspaceRoot,
      harnessId: 'ctrl-acp',
    });

    // 观察端 clientB 可以读取只读快照，但不能越权 close / cancel / prompt 由 clientA 控制的外部会话
    const snapB = await clientB.call('external/snapshot', { sessionId: opened.session.id });
    expect(snapB.session.id).toBe(opened.session.id);
    await expect(clientB.call('external/close', { sessionId: opened.session.id })).rejects.toThrow(
      /CONTROL_REQUIRED/,
    );

    // clientA detach 释放控制权后，clientB 即可正常接管并关闭
    await clientA.call('external/detach', { sessionId: opened.session.id });
    const closedByB = await clientB.call('external/close', { sessionId: opened.session.id });
    expect(closedByB.closed).toBe(true);
  });
});
