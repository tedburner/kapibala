import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineTool } from '../src/capabilities/tools/index.js';
import { UnicodeTokenEstimator } from '../src/context/budget.js';
import { SessionStore } from '../src/context/session-store.js';
import { AgentSession } from '../src/context/session/index.js';
import { AnthropicProvider } from '../src/models/anthropic/index.js';
import type { ModelProfile } from '../src/models/index.js';
import { OpenAICompatibleProvider } from '../src/models/openai-compatible/index.js';
import { OpenAIResponsesProvider } from '../src/models/openai-responses/index.js';
import { createProtocolOrigin } from '../src/models/protocol-state.js';
import { findDanglingToolUses, makeEchoToolRegistry } from './helpers/mock.js';

const endpoint = 'https://example.test/v1';
const base: ModelProfile = {
  id: 'chat',
  name: 'Chat',
  provider: 'openai-compatible',
  modelName: 'chat',
  baseURL: endpoint,
  apiKeyEnv: 'NONE',
  contextWindow: 256000,
};
const options = { baseURL: endpoint, apiKey: 'fixture-key' };
const sse = (events: Record<string, unknown>[]) =>
  new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
  );
function anthropic(tool: boolean) {
  return sse([
    {
      type: 'message_start',
      message: {
        id: 'a',
        type: 'message',
        role: 'assistant',
        content: [],
        usage: { input_tokens: 10 },
      },
    },
    ...(tool
      ? [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: 'read', signature: 'PRIVATE_SIGNATURE' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'content_block_start',
            index: 1,
            content_block: {
              type: 'tool_use',
              id: 'anth_call',
              name: 'echo',
              input: { value: 'read' },
            },
          },
          { type: 'content_block_stop', index: 1 },
        ]
      : [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: 'planned' },
          },
          { type: 'content_block_stop', index: 0 },
        ]),
    {
      type: 'message_delta',
      delta: { stop_reason: tool ? 'tool_use' : 'end_turn' },
      usage: { output_tokens: 2 },
    },
    { type: 'message_stop' },
  ]);
}
function responses(tool: boolean) {
  return sse([
    {
      type: 'response.completed',
      response: {
        status: 'completed',
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
        output: tool
          ? [
              {
                type: 'reasoning',
                id: 'r',
                encrypted_content: 'PRIVATE_CIPHER',
                summary: [],
                status: 'completed',
              },
              {
                type: 'message',
                id: 'comment',
                role: 'assistant',
                status: 'completed',
                phase: 'commentary',
                content: [{ type: 'output_text', text: 'working', annotations: [] }],
              },
              {
                type: 'function_call',
                id: 'fc',
                call_id: 'resp_call',
                name: 'echo',
                arguments: '{"value":"run"}',
                status: 'completed',
              },
            ]
          : [
              {
                type: 'message',
                id: 'final',
                role: 'assistant',
                status: 'completed',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'executed', annotations: [] }],
              },
            ],
      },
    },
  ]);
}
afterEach(() => vi.unstubAllGlobals());
describe('one canonical session across all native adapters', () => {
  it('awaits native reader cancellation before releasing the Session and preserves only complete history', async () => {
    let cleaned = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                const events = [
                  {
                    type: 'response.output_item.added',
                    output_index: 0,
                    item: {
                      type: 'message',
                      id: 'partial',
                      role: 'assistant',
                      status: 'in_progress',
                      content: [],
                    },
                  },
                  {
                    type: 'response.output_text.delta',
                    output_index: 0,
                    item_id: 'partial',
                    content_index: 0,
                    delta: 'partial',
                  },
                ];
                for (const event of events)
                  controller.enqueue(
                    new TextEncoder().encode(
                      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                    ),
                  );
              },
              async cancel() {
                await Promise.resolve();
                cleaned = true;
              },
            }),
          ),
      ),
    );
    const session = new AgentSession({
      defaultProfile: { ...base, provider: 'openai-responses', modelName: 'openai' },
      defaultProvider: new OpenAIResponsesProvider({ ...options, modelName: 'openai' }),
    });
    for await (const event of session.run('cancel')) {
      if (event.type === 'text_delta') break;
    }
    expect(cleaned).toBe(true);
    expect(session.isBusy()).toBe(false);
    expect(session.getLastRunMetrics()?.status).toBe('aborted');
    expect(session.getHistory().map((message) => message.role)).toEqual(['user']);
  });
  it('routes planning→execution→fast, replays tools, retains original state on disk and strips it on recovery', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-native-integration-'));
    try {
      const captured: { url: string; body: Record<string, any> }[] = [];
      const counts = new Map<string, number>();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url, init) => {
          const target = String(url);
          const index = counts.get(target) ?? 0;
          counts.set(target, index + 1);
          captured.push({ url: target, body: JSON.parse(init.body) });
          if (target.endsWith('/messages')) return anthropic(index === 0);
          if (target.endsWith('/responses')) return responses(index === 0);
          return new Response(
            'data: {"choices":[{"delta":{"content":"fast"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          );
        }),
      );
      const file = path.join(directory, 'session.jsonl');
      const store = await SessionStore.create(file, {
        conversationId: 'native',
        projectRoot: directory,
        initialCwd: directory,
      });
      const chat = new OpenAICompatibleProvider({ ...options, modelName: 'chat' });
      const session = new AgentSession({
        defaultProfile: base,
        defaultProvider: chat,
        store,
        rootDir: directory,
        mode: 'Plan',
      });
      session.switchModel(
        {
          ...base,
          id: 'claude',
          name: 'Claude',
          provider: 'anthropic',
          modelName: 'claude',
          maxOutputTokens: 16384,
        },
        'planning',
        new AnthropicProvider({ ...options, modelName: 'claude' }),
      );
      session.switchModel(
        {
          ...base,
          id: 'openai',
          name: 'OpenAI',
          provider: 'openai-responses',
          modelName: 'openai',
          maxOutputTokens: 32768,
        },
        'execution',
        new OpenAIResponsesProvider({ ...options, modelName: 'openai', supportsThinking: true }),
      );
      session.switchModel({ ...base, id: 'fast' }, 'fast', chat);
      for (const tool of makeEchoToolRegistry().list()) session.tools.register(tool);
      for (const role of ['planning', 'execution', 'fast'] as const) {
        for await (const _ of session.run(role, { role })) {
          /* consume */
        }
        expect(session.getContextSnapshot()?.modelId).toBe(
          role === 'planning' ? 'claude' : role === 'execution' ? 'openai' : 'fast',
        );
      }
      expect(captured.map((call) => call.url.split('/').at(-1))).toEqual([
        'messages',
        'messages',
        'responses',
        'responses',
        'completions',
      ]);
      expect(captured[0]?.body.max_tokens).toBe(16384);
      expect(captured[2]?.body.max_output_tokens).toBe(32000);
      expect(captured[4]?.body.max_tokens).toBe(4096);
      expect(JSON.stringify(captured[1]?.body)).toContain('PRIVATE_SIGNATURE');
      expect(JSON.stringify(captured[2]?.body)).not.toContain('PRIVATE_SIGNATURE');
      expect(JSON.stringify(captured[3]?.body)).toContain('PRIVATE_CIPHER');
      expect(JSON.stringify(captured[4]?.body)).not.toContain('PRIVATE_');
      const original = session.getHistory();
      expect(findDanglingToolUses(original)).toEqual([]);
      expect(original.filter((message) => message.role === 'tool')).toHaveLength(2);
      const persisted = await store.load();
      expect(persisted).toEqual(original);
      expect(JSON.stringify(persisted)).toContain('PRIVATE_SIGNATURE');
      expect(JSON.stringify(persisted)).toContain('PRIVATE_CIPHER');
      const records = await store.readRecords();
      expect(
        records
          .filter((record) => record.type === 'run_started')
          .map((record) => record.payload.modelId),
      ).toEqual(['claude', 'openai', 'fast']);
      const restored = new AgentSession({
        defaultProfile: {
          ...base,
          id: 'openai',
          provider: 'openai-responses',
          modelName: 'openai',
        },
        defaultProvider: new OpenAIResponsesProvider({ ...options, modelName: 'openai' }),
        store,
        rootDir: directory,
      });
      await restored.init();
      expect(restored.getModelRole()).toBe('default');
      expect(restored.getMode()).toBe('Approval');
      for await (const _ of restored.run('next')) {
        /* consume */
      }
      const recovered = captured.at(-1)?.body;
      expect(JSON.stringify(recovered)).not.toContain('PRIVATE_');
      expect(
        recovered?.input.some((item: any) => item.id === 'comment' && item.phase === 'commentary'),
      ).toBe(true);
      expect(JSON.stringify(restored.getHistory())).toContain('PRIVATE_CIPHER');
      restored.hooks.on('model:before', async (_ctx, request) => {
        const source = request.messages
          .flatMap((message) => message.content)
          .find((block) => block.type === 'text' && block.protocolMeta?.itemId === 'comment');
        if (source?.type === 'text') source.text = 'rewritten';
        return request;
      });
      for await (const _ of restored.run('rewrite projection')) {
        /* consume */
      }
      expect(captured.at(-1)?.body.input.some((item: any) => item.id === 'comment')).toBe(false);
      expect(
        restored
          .getHistory()
          .flatMap((message) => message.content)
          .some(
            (block) =>
              block.type === 'text' &&
              block.protocolMeta?.itemId === 'comment' &&
              block.text === 'working',
          ),
      ).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  it('counts encrypted state conservatively rather than as zero tokens', () => {
    const origin = createProtocolOrigin(
      { protocol: 'openai-responses', modelName: 'm', baseURL: endpoint },
      { runId: 'run' },
    );
    const estimator = new UnicodeTokenEstimator();
    const empty = estimator.estimate({ messages: [] });
    const privateState = estimator.estimate({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'provider_state',
              origin,
              item: {
                type: 'reasoning',
                id: 'r',
                encrypted_content: 'x'.repeat(4000),
                summary: [],
              },
            },
          ],
        },
      ],
    });
    expect(privateState.total - empty.total).toBeGreaterThan(1000);
    expect(privateState.source).toBe('estimated');
  });
  it.each(['planning', 'execution'] as const)(
    'keeps Plan permissions and prompt semantics under %s',
    async (role) => {
      const { ScriptedProvider } = await import('./helpers/mock.js');
      const provider = new ScriptedProvider([
        [
          { type: 'tool_call_finish', id: 'write', name: 'write', input: {} },
          { type: 'message_stop' },
        ],
        [{ type: 'text_delta', text: 'denied' }, { type: 'message_stop' }],
      ]);
      const session = new AgentSession({
        defaultProfile: base,
        defaultProvider: provider,
        mode: 'Plan',
      });
      session.switchModel({ ...base, id: role }, role, provider);
      const execute = vi.fn(async () => 'written');
      session.tools.register(
        defineTool({
          name: 'write',
          description: 'write',
          parameters: { type: 'object' },
          metadata: { permissions: ['fs:write'] },
          execute,
        }),
      );
      for await (const _ of session.run('write', { role })) {
        /* consume */
      }
      expect(execute).not.toHaveBeenCalled();
      expect(session.getMode()).toBe('Plan');
      expect(findDanglingToolUses(session.getHistory())).toEqual([]);
    },
  );
});
