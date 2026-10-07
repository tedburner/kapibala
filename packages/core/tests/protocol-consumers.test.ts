import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContextManager } from '../src/context/manager.js';
import { SessionStore } from '../src/context/session-store.js';
import { AgentSession } from '../src/context/session/index.js';
import { JSONLMessageStore } from '../src/context/store/jsonl.js';
import { SummaryService } from '../src/context/summary.js';
import { projectProtocolHistory } from '../src/models/protocol-state.js';
import { createProtocolOrigin } from '../src/models/protocol-state.js';
import { SimpleModelRouter } from '../src/models/router.js';
import type { CanonicalMessage, ModelEvent } from '../src/types/index.js';
import { ScriptedProvider } from './helpers/mock.js';

const origin = createProtocolOrigin(
  { protocol: 'openai-responses', modelName: 'm', baseURL: 'https://example.test' },
  { runId: 'run' },
);
const profile = {
  id: 'test',
  name: 'test',
  modelName: 'test',
  provider: 'openai-compatible' as const,
  baseURL: 'http://localhost',
  apiKeyEnv: 'NONE',
  contextWindow: 32000,
};
const answer = JSON.stringify({
  schemaVersion: 1,
  goal: 'task',
  constraints: [],
  decisions: [],
  completedWork: [],
  pendingWork: [],
  references: [],
  unknownEffects: [],
});

