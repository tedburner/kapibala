import { PassThrough } from 'node:stream';
import type {
  AgentSession,
  ManagedSession,
  PreparedTaskContext,
  SessionEvent,
  SessionManager,
} from '@kiturone/kapibala';
import { describe, expect, it, vi } from 'vitest';
import { ActiveSessionController } from '../src/active-session.js';
import { COMMAND_CATALOG } from '../src/commands/catalog.js';
import { type CommandContext, CommandDispatcher } from '../src/commands/dispatcher.js';
import { promptCommand } from '../src/commands/prompts.js';
import { skillCommand } from '../src/commands/skills.js';
import { type HostInputPort, runInteractiveHost } from '../src/host/interactive.js';
import { CliInputCoordinator } from '../src/input-coordinator.js';
import { bindSessionMcpPlugin } from '../src/mcp.js';
import { createEventRenderer } from '../src/ui/events.js';

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

class ViewInput implements HostInputPort {
  readonly interactive = true;
  private readonly stopped = deferred();
  readonly whenClosed = this.stopped.promise;
  line: (value: string) => void = () => {};
  interrupt: () => void = () => {};
  completer: (line: string) => [string[], string] = (line) => [[], line];
  pending = false;
  draft = '';
  readonly prompts: string[] = [];
  onLine(handler: (line: string) => void) {
    this.line = handler;
  }
  onInterrupt(handler: () => void) {
    this.interrupt = handler;
    return () => {
      this.interrupt = () => {};
    };
  }
  onDetailToggle() {
    return () => {};
  }
  onInteraction() {
    return () => {};
  }
  setCompleter(handler: (line: string) => [string[], string]) {
    this.completer = handler;
  }
  isBusy() {
    return this.pending;
  }
  question = vi.fn(async () => 'answer');
  readSecret = vi.fn(async () => 'secret');
  confirm = vi.fn(async () => false);
  async select<T>(): Promise<T | null> {
    return null;
  }
  approve = vi.fn(async () => 'deny_once' as const);
  cancel = vi.fn(() => {
    this.pending = false;
  });
  close = vi.fn(() => {
    this.cancel();
    this.stopped.resolve();
  });
  prompt(value: string) {
    this.prompts.push(value);
  }
  clearLine() {
    this.draft = '';
  }
  getLine() {
    return this.draft;
  }
}

function fixture(run?: (signal?: AbortSignal) => AsyncGenerator<SessionEvent>) {
  const executions: string[] = [];
  const session = {
    conversationId: 'conversation',
    isBusy: () => false,
    getModelRole: () => 'default',
    getActiveProfile: () => ({ id: 'test' }),
    getMode: () => 'Approval',
    getPermissionRules: () => [],
    getSkills: () => ({
      skills: [{ name: 'guide', userInvocable: true, available: true, disabled: false }],
    }),
    run: async function* (task: string, options?: { signal?: AbortSignal }) {
      executions.push(`message:${task}`);
      if (run) yield* run(options?.signal);
      else yield { type: 'text_delta' as const, text: 'answer' };
    },
    runSkill: async function* (name: string, task: string) {
      executions.push(`skill:${name}:${task}`);
      yield { type: 'text_delta' as const, text: 'skill answer' };
    },
    runPreparedTask: async function* (
      task: string,
      prepare: Parameters<AgentSession['runPreparedTask']>[1],
      options?: { signal?: AbortSignal },
    ) {
      const prepared = await prepare({
        runId: 'prepared-run',
        signal: options?.signal,
        tools: {},
      } as PreparedTaskContext);
      executions.push(`prepared:${task}:${JSON.stringify(prepared.content)}`);
      yield { type: 'text_delta' as const, text: 'prompt answer' };
    },
    destroy: vi.fn(async () => {}),
  } as unknown as AgentSession;
  const release = vi.fn(async () => {});
  const controller = new ActiveSessionController({
    manager: {} as SessionManager,
    factory: async () => session,
    current: {
      session,
      handle: { conversationId: 'conversation', release } as unknown as ManagedSession,
    },
  });
  const output = { log: vi.fn(), error: vi.fn(), write: vi.fn() };
  const context: CommandContext = {
    get session() {
      return controller.session;
    },
    controller,
    settings: { defaultModel: 'test', profiles: [] },
    onModelSwitched: () => {},
    onExit: () => {},
    output,
  };
  const dispatcher = new CommandDispatcher();
  dispatcher.register('exit', (_args, ctx) => ctx.onExit());
  dispatcher.register('status', (_args, ctx) => ctx.output?.log('status result'));
  return { executions, session, controller, context, dispatcher, output, release };
}

