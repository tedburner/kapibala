import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '../src/capabilities/security/approval.js';
import { builtinTools } from '../src/capabilities/tools/builtin/fs.js';
import { SessionStore } from '../src/context/session-store.js';
import { AgentSession } from '../src/context/session/index.js';
import { AnthropicProvider } from '../src/models/anthropic/index.js';
import type { ModelProfile } from '../src/models/index.js';
import { OpenAICompatibleProvider } from '../src/models/openai-compatible/index.js';
import { OpenAIResponsesProvider } from '../src/models/openai-responses/index.js';
import type { SessionEvent } from '../src/types/index.js';
import {
  type LocalModelServer,
  type LocalProtocol,
  startLocalModelServer,
} from './helpers/local-model-server.js';
import { findDanglingToolUses } from './helpers/mock.js';

const FIXTURE_KEY = 'fixture-model-key-0001';
const ENV_SENTINEL = 'env-credential-must-not-be-used';
const roots: string[] = [];
const servers: LocalModelServer[] = [];
const sessions: AgentSession[] = [];

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', ENV_SENTINEL);
  vi.stubEnv('ANTHROPIC_API_KEY', ENV_SENTINEL);
  vi.stubEnv('DEEPSEEK_API_KEY', ENV_SENTINEL);
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.destroy().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-no-key-sdk-'));
  roots.push(root);
  return root;
}

async function serverWithScript(protocol: LocalProtocol): Promise<LocalModelServer> {
  const server = await startLocalModelServer();
  servers.push(server);
  return server;
}

interface ProtocolBinding {
  provider: ModelProfile['provider'];
  modelName: string;
  create(server: LocalModelServer): import('../src/models/index.js').ModelProvider;
}

const bindings: Record<LocalProtocol, ProtocolBinding> = {
  chat: {
    provider: 'openai-compatible',
    modelName: 'fixture-chat',
    create: (server) =>
      new OpenAICompatibleProvider({
        baseURL: server.baseURL,
        apiKey: FIXTURE_KEY,
        modelName: 'fixture-chat',
      }),
  },
  anthropic: {
    provider: 'anthropic',
    modelName: 'fixture-anthropic',
    create: (server) =>
      new AnthropicProvider({
        baseURL: server.baseURL,
        apiKey: FIXTURE_KEY,
        modelName: 'fixture-anthropic',
      }),
  },
  responses: {
    provider: 'openai-responses',
    modelName: 'fixture-responses',
    create: (server) =>
      new OpenAIResponsesProvider({
        baseURL: server.baseURL,
        apiKey: FIXTURE_KEY,
        modelName: 'fixture-responses',
      }),
  },
};

async function createSession(
  protocol: LocalProtocol,
  server: LocalModelServer,
  root: string,
  options: {
    mode?: 'Approval' | 'FullAccess';
    approvalChannel?: import('../src/capabilities/security/approval.js').ApprovalChannel;
  } = {},
): Promise<{ session: AgentSession; store: SessionStore }> {
  const binding = bindings[protocol];
  const profile: ModelProfile = {
    id: `fixture-${protocol}`,
    name: `Fixture ${protocol}`,
    provider: binding.provider,
    baseURL: server.baseURL,
    modelName: binding.modelName,
    apiKeyEnv: 'FIXTURE_MODEL_KEY_UNUSED',
    contextWindow: 128_000,
  };
  const store = await SessionStore.create(path.join(root, `${protocol}.jsonl`), {
    conversationId: `fixture-${protocol}`,
    projectRoot: root,
    initialCwd: root,
  });
  const session = new AgentSession({
    workspaceRoot: root,
    loggingDirectory: path.join(root, 'logs'),
    store,
    defaultProfile: profile,
    defaultProvider: binding.create(server),
    mode: options.mode ?? 'FullAccess',
    maxSteps: 6,
    ...(options.approvalChannel ? { approvalChannel: options.approvalChannel } : {}),
  });
  for (const tool of builtinTools) session.tools.register(tool);
  sessions.push(session);
  return { session, store };
}

