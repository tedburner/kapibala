import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { identifyHistory } from '../src/context/history.js';
import { SummaryService, extractFileDetails, truncateToolOutput } from '../src/context/summary.js';
import { SimpleModelRouter } from '../src/models/router.js';
import type { CanonicalMessage } from '../src/types/index.js';
import { ScriptedProvider } from './helpers/mock.js';

const profile = {
  id: 'summary',
  name: 'summary',
  modelName: 'summary',
  provider: 'openai-compatible' as const,
  baseURL: 'http://127.0.0.1:9',
  apiKeyEnv: 'NONE',
  contextWindow: '32K' as const,
};
const summary = {
  schemaVersion: 1,
  goal: 'finish work',
  constraints: ['retain rules'],
  decisions: [],
  completedWork: ['read source'],
  pendingWork: ['test'],
  references: [],
  unknownEffects: [],
};

describe('bounded summary generation', () => {
  it('keeps legacy relative file paths unresolved instead of guessing the project root', () => {
    const absolute = path.resolve('absolute-file.txt');
    const history = identifyHistory(
      [
        {
          role: 'assistant',
          content: ['relative-file.txt', absolute].map((file, index) => ({
            type: 'tool_use' as const,
            id: String(index),
            name: 'read_file',
            input: { path: file },
          })),
        },
        {
          role: 'tool',
          content: [0, 1].map((index) => ({
            type: 'tool_result' as const,
            toolUseId: String(index),
            content: 'read',
          })),
        },
      ],
      'legacy-paths',
    );
    expect(
      extractFileDetails(history, path.resolve('different-root')).readFiles.map((f) => f.path),
    ).toEqual(['relative-file.txt', absolute.replaceAll('\\', '/')]);
  });

  it('retains exactly bounded Unicode head and tail with an omission marker', () => {
    const raw = `START${'😀'.repeat(5000)}END`;
    const shortened = truncateToolOutput(raw);
    expect(shortened).toContain('START');
    expect(shortened).toContain('END');
    expect(Array.from(shortened).length).toBeLessThan(2100);
    expect(shortened).toContain('3008');
    expect(truncateToolOutput('short')).toBe('short');
  });

  it('records file outcomes from actual results instead of intent', () => {
    const raw = identifyHistory(
      [
        {
          role: 'assistant',
          content: ['read_file', 'write_file', 'edit_file', 'write_file', 'run_command'].map(
            (name, i) => ({
              type: 'tool_use' as const,
              id: String(i),
              name,
              input: { path: `file-${i}` },
            }),
          ),
        },
        {
          role: 'tool',
          content: [
            { type: 'tool_result', toolUseId: '0', content: 'read' },
            { type: 'tool_result', toolUseId: '1', content: 'written' },
            { type: 'tool_result', toolUseId: '2', content: 'failed', isError: true },
            {
              type: 'tool_result',
              toolUseId: '3',
              content: 'unknown',
              isError: true,
              errorCode: 'OUTCOME_UNKNOWN',
            },
            { type: 'tool_result', toolUseId: '4', content: 'done' },
          ],
        },
      ],
      'source',
    );
    const details = extractFileDetails(raw, '/workspace');
    expect(details.readFiles).toHaveLength(1);
    expect(details.modifiedFiles).toHaveLength(1);
    expect(details.failedFileOperations).toHaveLength(1);
    expect(details.unknownFileOperations).toHaveLength(1);
    expect(details.modifiedFiles[0]).toMatchObject({ sourceMessageId: raw[0].id, toolCallId: '1' });
  });

  it('uses the summary route without tools and validates complete structured output', async () => {
    const provider = new ScriptedProvider([
      [{ type: 'text_delta', text: JSON.stringify(summary) }, { type: 'message_stop' }],
    ]);
    const service = new SummaryService({
      router: new SimpleModelRouter(profile, provider),
      projectRoot: '/workspace',
    });
    const history = identifyHistory(
      [
        { role: 'user', content: [{ type: 'text', text: 'question' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      ],
      'source',
    );
    const result = await service.generate(history);
    expect(result.summary).toEqual(summary);
    expect(result.calls).toBe(1);
    expect(provider.requests).toHaveLength(1);
  });

  it('rejects invalid references, truncated output and unfinished streams', async () => {
    const raw: CanonicalMessage[] = [
      { id: 'source', role: 'user', content: [{ type: 'text', text: 'question' }] },
    ];
    for (const events of [
      [
        {
          type: 'text_delta' as const,
          text: JSON.stringify({ ...summary, references: ['invented-source'] }),
        },
        { type: 'message_stop' as const },
      ],
      [
        { type: 'text_delta' as const, text: JSON.stringify(summary) },
        { type: 'message_stop' as const, finishReason: 'length' },
      ],
      [{ type: 'text_delta' as const, text: JSON.stringify(summary) }],
    ]) {
      const service = new SummaryService({
        router: new SimpleModelRouter(profile, new ScriptedProvider([events])),
        projectRoot: '/workspace',
      });
      await expect(service.generate(raw)).rejects.toThrow();
    }
  });

  it('budgets the whole request and rejects an indivisible interaction before calling the model', async () => {
    const provider = new ScriptedProvider([]);
    const service = new SummaryService({
      router: new SimpleModelRouter({ ...profile, contextWindow: 2048 }, provider),
      projectRoot: '/workspace',
    });
    await expect(
      service.generate([
        { id: 'large', role: 'user', content: [{ type: 'text', text: '中'.repeat(10000) }] },
      ]),
    ).rejects.toThrow(/budget/i);
    expect(provider.requests).toHaveLength(0);
  });

  it('batches complete interactions and rolls only local candidates within four calls', async () => {
    const provider = new ScriptedProvider(
      Array.from({ length: 4 }, () => [
        { type: 'text_delta' as const, text: JSON.stringify(summary) },
        { type: 'message_stop' as const },
      ]),
    );
    const service = new SummaryService({
      router: new SimpleModelRouter(profile, provider),
      projectRoot: '/workspace',
      estimator: {
        estimate(request) {
          const block = request.messages[0].content[0];
          if (block.type !== 'text') throw new Error('Unexpected summary input');
          const source = JSON.parse(block.text).sourceMessages;
          return {
            total: source.length > 2 ? 100000 : 1000,
            system: 0,
            tools: 0,
            history: 1000,
            overhead: 0,
            source: 'estimated',
          };
        },
      },
    });
    const history = identifyHistory(
      Array.from({ length: 5 }, (_, i) => [
        { role: 'user' as const, content: [{ type: 'text' as const, text: `task-${i}` }] },
        { role: 'assistant' as const, content: [{ type: 'text' as const, text: `done-${i}` }] },
      ]).flat(),
      'batch',
    );
    await expect(service.generate(history)).rejects.toThrow(/maximum four calls/);
    expect(provider.requests).toHaveLength(4);
    for (const [i, messages] of provider.requests.entries()) {
      const block = messages[0].content[0];
      if (block.type !== 'text') throw new Error('Unexpected summary input');
      const data = JSON.parse(block.text);
      expect(data.sourceMessages.map((m: CanonicalMessage) => m.id)).toEqual(
        history.slice(i * 2, i * 2 + 2).map((m) => m.id),
      );
      if (i > 0) expect(data.previousSummary).toEqual(summary);
    }
  });

  it('waits for provider cleanup on deadline and records an unknown failed attempt', async () => {
    let release!: () => void;
    let cleanupStarted!: () => void;
    const cleaning = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cleaned = false;
    class SlowProvider extends ScriptedProvider {
      override async *create(request: import('../src/types/index.js').ModelRequest) {
        try {
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) resolve();
            else request.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          yield { type: 'message_stop' as const };
        } finally {
          cleanupStarted();
          await released;
          cleaned = true;
        }
      }
    }
    const usages: unknown[] = [];
    const service = new SummaryService({
      router: new SimpleModelRouter(profile, new SlowProvider([])),
      projectRoot: '/workspace',
      timeoutMs: 10,
      onUsage: async (_attemptId, usage) => {
        usages.push(usage);
      },
    });
    let settled = false;
    const pending = service.generate([
      { id: 'input', role: 'user', content: [{ type: 'text', text: 'task' }] },
    ]);
    const rejection = expect(pending).rejects.toThrow(/deadline/);
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await cleaning;
    expect(settled).toBe(false);
    expect(cleaned).toBe(false);
    release();
    await rejection;
    expect(cleaned).toBe(true);
    expect(usages).toEqual([undefined]);
  });

  it('never treats a plugin using a builtin name as a successful file observation', () => {
    const history: CanonicalMessage[] = [
      {
        id: 'call',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'plugin',
            name: 'write_file',
            source: 'plugin',
            input: { path: 'claimed.txt' },
          },
        ],
      },
      {
        id: 'result',
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 'plugin', content: 'done' }],
      },
    ];
    expect(extractFileDetails(history, '/workspace').modifiedFiles).toEqual([]);
  });
});
