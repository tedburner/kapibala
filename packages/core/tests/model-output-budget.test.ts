import { describe, expect, it } from 'vitest';
import { createContextBudget } from '../src/context/budget.js';
import { identifyHistory } from '../src/context/history.js';
import { ContextManager } from '../src/context/manager.js';
import { SummaryService } from '../src/context/summary.js';
import { type ModelProfile, SimpleModelRouter } from '../src/models/router.js';
import type { ModelEvent, ModelRequest, SessionEvent } from '../src/types/index.js';
import { ScriptedProvider } from './helpers/mock.js';

const profile: ModelProfile = {
  id: 'model-fixture',
  name: 'fixture',
  modelName: 'fixture',
  provider: 'openai-compatible',
  baseURL: 'https://example.test/v1',
  apiKeyEnv: 'NONE',
  contextWindow: '1M',
};
const request: ModelRequest = {
  messages: [{ id: 'input', role: 'user', content: [{ type: 'text', text: 'task' }] }],
};
const summary = {
  schemaVersion: 1,
  goal: 'continue',
  constraints: [],
  decisions: [],
  completedWork: [],
  pendingWork: [],
  references: [],
  unknownEffects: [],
};

async function prepared(
  generator: AsyncGenerator<SessionEvent, ModelRequest>,
): Promise<ModelRequest> {
  while (true) {
    const next = await generator.next();
    if (next.done) return next.value;
  }
}

class RecordingSummaryProvider extends ScriptedProvider {
  readonly fullRequests: ModelRequest[] = [];
  constructor() {
    super([]);
  }
  override async *create(req: ModelRequest): AsyncIterable<ModelEvent> {
    this.fullRequests.push(structuredClone({ ...req, signal: undefined }));
    yield { type: 'text_delta', text: JSON.stringify(summary) };
    yield { type: 'message_stop', finishReason: 'stop' };
  }
}