describe('shared interactive host', () => {
  it('keeps the real controller gate until cancellation and exit cleanup have completed', async () => {
    const cleaning = deferred();
    const cleanupStarted = deferred();
    const h = fixture(async function* (signal) {
      try {
        yield { type: 'text_delta', text: 'partial' };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      } finally {
        cleanupStarted.resolve();
        await cleaning.promise;
      }
    });
    const input = new ViewInput();
    const finished = vi.fn();
    const action = vi.fn();
    const host = runInteractiveHost({
      ...h,
      input,
      rendererFactory: () => ({
        render: () => {},
        finish: finished,
        toggleDetail: () => {},
        invalidateAnchor: () => {},
      }),
      onAction: action,
    });
    input.line('work');
    await vi.waitFor(() => expect(h.controller.isBusy()).toBe(true));
    input.interrupt();
    await cleanupStarted.promise;
    expect(h.controller.isBusy()).toBe(true);
    input.line('do not start');
    await vi.waitFor(() =>
      expect(h.output.log).toHaveBeenCalledWith(expect.stringContaining('会话忙')),
    );
    input.line('/status');
    await vi.waitFor(() => expect(h.output.log).toHaveBeenCalledWith('status result'));
    input.line('/exit');
    let settled = false;
    void host.then(() => {
      settled = true;
    });
    await input.whenClosed;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.session.destroy).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    expect(action.mock.calls.some(([event]) => event.type === 'settled')).toBe(false);
    cleaning.resolve();
    await host;
    expect(h.executions).toEqual(['message:work']);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(action.mock.calls.some(([event]) => event.type === 'settled')).toBe(true);
    expect(finished).toHaveBeenCalledTimes(2);
  });

  it.each(['text', 'view'] as const)(
    'uses the same dispatcher, skill and real prompt preparation with %s input/rendering',
    async (mode) => {
      const h = fixture();
      const bytes = new PassThrough();
      const input =
        mode === 'text'
          ? new CliInputCoordinator({
              input: bytes,
              output: new PassThrough(),
              interactive: false,
              terminal: false,
            })
          : new ViewInput();
      const send = (line: string) =>
        mode === 'text' ? bytes.write(`${line}\n`) : (input as ViewInput).line(line);
      for (const [name, handler] of [
        ['skill', skillCommand],
        ['prompt', promptCommand],
      ] as const)
        h.dispatcher.registerDefinition(
          COMMAND_CATALOG.find((definition) => definition.name === name)!,
          handler,
        );
      const definition = {
        stableId: 'docs/summarize',
        server: 'docs',
        name: 'summarize',
        serverGeneration: 1,
        catalogEpoch: 1,
        contentDigest: 'digest',
        arguments: [],
      };
      const getPrompt = vi.fn(async () => ({
        messages: [{ role: 'user', content: { type: 'text', text: 'Prepared by MCP' } }],
      }));
      bindSessionMcpPlugin(h.session, {
        promptRegistry: { get: () => definition },
        manager: {
          getServerSession: () => ({
            client: { getPrompt },
            connectionState: 'ready',
            promptsState: 'ready',
            generation: definition.serverGeneration,
            promptsCatalogEpoch: definition.catalogEpoch,
          }),
        },
      } as unknown as Parameters<typeof bindSessionMcpPlugin>[1]);
      const rendered: string[] = [];
      const sessions = vi.fn();
      const host = runInteractiveHost({
        ...h,
        input,
        onSessionChanged: sessions,
        rendererFactory: () =>
          mode === 'text'
            ? createEventRenderer({
                write: (text) => rendered.push(text),
                isTTY: false,
                getGitBranch: () => undefined,
              })
            : {
                render: (event) => {
                  if (event.type === 'text_delta') rendered.push(event.text);
                },
                finish: () => {},
                toggleDetail: () => {},
                invalidateAnchor: () => {},
              },
      });
      send('hello');
      await vi.waitFor(() => expect(h.executions).toHaveLength(1));
      await vi.waitFor(() => expect(h.controller.isBusy()).toBe(false));
      send('/skill guide keep "a  b"');
      await vi.waitFor(() => expect(h.executions).toHaveLength(2));
      await vi.waitFor(() => expect(h.controller.isBusy()).toBe(false));
      send('/prompt docs/summarize');
      await vi.waitFor(() => expect(h.executions).toHaveLength(3));
      expect(h.executions[1]).toBe('skill:guide:keep "a  b"');
      expect(h.executions[2]).toContain('Prepared by MCP');
      expect(getPrompt).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(h.controller.isBusy()).toBe(false));
      expect(rendered.join('')).toContain('prompt answer');
      expect(sessions).toHaveBeenCalledWith(h.session);
      if (input instanceof ViewInput) {
        expect(input.completer('/skill g')[0]).toEqual(['/skill guide']);
        expect(input.completer('/skill guide task')[0]).toEqual([]);
        expect(input.prompts).toEqual(['', '', '', '']);
      }
      send('/exit');
      await host;
    },
  );

  it('cancels the active task and drains cleanup when the injected renderer fails', async () => {
    const cleaned = deferred();
    const h = fixture(async function* (signal) {
      yield { type: 'text_delta', text: 'first' };
      expect(signal?.aborted).toBe(true);
      await cleaned.promise;
      yield { type: 'text_delta', text: 'after cleanup' };
    });
    const input = new ViewInput();
    const host = runInteractiveHost({
      ...h,
      input,
      rendererFactory: () => ({
        render: () => {
          throw new Error('paint failure');
        },
        finish: () => {},
        toggleDetail: () => {},
        invalidateAnchor: () => {},
      }),
    });
    input.line('work');
    await vi.waitFor(() =>
      expect(h.output.error).toHaveBeenCalledWith(expect.stringContaining('paint failure')),
    );
    expect(h.controller.isBusy()).toBe(true);
    input.line('/exit');
    cleaned.resolve();
    await host;
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('cancels exclusive input before task cancellation and uses a second busy interrupt to request orderly exit', async () => {
    const cleaned = deferred();
    const started = deferred();
    const h = fixture(async function* (signal) {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      await cleaned.promise;
    });
    const input = new ViewInput();
    const host = runInteractiveHost({
      ...h,
      input,
      rendererFactory: () => ({
        render: () => {},
        finish: () => {},
        toggleDetail: () => {},
        invalidateAnchor: () => {},
      }),
    });
    input.pending = true;
    input.interrupt();
    expect(input.cancel).toHaveBeenCalledTimes(1);
    expect(input.close).not.toHaveBeenCalled();
    input.line('work');
    await started.promise;
    input.interrupt();
    expect(input.close).not.toHaveBeenCalled();
    input.interrupt();
    await input.whenClosed;
    expect(h.release).not.toHaveBeenCalled();
    cleaned.resolve();
    await host;
  });
});
