import { describe, expect, it } from 'vitest';
import { AgentSession } from '../src/context/session/index.js';
import type { ModelProfile, ModelProvider } from '../src/models/index.js';
import type { ModelRequest } from '../src/types/index.js';
import { ScriptedProvider, makeEchoToolRegistry } from './helpers/mock.js';

const profile: ModelProfile = {
  id: 'default',
  name: 'Default',
  provider: 'openai-compatible',
  modelName: 'default',
  baseURL: 'https://example.test/v1',
  apiKeyEnv: 'NONE',
  contextWindow: 32000,
};
class CaptureProvider extends ScriptedProvider {
  readonly captured: ModelRequest[] = [];
  override async *create(request: ModelRequest) {
    this.captured.push(structuredClone({ ...request, signal: undefined }));
    yield* super.create(request);
  }
}
async function drain(session: AgentSession, role?: 'planning' | 'execution' | 'fast') {
  for await (const _ of session.run('hello', { role })) {
    /* consume */
  }
}
describe('explicit scenario routing', () => {
  it('keeps the selected planning model across tools and attributes its window', async () => {
    const fallback = new CaptureProvider([]);
    const planning = new CaptureProvider([
      [
        { type: 'tool_call_finish', id: 'call', name: 'echo', input: { value: 'read' } },
        { type: 'message_stop' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'message_stop', usage: { promptTokens: 20, completionTokens: 2, totalTokens: 22 } },
      ],
    ]);
    const session = new AgentSession({
      defaultProfile: profile,
      defaultProvider: fallback,
      mode: 'Plan',
    });
    session.switchModel(
      { ...profile, id: 'planner', name: 'Planner', modelName: 'planner', contextWindow: 64000 },
      'planning',
      planning,
    );
    for (const tool of makeEchoToolRegistry().list()) session.tools.register(tool);
    await drain(session, 'planning');
    expect(fallback.captured).toHaveLength(0);
    expect(planning.captured).toHaveLength(2);
    expect(session.getLastRunMetrics()?.contextUsage?.limitTokens).toBe(64000);
    expect(session.getContextSnapshot()?.modelId).toBe('planner');
    expect(planning.captured[1]?.context?.modelId).toBe('planner');
    expect(session.getMode()).toBe('Plan');
  });
  it('rejects an unbound explicit role before recording input or requesting default', async () => {
    const provider = new CaptureProvider([]);
    const session = new AgentSession({ defaultProfile: profile, defaultProvider: provider });
    await expect(drain(session, 'fast')).rejects.toThrow(/not configured/);
    expect(provider.captured).toHaveLength(0);
    expect(session.getHistory()).toEqual([]);
    expect(session.isBusy()).toBe(false);
  });
  it('selection is explicit, idle only, and ordinary runs use default', async () => {
    const fallback = new CaptureProvider([]);
    const planner = new CaptureProvider([]);
    const session = new AgentSession({ defaultProfile: profile, defaultProvider: fallback });
    session.switchModel({ ...profile, id: 'planner' }, 'planning', planner);
    expect(session.getModelRole()).toBe('default');
    await drain(session);
    session.selectModelRole('planning');
    expect(session.getActiveProfile().id).toBe('planner');
    const events = session.run('next')[Symbol.asyncIterator]();
    await events.next();
    expect(() => session.selectModelRole('default')).toThrow(/busy|running/i);
    await events.return?.();
    expect(session.isBusy()).toBe(false);
  });
  it('rejects a role provider with missing credentials before any model request', async () => {
    const provider = new CaptureProvider([]) as CaptureProvider & ModelProvider;
    Object.defineProperty(provider, 'credentialsReady', { value: false });
    const session = new AgentSession({
      defaultProfile: profile,
      defaultProvider: new CaptureProvider([]),
    });
    session.switchModel({ ...profile, id: 'planner' }, 'planning', provider);
    await expect(drain(session, 'planning')).rejects.toThrow(/credential/i);
    expect(provider.captured).toHaveLength(0);
    expect(session.getHistory()).toEqual([]);
  });
});