async function collect(session: AgentSession, prompt: string): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of session.run(prompt)) events.push(event);
  return events;
}

function toolResults(history: import('../src/types/index.js').CanonicalMessage[]) {
  return history.flatMap((message) =>
    message.content.flatMap((block) => (block.type === 'tool_result' ? [block] : [])),
  );
}

function assertNoEnvironmentCredential(server: LocalModelServer): void {
  for (const request of server.requests) {
    expect(JSON.stringify(request.headers)).not.toContain(ENV_SENTINEL);
    expect(JSON.stringify(request.body)).not.toContain(ENV_SENTINEL);
    if (request.protocol === 'anthropic') {
      expect(request.headers['x-api-key']).toBe(FIXTURE_KEY);
      expect(request.headers.authorization).toBe(`Bearer ${FIXTURE_KEY}`);
    } else {
      expect(request.headers.authorization).toBe(`Bearer ${FIXTURE_KEY}`);
    }
  }
}

describe('no-key SDK matrix over real local wire protocols', () => {
  it.each(['chat', 'anthropic', 'responses'] as const)(
    'runs one real tool transaction over %s and consumes every scripted turn',
    async (protocol) => {
      const root = workspace();
      const server = await serverWithScript(protocol);
      const callId = `call-${protocol}-write`;
      server.script(
        protocol,
        {
          kind: 'tools',
          calls: [
            {
              id: callId,
              name: 'write_file',
              input: { path: 'notes/proof.txt', content: `${protocol}\n` },
            },
          ],
        },
        { kind: 'text', text: `finished-${protocol}` },
      );
      const { session, store } = await createSession(protocol, server, root);

      const events = await collect(session, `write proof via ${protocol}`);

      expect(fs.readFileSync(path.join(root, 'notes/proof.txt'), 'utf8')).toBe(`${protocol}\n`);
      expect(
        events.some((event) => event.type === 'tool_start' && event.name === 'write_file'),
      ).toBe(true);
      expect(events.some((event) => event.type === 'tool_finish' && event.isError === false)).toBe(
        true,
      );

      const history = session.getHistory();
      expect(history.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'assistant',
      ]);
      expect(findDanglingToolUses(history)).toEqual([]);
      const [result] = toolResults(history);
      expect(result).toMatchObject({ toolUseId: callId, isError: false });
      expect(result!.content).toContain('Successfully wrote');
      expect(await store.load()).toEqual(history);

      expect(server.requests.filter((request) => request.protocol === protocol)).toHaveLength(2);
      expect(server.pending()).toBe(0);
      assertNoEnvironmentCredential(server);

      const second = server.requests.filter((request) => request.protocol === protocol)[1]!;
      if (protocol === 'chat') {
        const messages = (second.body.messages as Array<Record<string, any>>).filter(
          (message) => message.role !== 'system',
        );
        expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
        expect(messages[1]!.tool_calls[0]).toMatchObject({
          id: callId,
          function: { name: 'write_file' },
        });
        expect(messages[2]).toMatchObject({ role: 'tool', tool_call_id: callId });
      } else if (protocol === 'anthropic') {
        const messages = second.body.messages as Array<Record<string, any>>;
        expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
        expect(messages[1]!.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'tool_use', id: callId, name: 'write_file' }),
          ]),
        );
        expect(messages[2]!.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'tool_result', tool_use_id: callId }),
          ]),
        );
      } else {
        const input = second.body.input as Array<Record<string, any>>;
        expect(input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'function_call', call_id: callId, name: 'write_file' }),
            expect.objectContaining({ type: 'function_call_output', call_id: callId }),
          ]),
        );
      }

      await session.destroy();
      server.assertConsumed();
    },
  );

  it('closes a partial multi-tool batch with one real failure and no outside write', async () => {
    const root = workspace();
    const server = await serverWithScript('chat');
    const escapeName = `escape-${path.basename(root)}.txt`;
    server.script(
      'chat',
      {
        kind: 'tools',
        calls: [
          { id: 'call-ok', name: 'write_file', input: { path: 'ok.txt', content: 'ok' } },
          {
            id: 'call-escape',
            name: 'write_file',
            input: { path: `../${escapeName}`, content: 'must not escape' },
          },
        ],
      },
      { kind: 'text', text: 'partial failure handled' },
    );
    const { session } = await createSession('chat', server, root);

    await collect(session, 'write both files');

    expect(fs.readFileSync(path.join(root, 'ok.txt'), 'utf8')).toBe('ok');
    expect(fs.existsSync(path.join(root, '..', escapeName))).toBe(false);
    const history = session.getHistory();
    expect(findDanglingToolUses(history)).toEqual([]);
    const results = toolResults(history);
    expect(results).toHaveLength(2);
    expect(results.find((result) => result.toolUseId === 'call-ok')?.isError).toBe(false);
    expect(results.find((result) => result.toolUseId === 'call-escape')?.isError).toBe(true);
    expect(server.requests).toHaveLength(2);
    expect(server.pending()).toBe(0);
    await session.destroy();
    server.assertConsumed();
  });

  it('aborts a held model stream and leaves no uncommitted assistant history', async () => {
    const root = workspace();
    const server = await serverWithScript('chat');
    server.script('chat', { kind: 'hold', text: 'partial-answer' });
    const { session } = await createSession('chat', server, root);
    const controller = new AbortController();

    try {
      for await (const event of session.run('cancel this run', { signal: controller.signal })) {
        if (event.type === 'text_delta') controller.abort();
      }
    } catch (error) {
      expect((error as Error).name).toBe('AbortError');
    }

    await vi.waitFor(() => expect(session.isBusy()).toBe(false));
    await server.waitForClosedHolds();
    expect(session.getLastRunMetrics()?.status).toBe('aborted');
    expect(session.getHistory().map((message) => message.role)).toEqual(['user']);
    expect(server.requests).toHaveLength(1);
    expect(server.pending()).toBe(0);
    await session.destroy();
    server.assertConsumed();
  });

  it('releases the session when the consumer returns before the stream finishes', async () => {
    const root = workspace();
    const server = await serverWithScript('chat');
    server.script('chat', {
      kind: 'text',
      text: 'unused',
      chunks: ['first-chunk', 'second-chunk'],
    });
    const { session } = await createSession('chat', server, root);

    for await (const event of session.run('stop early')) {
      if (event.type === 'text_delta') break;
    }

    expect(session.isBusy()).toBe(false);
    expect(session.getLastRunMetrics()?.status).toBe('aborted');
    expect(session.getHistory().map((message) => message.role)).toEqual(['user']);
    await session.destroy();
    server.assertConsumed();
  });

  it('records a denied approval as a closed error transaction without touching the file', async () => {
    const root = workspace();
    const server = await serverWithScript('chat');
    const approve = vi.fn(async (_request: ApprovalRequest) => 'deny_once' as const);
    server.script('chat', {
      kind: 'tools',
      calls: [
        { id: 'call-denied', name: 'write_file', input: { path: 'denied.txt', content: 'no' } },
      ],
    });
    const { session } = await createSession('chat', server, root, {
      mode: 'Approval',
      approvalChannel: { requestApproval: approve },
    });

    await collect(session, 'try to write');

    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]![0]).toMatchObject({ toolName: 'write_file' });
    expect(fs.existsSync(path.join(root, 'denied.txt'))).toBe(false);
    const history = session.getHistory();
    expect(findDanglingToolUses(history)).toEqual([]);
    expect(toolResults(history)).toEqual([
      expect.objectContaining({
        toolUseId: 'call-denied',
        isError: true,
        errorCode: 'PERMISSION_DENIED',
      }),
    ]);
    expect(server.requests).toHaveLength(1);
    expect(server.pending()).toBe(0);
    await session.destroy();
    server.assertConsumed();
  });
});
