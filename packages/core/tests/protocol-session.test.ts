import { describe, expect, it } from 'vitest';
import { AgentSession } from '../src/context/session/index.js';
import { ContextOverflowError } from '../src/errors/index.js';
import type { ModelProvider } from '../src/models/index.js';
import { createProtocolOrigin } from '../src/models/protocol-state.js';
import type { ContentBlock, ModelEvent, ModelRequest } from '../src/types/index.js';
import { ScriptedProvider, makeEchoToolRegistry } from './helpers/mock.js';

class SignedProvider extends ScriptedProvider implements ModelProvider {
  readonly binding = {
    protocol: 'anthropic' as 'anthropic' | 'openai-responses',
    modelName: 'claude',
    baseURL: 'https://example.test/v1',
  };
  readonly captured: ModelRequest[] = [];
  calls = 1;
  overflow = false;
  initialFailure?: 'error' | 'truncated';
  override async *create(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.captured.push(structuredClone({ ...request, signal: undefined }));
    if (this.captured.length === 1 && this.initialFailure) {
      if (this.initialFailure === 'error') throw new Error('initial request failed');
      yield { type: 'text_delta', text: 'unfinished' };
      yield { type: 'message_stop', finishReason: 'length' };
      return;
    }
    if (this.captured.length === (this.initialFailure ? 2 : 1)) {
      const origin = createProtocolOrigin(this.binding, request.context);
      const privateBlock: ContentBlock =
        this.binding.protocol === 'anthropic'
          ? { type: 'thinking', thinking: 'read', signature: 'PRIVATE', origin }
          : {
              type: 'provider_state',
              origin,
              item: {
                type: 'reasoning',
                id: 'reasoning_1',
                encrypted_content: 'PRIVATE',
                summary: [],
              },
            };
      yield {
        type: 'message_stop',
        finalContent: [
          privateBlock,
          ...Array.from({ length: this.calls }, (_, index) => ({
            type: 'tool_use' as const,
            id: `call_${index}`,
            name: 'echo',
            input: { value: 'ok' },
          })),
        ],
      };
    } else {
      if (this.overflow) throw new ContextOverflowError();
      yield { type: 'message_stop', finalContent: [{ type: 'text', text: 'done' }] };
    }
  }
}
function setup(provider = new SignedProvider([]), toolBehavior?: () => string) {
  const session = new AgentSession({
    defaultProfile: {
      id: 'claude',
      name: 'Claude',
      provider: provider.binding.protocol,
      modelName: 'claude',
      baseURL: provider.binding.baseURL,
      apiKeyEnv: 'NONE',
      contextWindow: 128000,
    },
    defaultProvider: provider,
    mode: 'Plan',
  });
  for (const tool of makeEchoToolRegistry(toolBehavior).list()) session.tools.register(tool);
  return { session, provider };
}
async function drain(session: AgentSession) {
  for await (const _ of session.run('read')) {
    /* consume */
  }
}
describe('native signed continuation prefix', () => {
  it('rejects model:before inventing a source-matched private block', async () => {
    const { session, provider } = setup();
    session.hooks.on('model:before', async (_ctx, request) => {
      request.messages[0]!.content.push({
        type: 'thinking',
        thinking: 'invented',
        signature: 'FORGED',
        origin: createProtocolOrigin(provider.binding, request.context),
      });
      return request;
    });
    await expect(drain(session)).rejects.toThrow(/private|provenance/i);
    expect(provider.captured).toHaveLength(0);
  });
  it('does not compact or resend a changed signed chain after native overflow', async () => {
    const { session, provider } = setup();
    provider.overflow = true;
    const events = [];
    for await (const event of session.run('read')) events.push(event);
    expect(provider.captured).toHaveLength(2);
    expect(events.some((event) => event.type === 'compaction_start')).toBe(false);
    expect(session.getLastRunMetrics()?.status).toBe('failed');
    expect(session.getHistory().at(-1)?.role).toBe('tool');
    expect(session.isBusy()).toBe(false);
  });
  it('anchors environment before generated assistant and keeps exact prefix', async () => {
    const { session, provider } = setup();
    await drain(session);
    const first = provider.captured[0]!;
    const second = provider.captured[1]!;
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(second.messages.at(-1)?.role).toBe('tool');
    expect(
      second.messages
        .flatMap((m) => m.content)
        .some((b) => b.type === 'thinking' && b.signature === 'PRIVATE'),
    ).toBe(true);
  });
  it.each([
    ['anthropic', 'error'],
    ['anthropic', 'truncated'],
    ['openai-responses', 'error'],
    ['openai-responses', 'truncated'],
  ] as const)(
    'keeps the %s signed prefix stable when retrying after an initial %s',
    async (protocol, initialFailure) => {
      const provider = new SignedProvider([]);
      provider.binding.protocol = protocol;
      provider.initialFailure = initialFailure;
      let executions = 0;
      const { session } = setup(provider, () => {
        executions++;
        return 'echo:ok';
      });

      await drain(session);
      expect(session.getLastRunMetrics()?.status).toBe('failed');
      await expect(drain(session)).resolves.toBeUndefined();

      expect(session.getLastRunMetrics()?.status).toBe('completed');
      expect(executions).toBe(1);
      expect(provider.captured).toHaveLength(3);
      const retry = provider.captured[1]!;
      const continuation = provider.captured[2]!;
      expect(continuation.messages.slice(0, retry.messages.length)).toEqual(retry.messages);
      expect(continuation.messages.at(-1)?.role).toBe('tool');
      expect(
        continuation.messages
          .flatMap((message) => message.content)
          .some((block) =>
            protocol === 'anthropic'
              ? block.type === 'thinking' && block.signature === 'PRIVATE'
              : block.type === 'provider_state' && block.item.encrypted_content === 'PRIVATE',
          ),
      ).toBe(true);
      expect(session.getHistory().at(-1)?.content).toEqual([{ type: 'text', text: 'done' }]);
      expect(session.isBusy()).toBe(false);
    },
  );
  it('accepts a signed batch with two canonical results normalized into one request message', async () => {
    const { session, provider } = setup();
    provider.calls = 2;
    await drain(session);
    expect(provider.captured).toHaveLength(2);
    expect(provider.captured[1]?.messages.at(-1)?.content).toHaveLength(2);
  });
  it('rejects a model:before hook rewriting a frozen signed prefix before continuation', async () => {
    const { session, provider } = setup();
    let calls = 0;
    session.hooks.on('model:before', async (_ctx, request) => {
      if (++calls === 2) request.systemPrompt = 'changed';
      return request;
    });
    await expect(drain(session)).rejects.toThrow(/prefix/i);
    expect(provider.captured).toHaveLength(1);
    expect(session.getHistory().at(-1)?.role).toBe('tool');
    expect(session.isBusy()).toBe(false);
  });
  it('rejects mutation of signed output by model:after before tools execute', async () => {
    const { session, provider } = setup();
    session.hooks.on('model:after', async (_ctx, payload) => {
      const thinking = payload.message.content.find((b) => b.type === 'thinking');
      if (thinking?.type === 'thinking') thinking.signature = 'changed';
    });
    await expect(drain(session)).rejects.toThrow(/signed|private/i);
    expect(provider.captured).toHaveLength(1);
    expect(session.getHistory().map((m) => m.role)).toEqual(['user']);
  });
  it('rejects deletion of private blocks from a signed continuation', async () => {
    const { session, provider } = setup();
    session.hooks.on('model:before', async (_ctx, request) => {
      request.messages = request.messages.map((message) => ({
        ...message,
        content: message.content.filter((block) => block.type !== 'thinking'),
      }));
      return request;
    });
    await expect(drain(session)).rejects.toThrow(/prefix|chain/i);
    expect(provider.captured).toHaveLength(1);
  });
});
