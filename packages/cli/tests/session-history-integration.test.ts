import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentSession,
  type ManagedSession,
  SessionManager,
  type Tool,
  builtinTools,
} from '@kiturone/kapibala';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScriptedProvider, findDanglingToolUses } from '../../core/tests/helpers/mock.js';
import { ActiveSessionController } from '../src/active-session.js';
import { COMMAND_CATALOG } from '../src/commands/catalog.js';
import { type CommandContext, CommandDispatcher } from '../src/commands/dispatcher.js';
import {
  historyCommand,
  newCommand,
  renameCommand,
  resumeCommand,
} from '../src/commands/history.js';
import { openStartupSession } from '../src/session-startup.js';

const profile = {
  id: 'test',
  name: 'test',
  modelName: 'test',
  provider: 'openai-compatible' as const,
  baseURL: 'http://127.0.0.1:9',
  apiKeyEnv: 'NONE',
  contextWindow: '32K' as const,
};
describe('persistent history and CLI continuation', () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-history-e2e-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const manager = () =>
    new SessionManager({ cwd: directory, homeDirectory: path.join(directory, 'home') });

  it('never carries session approval choices into a newly created or resumed session', async () => {
    const sessions = manager();
    const handle = await sessions.create();
    let approvals = 0;
    let callSequence = 0;
    const factory = async (target: ManagedSession) => {
      const provider = new ScriptedProvider(
        Array.from({ length: 2 }, () => [
          [
            {
              type: 'tool_call_finish' as const,
              id: `write-${++callSequence}`,
              name: 'write_file',
              input: { path: 'approval.txt', content: 'same' },
            },
            { type: 'message_stop' as const },
          ],
          [{ type: 'text_delta' as const, text: 'done' }, { type: 'message_stop' as const }],
        ]).flat(),
      );
      const session = new AgentSession({
        defaultProfile: profile,
        defaultProvider: provider,
        store: target.store,
        rootDir: directory,
        mode: 'Approval',
        loggingDirectory: path.join(directory, 'logs'),
        approvalChannel: {
          async requestApproval() {
            approvals++;
            return 'allow_session';
          },
        },
      });
      for (const tool of builtinTools) session.tools.register(tool);
      return session;
    };
    const initial = await factory(handle);
    await initial.init();
    const active = new ActiveSessionController({
      manager: sessions,
      factory,
      current: { handle, session: initial },
    });
    for await (const _ of active.run('first write')) {
    }
    for await (const _ of active.run('same exact write')) {
    }
    expect(approvals).toBe(1);
    await active.newSession();
    for await (const _ of active.run('new session write')) {
    }
    expect(approvals).toBe(2);
    await active.resume(handle.conversationId);
    for await (const _ of active.run('resumed session write')) {
    }
    expect(approvals).toBe(3);
    await active.close();
  });
  it('isolates default starts, falls back for empty continue and never creates on invalid resume', async () => {
    const sessions = manager();
    const a = await openStartupSession(sessions, {});
    const b = await openStartupSession(sessions, {});
    expect(a.conversationId).not.toBe(b.conversationId);
    await expect(openStartupSession(sessions, { resume: 'missing' })).rejects.toThrow();
    await expect(
      openStartupSession(sessions, { continue: true, resume: a.conversationId }),
    ).rejects.toThrow();
    expect((await sessions.list()).total).toBe(2);
    const c = await openStartupSession(sessions, { continue: true });
    expect(c.conversationId).not.toBe(a.conversationId);
    await a.store.append({ role: 'user', content: [{ type: 'text', text: 'continue me' }] });
    expect((await openStartupSession(sessions, { continue: true })).conversationId).toBe(
      a.conversationId,
    );
    await sessions.close();
  });
  it('A tools → B → resume A → compact → restart A preserves transactions and never replays writes', async () => {
    const sessions = manager();
    const a = await sessions.create();
    let writeCalls = 0;
    const summary = new ScriptedProvider([
      [
        {
          type: 'text_delta',
          text: JSON.stringify({
            schemaVersion: 1,
            goal: 'continue file work',
            constraints: ['keep verified file'],
            decisions: [],
            completedWork: ['created file'],
            pendingWork: [],
            references: [],
            unknownEffects: [],
          }),
        },
        {
          type: 'message_stop',
          finishReason: 'stop',
          usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
        },
      ],
    ]);
    const factory = async (handle: ManagedSession) => {
      const first =
        handle.conversationId === a.conversationId && (await handle.store.load()).length === 0;
      const provider = new ScriptedProvider(
        first
          ? [
              [
                {
                  type: 'tool_call_finish',
                  id: 'write-a',
                  name: 'write_file',
                  input: { path: 'result.txt', content: 'verified' },
                },
                { type: 'message_stop' },
              ],
              [{ type: 'text_delta', text: 'verified '.repeat(1500) }, { type: 'message_stop' }],
              [{ type: 'text_delta', text: 'recent answer' }, { type: 'message_stop' }],
            ]
          : [[{ type: 'text_delta', text: 'continued' }, { type: 'message_stop' }]],
      );
      const session = new AgentSession({
        defaultProfile: profile,
        defaultProvider: provider,
        store: handle.store,
        rootDir: directory,
        mode: 'Auto',
        loggingDirectory: path.join(directory, 'logs'),
      });
      for (const tool of builtinTools as Tool[]) {
        session.tools.register(
          tool.name === 'write_file'
            ? {
                ...tool,
                execute: async (input, ctx) => {
                  writeCalls++;
                  return tool.execute(input, ctx);
                },
              }
            : tool,
        );
      }
      session.switchModel(profile, 'summary', summary);
      return session;
    };
    const initial = await factory(a);
    await initial.init();
    const active = new ActiveSessionController({
      manager: sessions,
      factory,
      current: { handle: a, session: initial },
    });
    for await (const _ of active.run('create file, retain constraints')) {
    }
    for await (const _ of active.run('second interaction')) {
    }
    const before = active.session.getHistory();
    expect(writeCalls).toBe(1);
    expect(fs.readFileSync(path.join(directory, 'result.txt'), 'utf8')).toBe('verified');
    expect(findDanglingToolUses(before)).toEqual([]);
    await active.newSession();
    for await (const _ of active.run('B isolated')) {
    }
    await active.resume(a.conversationId);
    expect(active.session.getHistory()).toEqual(before);
    const events = [];
    for await (const event of active.compact()) events.push(event);
    expect(events.some((e) => e.type === 'compaction_finish' && e.kind === 'summary')).toBe(true);
    const projection = active.session.getContextHistory();
    expect(active.session.getHistory()).toEqual(before);
    await active.close();
    const restoredManager = manager();
    const restored = await openStartupSession(restoredManager, { resume: a.conversationId });
    const resumed = await factory(restored);
    await resumed.init();
    expect(resumed.getContextHistory()).toEqual(projection);
    expect(resumed.getStats().summaryUsage?.totalTokens).toBe(130);
    for await (const _ of resumed.run('continue after restart')) {
    }
    expect(writeCalls).toBe(1);
    expect(findDanglingToolUses(resumed.getHistory())).toEqual([]);
    await resumed.destroy();
    await restoredManager.close();
  });
  it('paginates the TTY resume menu and cancellation preserves the active session', async () => {
    const sessions = manager();
    const handle = await sessions.create();
    for (let i = 0; i < 24; i++) await sessions.create();
    const provider = new ScriptedProvider([]);
    const factory = async (target: ManagedSession) =>
      new AgentSession({
        defaultProfile: profile,
        defaultProvider: provider,
        store: target.store,
        rootDir: directory,
        loggingDirectory: path.join(directory, 'logs'),
      });
    const session = await factory(handle);
    await session.init();
    const active = new ActiveSessionController({
      manager: sessions,
      factory,
      current: { handle, session },
    });
    const select = vi.fn().mockResolvedValueOnce('__next').mockResolvedValueOnce(null);
    const ctx = { session, controller: active, select } as unknown as CommandContext;
    const descriptors = [process.stdin, process.stdout].map((stream) =>
      Object.getOwnPropertyDescriptor(stream, 'isTTY'),
    );
    for (const stream of [process.stdin, process.stdout])
      Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
    try {
      await resumeCommand([], ctx);
      expect(select).toHaveBeenCalledTimes(2);
      expect(select.mock.calls[0][0].message).toContain('1/2');
      expect(select.mock.calls[0][0].options).toHaveLength(21);
      expect(select.mock.calls[1][0].message).toContain('2/2');
      expect(select.mock.calls[1][0].options).toHaveLength(6);
      expect(active.session).toBe(session);
      expect(provider.requests).toHaveLength(0);
    } finally {
      [process.stdin, process.stdout].forEach((stream, i) => {
        const descriptor = descriptors[i];
        if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
        else Reflect.deleteProperty(stream, 'isTTY');
      });
      await active.close();
    }
  });

  it('commands retain old files, preserve title tails and never send invalid slash input to a model', async () => {
    const sessions = manager();
    const handle = await sessions.create();
    const factory = async (target: ManagedSession) =>
      new AgentSession({
        defaultProfile: profile,
        defaultProvider: new ScriptedProvider([]),
        store: target.store,
        rootDir: directory,
        loggingDirectory: path.join(directory, 'logs'),
      });
    const session = await factory(handle);
    await session.init();
    const active = new ActiveSessionController({
      manager: sessions,
      factory,
      current: { handle, session },
    });
    const dispatcher = new CommandDispatcher();
    const handlers = {
      new: newCommand,
      resume: resumeCommand,
      history: historyCommand,
      rename: renameCommand,
    };
    for (const definition of COMMAND_CATALOG.filter((d) => d.name in handlers))
      dispatcher.registerDefinition(definition, handlers[definition.name as keyof typeof handlers]);
    const ctx = {
      get session() {
        return active.session;
      },
      controller: active,
      dispatcher,
      onExit() {},
    } as CommandContext;
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await dispatcher.dispatch('/rename complete   title', ctx);
    expect((await sessions.list()).items[0].title).toBe('complete   title');
    await dispatcher.dispatch('/clear', ctx);
    expect(fs.existsSync(handle.store.filePath)).toBe(true);
    await dispatcher.dispatch(`/resume ${handle.conversationId}`, ctx);
    expect(active.session.conversationId).toBe(handle.conversationId);
    const before = active.session.getHistory();
    for (const command of ['/history -1', '/resume one two', '/unknown'])
      expect(await dispatcher.dispatch(command, ctx)).toBe(true);
    await dispatcher.dispatch('/resume', ctx);
    expect(active.session.getHistory()).toEqual(before);
    expect(output.mock.calls.flat().join('\n')).not.toContain('\u001b');
    await active.close();
  });
});