describe('protocol state consumers', () => {
  it.each(['anthropic', 'openai-responses'] as const)(
    'manually compacts old %s interactions without changing persisted private state',
    async (protocol) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-native-compact-'));
      let session: AgentSession | undefined;
      try {
        const nativeProfile = {
          ...profile,
          provider: protocol,
          modelName: 'm',
          baseURL: 'https://example.test',
        };
        const nativeOrigin = createProtocolOrigin(
          { protocol, modelName: nativeProfile.modelName, baseURL: nativeProfile.baseURL },
          { runId: 'old', modelId: nativeProfile.id },
        );
        const history: CanonicalMessage[] = [
          { id: 'old-user', role: 'user', content: [{ type: 'text', text: '任务'.repeat(1500) }] },
          {
            id: 'old-answer',
            role: 'assistant',
            content: [
              ...(protocol === 'anthropic'
                ? [
                    {
                      type: 'thinking' as const,
                      thinking: 'visible reasoning',
                      signature: 'PRIVATE_SIGNATURE',
                      origin: nativeOrigin,
                    },
                  ]
                : [
                    {
                      type: 'provider_state' as const,
                      origin: nativeOrigin,
                      item: {
                        type: 'reasoning' as const,
                        id: 'reasoning',
                        summary: [],
                        encrypted_content: 'PRIVATE_CIPHER',
                      },
                    },
                  ]),
              { type: 'text', text: 'old done' },
            ],
          },
          { id: 'recent-user', role: 'user', content: [{ type: 'text', text: 'recent task' }] },
          {
            id: 'recent-answer',
            role: 'assistant',
            content: [{ type: 'text', text: 'recent done' }],
          },
        ];
        const store = await SessionStore.create(path.join(directory, 'session.jsonl'), {
          conversationId: 'native-compact',
          projectRoot: directory,
          initialCwd: directory,
        });
        for (const message of history) await store.append(message);
        const provider = new ScriptedProvider([
          [
            { type: 'text_delta', text: answer },
            { type: 'message_stop', finishReason: 'stop' },
          ],
        ]);
        session = new AgentSession({
          defaultProfile: nativeProfile,
          defaultProvider: provider,
          store,
          rootDir: directory,
          eventLogger: { record: async () => {}, recordAudit: async () => {} } as never,
        });
        const events = [];
        for await (const event of session.compact()) events.push(event);
        expect(
          events.some((event) => event.type === 'compaction_finish' && event.kind === 'summary'),
        ).toBe(true);
        expect(session.getContextSnapshot()?.checkpointId).toBeDefined();
        expect(session.getHistory()).toEqual(history);
        expect(await store.load()).toEqual(history);
        expect(JSON.stringify(provider.requests)).not.toContain('PRIVATE_');
        expect(session.getContextHistory().some((message) => message.id === 'recent-user')).toBe(
          true,
        );
      } finally {
        await session?.destroy();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it('allows normal cross-run private-state projection to compact old complete interactions', async () => {
    const nativeProfile = {
      ...profile,
      provider: 'openai-responses' as const,
      modelName: 'm',
      baseURL: 'https://example.test',
      contextWindow: 4096,
    };
    const provider = new ScriptedProvider([
      [
        { type: 'text_delta', text: answer },
        { type: 'message_stop', finishReason: 'stop' },
      ],
    ]);
    const estimator = {
      estimate: (request: any) => ({
        total: request.messages.some((message: any) => message.id === 'a0') ? 3500 : 100,
        system: 0,
        tools: 0,
        history: 100,
        overhead: 0,
        source: 'estimated' as const,
      }),
    };
    const manager = new ContextManager({
      conversationId: 'projection',
      router: new SimpleModelRouter(nativeProfile, provider),
      estimator,
    });
    const history: CanonicalMessage[] = Array.from({ length: 3 }, (_, index) => [
      {
        id: `u${index}`,
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'task' }],
      },
      {
        id: `a${index}`,
        role: 'assistant' as const,
        state: 'completed' as const,
        content: [
          {
            type: 'provider_state' as const,
            origin,
            item: {
              type: 'reasoning' as const,
              id: `r${index}`,
              encrypted_content: 'PRIVATE',
              summary: [],
            },
          },
          { type: 'text' as const, text: 'done' },
        ],
      },
    ]).flat();
    history.push({ id: 'current', role: 'user', content: [{ type: 'text', text: 'next' }] });
    const request = {
      context: { runId: 'new', modelId: nativeProfile.id },
      messages: projectProtocolHistory(
        history,
        {
          protocol: nativeProfile.provider,
          modelName: nativeProfile.modelName,
          baseURL: nativeProfile.baseURL,
        },
        { runId: 'new', modelId: nativeProfile.id },
      ),
    };
    const events = [];
    for await (const event of manager.prepare(history, request, nativeProfile, 'new', 'manual'))
      events.push(event);
    expect(provider.requests).toHaveLength(1);
    expect(
      events.some((event) => event.type === 'compaction_finish' && event.kind === 'summary'),
    ).toBe(true);
  });
  it('roundtrips ordinary Item identity and private state in both JSONL stores', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-roundtrip-'));
    try {
      const message: CanonicalMessage = {
        id: 'a',
        role: 'assistant',
        state: 'completed',
        content: [
          {
            type: 'provider_state',
            origin,
            item: { type: 'reasoning', id: 'r', encrypted_content: 'PRIVATE', summary: [] },
          },
          {
            type: 'text',
            text: 'done',
            protocolMeta: { origin, itemIndex: 1, itemId: 'm', phase: 'final_answer' },
          },
        ],
      };
      const legacy = new JSONLMessageStore(path.join(directory, 'legacy.jsonl'));
      const versioned = await SessionStore.create(path.join(directory, 'versioned.jsonl'), {
        conversationId: 'roundtrip',
        projectRoot: directory,
        initialCwd: directory,
      });
      for (const store of [legacy, versioned]) {
        await store.append(message);
        expect((await store.load())[0]?.content).toEqual(message.content);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  it('does not send signatures or encrypted reasoning to a summary model', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'text_delta', text: answer },
        { type: 'message_stop', finishReason: 'stop' },
      ],
    ]);
    const service = new SummaryService({
      router: new SimpleModelRouter(profile, provider),
      projectRoot: process.cwd(),
    });
    const history: CanonicalMessage[] = [
      { id: 'u', role: 'user', content: [{ type: 'text', text: 'task' }] },
      {
        id: 'a',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'visible', signature: 'PRIVATE_SIGNATURE', origin },
          {
            type: 'provider_state',
            origin,
            item: { type: 'reasoning', id: 'r', encrypted_content: 'PRIVATE_CIPHER', summary: [] },
          },
          { type: 'text', text: 'done' },
        ],
      },
    ];
    await service.generate(history);
    const request = JSON.stringify(provider.requests[0]);
    expect(request).not.toContain('PRIVATE_');
    expect(request).toContain('visible');
    expect(history[1]?.content).toHaveLength(3);
  });

  it('rejects tools hidden only in a summary final content event', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'text_delta', text: answer },
        {
          type: 'message_stop',
          finalContent: [
            { type: 'text', text: answer },
            { type: 'tool_use', id: 'call', name: 'echo', input: {} },
          ],
        } as ModelEvent,
      ],
    ]);
    const service = new SummaryService({
      router: new SimpleModelRouter(profile, provider),
      projectRoot: process.cwd(),
    });
    await expect(
      service.generate([{ id: 'u', role: 'user', content: [{ type: 'text', text: 'task' }] }]),
    ).rejects.toThrow(/tool/i);
  });

  it('rejects malformed protocol state before message persistence', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-state-'));
    try {
      const store = await SessionStore.create(path.join(directory, 'session.jsonl'), {
        conversationId: 'test',
        projectRoot: directory,
        initialCwd: directory,
      });
      await expect(
        store.append({
          role: 'assistant',
          content: [
            {
              type: 'provider_state',
              origin: { ...origin, version: 9 } as never,
              item: { type: 'reasoning', id: 'r', summary: [] },
            },
          ],
        }),
      ).rejects.toThrow(/protocol|state/i);
      expect(
        (await store.readRecords()).filter((record) => record.type === 'message'),
      ).toHaveLength(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