describe('purpose output budgets', () => {
  it.each(['anthropic', 'openai-responses'] as const)(
    'does not force Chat sampling settings into native %s summaries',
    async (protocol) => {
      const provider = new RecordingSummaryProvider();
      const router = new SimpleModelRouter(
        { ...profile, provider: protocol, maxOutputTokens: 32768 },
        provider,
      );
      router.setRole('planning', { ...profile, id: 'planner' }, new ScriptedProvider([]));
      const service = new SummaryService({ router, projectRoot: process.cwd() });
      const result = await service.generate(request.messages);
      expect(result.modelId).toBe(profile.id);
      expect(provider.fullRequests[0]?.maxTokens).toBe(4096);
      expect(provider.fullRequests[0]?.temperature).toBeUndefined();
    },
  );
  it.each([3100, 4000])(
    'keeps a frozen signed prefix intact and checks its %s input tokens without summary calls',
    async (total) => {
      const provider = new RecordingSummaryProvider();
      const selected = { ...profile, contextWindow: 4096 };
      const manager = new ContextManager({
        conversationId: 'frozen-fixture',
        router: new SimpleModelRouter(selected, provider),
        projectRoot: process.cwd(),
        estimator: {
          estimate(req) {
            return {
              total: req.messages.length > 3 ? total : 100,
              system: 0,
              tools: 0,
              history: 100,
              overhead: 0,
              source: 'estimated',
            };
          },
        },
      });
      const history = identifyHistory(
        [
          { role: 'user', content: [{ type: 'text', text: 'old task' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'old done' }] },
          { role: 'user', content: [{ type: 'text', text: 'recent task' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'recent done' }] },
          ...request.messages,
        ],
        'frozen-fixture',
      );
      const pending = prepared(
        manager.prepare(
          history,
          { messages: manager.project(history) },
          selected,
          'run',
          'threshold',
          false,
        ),
      );
      if (total > createContextBudget(selected.contextWindow).inputBudget)
        await expect(pending).rejects.toThrow(/budget/i);
      else expect((await pending).messages).toEqual(manager.project(history));
      expect(provider.fullRequests).toHaveLength(0);
      expect(manager.getSnapshot()?.budget.outputReserve).toBe(512);
    },
  );

  it.each([
    [undefined, 4096],
    [4096, 4096],
    [16384, 16384],
    [32768, 32768],
    [2048, 2048],
  ])(
    'uses explicit %s output ceiling for reserve and derived input budget',
    (maxOutputTokens, expected) => {
      const budget = createContextBudget('1M', maxOutputTokens);
      expect(budget.outputReserve).toBe(expected);
      expect(budget.inputBudget).toBe(1_000_000 - expected - budget.safetyReserve);
    },
  );

  it('caps output reserve at the model window boundary', () => {
    expect(createContextBudget('128K', 32768).outputReserve).toBe(16000);
    expect(createContextBudget(undefined, 32768).outputReserve).toBe(4000);
  });

  it.each([0, -1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid profile output ceiling %s in every purpose before model requests',
    async (maxOutputTokens) => {
      expect(() => createContextBudget('1M', maxOutputTokens)).toThrow(/output/i);
      const manager = new ContextManager({ conversationId: 'budget-fixture' });
      await expect(
        prepared(manager.prepare(request.messages, request, { ...profile, maxOutputTokens })),
      ).rejects.toThrow(/output/i);
      expect(() =>
        manager.inspect(request.messages, request, { ...profile, maxOutputTokens }),
      ).toThrow(/output/i);
      const provider = new RecordingSummaryProvider();
      const service = new SummaryService({
        router: new SimpleModelRouter({ ...profile, maxOutputTokens }, provider),
        projectRoot: process.cwd(),
      });
      await expect(service.generate(request.messages)).rejects.toThrow(/output/i);
      expect(provider.fullRequests).toHaveLength(0);
    },
  );

  it.each([4096, 16384, 32768, 2048])(
    'uses Profile ceiling %s consistently in prepared request and context inspection',
    async (maxOutputTokens) => {
      const manager = new ContextManager({ conversationId: 'budget-fixture' });
      const selected = { ...profile, maxOutputTokens };
      const result = await prepared(manager.prepare(request.messages, request, selected));
      expect(result.maxTokens).toBe(maxOutputTokens);
      expect(manager.getSnapshot()?.budget.outputReserve).toBe(maxOutputTokens);
      expect(manager.inspect(request.messages, request, selected).budget.outputReserve).toBe(
        maxOutputTokens,
      );
    },
  );

  it('uses a lower explicit request ceiling for both reserve and provider field', async () => {
    const manager = new ContextManager({ conversationId: 'budget-fixture' });
    const selected = { ...profile, maxOutputTokens: 32768 };
    const lower = { ...request, maxTokens: 1536 };
    const result = await prepared(manager.prepare(request.messages, lower, selected));
    expect(result.maxTokens).toBe(1536);
    expect(manager.getSnapshot()?.budget.outputReserve).toBe(1536);
    expect(manager.inspect(request.messages, lower, selected).budget.outputReserve).toBe(1536);
  });

  it('prevents request overrides from raising the Profile ceiling', async () => {
    const manager = new ContextManager({ conversationId: 'budget-fixture' });
    const selected = { ...profile, maxOutputTokens: 2048 };
    const result = await prepared(
      manager.prepare(request.messages, { ...request, maxTokens: 32768 }, selected),
    );
    expect(result.maxTokens).toBe(2048);
    expect(manager.getSnapshot()?.budget.outputReserve).toBe(2048);
  });

  it.each([0, -1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid request override %s even when Profile ceiling is valid',
    async (maxTokens) => {
      const manager = new ContextManager({ conversationId: 'budget-fixture' });
      const invalid = { ...request, maxTokens };
      await expect(
        prepared(
          manager.prepare(request.messages, invalid, { ...profile, maxOutputTokens: 32768 }),
        ),
      ).rejects.toThrow(/output/i);
      expect(() =>
        manager.inspect(request.messages, invalid, { ...profile, maxOutputTokens: 32768 }),
      ).toThrow(/output/i);
    },
  );

  it.each([
    [undefined, 4096],
    [16384, 4096],
    [32768, 4096],
    [2048, 2048],
  ])(
    'keeps summary purpose separate from Profile %s ceiling',
    async (maxOutputTokens, expected) => {
      const provider = new RecordingSummaryProvider();
      const service = new SummaryService({
        router: new SimpleModelRouter({ ...profile, maxOutputTokens }, provider),
        projectRoot: process.cwd(),
      });
      await service.generate(request.messages);
      expect(provider.fullRequests[0].maxTokens).toBe(expected);
    },
  );

  it('applies the summary model window after the purpose ceiling', async () => {
    const provider = new RecordingSummaryProvider();
    const service = new SummaryService({
      router: new SimpleModelRouter(
        { ...profile, contextWindow: '32K', maxOutputTokens: 32768 },
        provider,
      ),
      projectRoot: process.cwd(),
    });
    await service.generate(request.messages);
    expect(provider.fullRequests[0].maxTokens).toBe(4000);
  });
});
