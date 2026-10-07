import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession } from '@kiturone/kapibala';
import { describe, expect, it, vi } from 'vitest';
import { ScriptedProvider } from '../../core/tests/helpers/mock.js';
import { contextCommand } from '../src/commands/context.js';
import { statusCommand } from '../src/commands/status.js';

describe('readonly context snapshots', () => {
  it('queries no provider or hook, labels static/stale data, and emits ANSI only for TTY gauges', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-observe-'));
    const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const provider = new ScriptedProvider([
      [
        { type: 'text_delta', text: 'answer' },
        {
          type: 'message_stop',
          usage: { promptTokens: 30, completionTokens: 5, totalTokens: 35, cachedPromptTokens: 10 },
        },
      ],
    ]);
    const profile = {
      id: 'test',
      name: 'test',
      modelName: 'test',
      provider: 'openai-compatible' as const,
      baseURL: 'http://127.0.0.1:9',
      apiKeyEnv: 'NONE',
    };
    const session = new AgentSession({
      defaultProfile: profile,
      defaultProvider: provider,
      rootDir: directory,
      loggingDirectory: path.join(directory, 'logs'),
    });
    let hooks = 0;
    session.hooks.on('model:before', (_ctx, request) => {
      hooks++;
      return request;
    });
    try {
      await session.init();
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
      const ctx = { session } as never;
      contextCommand([], ctx);
      expect(log.mock.calls.flat().join('\n')).toContain('静态估算');
      expect(provider.requests).toHaveLength(0);
      expect(hooks).toBe(0);
      for await (const _ of session.run('question')) {
      }
      expect(hooks).toBe(1);
      log.mockClear();
      contextCommand([], ctx);
      statusCommand([], ctx);
      const plain = log.mock.calls.flat().join('\n');
      expect(plain).not.toContain('\u001b');
      expect(plain).toContain('缓存 usage: 10');
      expect(plain).toContain('窗口保守估算');
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
      log.mockClear();
      contextCommand([], ctx);
      expect(log.mock.calls.flat().join('\n')).toContain('比例条');
      session.switchModel({ ...profile, id: 'larger', contextWindow: '64K' });
      expect(session.getContextSnapshot()!.stale).toBe(true);
      log.mockClear();
      contextCommand([], ctx);
      const switched = log.mock.calls.flat().join('\n');
      expect(switched).toContain('上下文 larger | 静态估算');
      expect(switched).toContain('窗口 64000');
      expect(switched).toContain('实测最近 prompt tokens: 未知');
      expect(provider.requests).toHaveLength(1);
      expect(hooks).toBe(1);
    } finally {
      log.mockRestore();
      if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
      await session.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
