import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime, AgentSession, SessionManager } from '@kiturone/kapibala';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResourceFactory } from '../src/local-host/resources.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const directory = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-resource-'));
  roots.push(root);
  return root;
};
const approval = { requestApproval: async () => 'cancel' as const };
const settings = (home: string) => {
  fs.mkdirSync(path.join(home, '.kapibala'));
  fs.writeFileSync(
    path.join(home, '.kapibala/settings.json'),
    JSON.stringify({
      defaultModel: 'fixture',
      permissionMode: 'Plan',
      profiles: [
        {
          id: 'fixture',
          name: 'fixture',
          provider: 'openai-compatible',
          modelName: 'fixture',
          baseURL: 'http://127.0.0.1:1/v1',
          apiKey: 'fixture-credential',
          contextWindow: 32000,
        },
      ],
    }),
  );
};

describe('headless resource factory', () => {
  it.each(['runtime', 'session'] as const)(
    'retains the storage lock when %s cleanup fails and releases it after retry',
    async (step) => {
      const home = directory();
      settings(home);
      const root = directory();
      const resource = await createResourceFactory({ homeDir: home }).create(
        root,
        undefined,
        approval,
      );
      const manager = new SessionManager({ workspaceRoot: root, homeDirectory: home });
      const cleanup =
        step === 'runtime'
          ? vi.spyOn(AgentRuntime.prototype, 'close')
          : vi.spyOn(AgentSession.prototype, 'destroy');
      cleanup.mockRejectedValueOnce(new Error('cleanup incomplete'));
      try {
        await expect(resource.dispose()).rejects.toThrow('cleanup incomplete');
        // 真实存储锁仍须阻止第二个写者；测试失败时也回收意外打开的句柄。
        let reopened: Awaited<ReturnType<SessionManager['open']>> | undefined;
        try {
          await expect(
            manager.open(resource.conversationId).then((handle) => {
              reopened = handle;
              return handle;
            }),
          ).rejects.toThrow(/Session locked/);
        } finally {
          await reopened?.release();
        }
      } finally {
        cleanup.mockRestore();
        await resource.dispose();
      }
      const reopened = await manager.open(resource.conversationId);
      await reopened.release();
    },
  );
  it('defers required MCP startup authorization until the controlled run', async () => {
    const home = directory();
    settings(home);
    fs.writeFileSync(
      path.join(home, '.kapibala/mcp.json'),
      JSON.stringify({
        mcpServers: {
          fixture: { command: process.execPath, args: ['-e', 'process.exit(0)'], required: true },
        },
      }),
    );
    let requests = 0;
    const abort = new AbortController();
    const factory = createResourceFactory({ homeDir: home });
    const session = await factory.create(directory(), undefined, {
      requestApproval: async () => {
        requests++;
        abort.abort();
        return 'deny_once';
      },
    });
    expect(requests).toBe(0);
    try {
      for await (const _ of session.run('fixture', abort.signal)) {
        /* 拒绝启动后不能发送模型请求。 */
      }
    } catch {
      /* required MCP 拒绝必须使本次运行失败。 */
    }
    expect(requests).toBe(1);
    await session.dispose();
  });
  it('opens independent sessions without changing process cwd or leaking private history', async () => {
    const home = directory();
    settings(home);
    const cwd = process.cwd();
    const factory = createResourceFactory({ homeDir: home });
    const a = await factory.create(directory(), undefined, approval);
    const b = await factory.create(directory(), undefined, approval);
    expect(a.conversationId).not.toBe(b.conversationId);
    expect(a.history()).toEqual([]);
    expect(process.cwd()).toBe(cwd);
    await a.dispose();
    await b.dispose();
  });
  it('rejects untrusted project settings before acquiring a conversation lock', async () => {
    const home = directory();
    settings(home);
    const root = directory();
    fs.mkdirSync(path.join(root, '.kapibala'));
    fs.writeFileSync(path.join(root, '.kapibala/settings.json'), '{}');
    await expect(
      createResourceFactory({ homeDir: home }).create(root, undefined, approval),
    ).rejects.toThrow(/TRUST_REQUIRED/);
    expect(fs.existsSync(path.join(home, '.kapibala/sessions'))).toBe(false);
  });
  it('maps a live conversation lock to SESSION_BUSY without stealing it', async () => {
    const home = directory();
    settings(home);
    const root = directory();
    const factory = createResourceFactory({ homeDir: home });
    const first = await factory.create(root, undefined, approval);
    try {
      await expect(factory.create(root, first.conversationId, approval)).rejects.toThrow(
        /^SESSION_BUSY$/,
      );
      expect(first.history()).toEqual([]);
    } finally {
      await first.dispose();
    }
    const reopened = await factory.create(root, first.conversationId, approval);
    expect(reopened.conversationId).toBe(first.conversationId);
    await reopened.dispose();
  });
});
