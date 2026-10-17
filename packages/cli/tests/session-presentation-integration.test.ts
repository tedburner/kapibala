import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession, SessionManager } from '@kiturone/kapibala';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ScriptedProvider,
  findDanglingToolUses,
  makeEchoToolRegistry,
} from '../../core/tests/helpers/mock.js';
import { ActiveSessionController } from '../src/active-session.js';
import { projectHistory } from '../src/host/history-projection.js';
import { PresentationStore } from '../src/host/presentation-store.js';
import { SessionPresentation, presentationScope } from '../src/host/session-presentation.js';
import { selectMessages } from '../src/view-model/index.js';

afterEach(() => vi.restoreAllMocks());

describe('real controller and persistent presentation boundary', () => {
  it.each([false, true])(
    'keeps busy until final storage completes (failure=%s)',
    async (failFinish) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-view-integration-'));
      const manager = new SessionManager({
        workspaceRoot: directory,
        homeDirectory: path.join(directory, 'home'),
      });
      const handle = await manager.create();
      let executions = 0;
      const factory = async (target: typeof handle) => {
        const session = new AgentSession({
          workspaceRoot: directory,
          store: target.store,
          loggingDirectory: path.join(directory, 'logs'),
          defaultProfile: {
            id: 'test',
            name: 'test',
            provider: 'openai-compatible',
            baseURL: 'http://127.0.0.1:9',
            apiKeyEnv: 'NONE',
            modelName: 'test',
          },
          defaultProvider: new ScriptedProvider([
            [
              { type: 'tool_call_finish', id: 'call', name: 'echo', input: { value: 'hi' } },
              { type: 'message_stop' },
            ],
            [{ type: 'text_delta', text: 'final answer' }, { type: 'message_stop' }],
          ]),
        });
        for (const tool of makeEchoToolRegistry(() => {
          executions++;
          return 'echo:hi';
        }).list())
          session.tools.register(tool);
        return session;
      };
      const session = await factory(handle);
      await session.init();
      const controller = new ActiveSessionController({
        manager,
        factory,
        current: { handle, session },
      });
      const identity = {
        conversationId: session.conversationId,
        branchId: handle.store.getActiveBranchId(),
        viewEpoch: 1,
      };
      const store = new PresentationStore(identity);
      const adapter = new SessionPresentation(store, 'operation', () => session.getHistory());
      const original = handle.store.appendRecord.bind(handle.store);
      const spy = vi
        .spyOn(handle.store, 'appendRecord')
        .mockImplementation(async (type, payload, options) => {
          if (type === 'run_finished' && failFinish) throw new Error('final storage failure');
          return original(type, payload, options);
        });
      let caught: unknown;
      let observedResult = false;
      try {
        try {
          for await (const event of controller.run('echo please')) {
            adapter.consume(event);
            if (event.type === 'run_finish') {
              observedResult = true;
              expect(controller.isBusy()).toBe(true);
              expect(store.snapshot().operation?.phase).toBe('settling');
              await expect(controller.newSession()).rejects.toThrow(/busy|running/i);
            }
          }
        } catch (error) {
          caught = error;
        }
        expect(observedResult).toBe(true);
        expect(controller.isBusy()).toBe(false);
        adapter.settle(caught ? 'failed' : 'completed', caught);
        expect(store.snapshot().operation).toMatchObject({
          phase: 'idle',
          result: failFinish ? 'failed' : 'completed',
        });
        if (failFinish)
          expect(store.snapshot().notices.at(-1)?.text).toContain('final storage failure');
        const stored = await handle.store.load();
        expect(stored.map((message) => message.role)).toEqual([
          'user',
          'assistant',
          'tool',
          'assistant',
        ]);
        expect(findDanglingToolUses(stored)).toEqual([]);
        expect(
          selectMessages(store.snapshot())
            .flatMap((message) => message.blocks)
            .filter((block) => block.text === 'final answer'),
        ).toHaveLength(1);
        const recovered = projectHistory(stored, presentationScope(identity));
        const displayed = selectMessages(store.snapshot());
        expect(displayed.map((message) => message.role)).toEqual(
          recovered.map((message) => message.role),
        );
        expect(store.snapshot().pendingMessages).toEqual([]);
        expect(
          displayed.flatMap((message) => message.blocks).filter((block) => block.tool),
        ).toHaveLength(1);
        expect(
          recovered.flatMap((message) => message.blocks).find((block) => block.kind === 'tool')
            ?.tool?.result,
        ).toBe('echo:hi');
        expect(executions).toBe(1);
      } finally {
        spy.mockRestore();
        store.close();
        await controller.close();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
