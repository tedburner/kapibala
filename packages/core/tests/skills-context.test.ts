import { describe, expect, it } from 'vitest';
import { inspectSkillContent } from '../src/capabilities/skills/content.js';
import { skillDigest } from '../src/capabilities/skills/scanner.js';
import type { SkillContentSource } from '../src/capabilities/skills/types.js';
import { identifyHistory } from '../src/context/history.js';
import { ContextManager } from '../src/context/manager.js';
import { SimpleModelRouter } from '../src/models/router.js';
import type { CanonicalMessage, ModelRequest, SessionEvent } from '../src/types/index.js';
import { ScriptedProvider } from './helpers/mock.js';

const body = 'Follow these exact instructions.\n'.repeat(180);
const source: SkillContentSource = {
  version: 1,
  name: 'guide',
  scope: 'global',
  filePath: '/global/guide/SKILL.md',
  baseDir: '/global/guide',
  contentDigest: skillDigest('original'),
  renderedDigest: skillDigest(body),
  caller: 'user',
  runId: 'old',
  invocationId: 'explicit',
};
const history = () =>
  identifyHistory(
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'old task' },
          { type: 'text', text: body, skillSource: source },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'old done' }] },
      { role: 'user', content: [{ type: 'text', text: 'recent task' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'recent done' }] },
      { role: 'user', content: [{ type: 'text', text: 'current task' }] },
    ] as CanonicalMessage[],
    'skill-history',
  );
const profile = {
  id: 'context',
  name: 'context',
  modelName: 'context',
  provider: 'openai-compatible' as const,
  baseURL: 'http://127.0.0.1:9',
  apiKeyEnv: 'NONE',
  contextWindow: 32000,
};
async function drain(generator: AsyncGenerator<SessionEvent, ModelRequest>) {
  const events: SessionEvent[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { events, request: next.value };
    events.push(next.value);
  }
}
describe('skill context lifecycle', () => {
  it('retains complete active injection units when old skill interactions are compacted', async () => {
    const raw = history();
    raw.at(-1)!.content.push({
      type: 'text',
      text: body,
      skillSource: { ...source, runId: 'current', invocationId: 'current' },
    });
    const current = structuredClone(raw.at(-1));
    const provider = new ScriptedProvider([
      [
        {
          type: 'text_delta',
          text: JSON.stringify({
            schemaVersion: 1,
            goal: 'continue',
            constraints: [],
            decisions: [],
            completedWork: [],
            pendingWork: [],
            references: [],
            unknownEffects: [],
          }),
        },
        { type: 'message_stop' },
      ],
    ]);
    const manager = new ContextManager({
      conversationId: 'active-skills',
      router: new SimpleModelRouter(profile, provider),
    });
    const prepared = await drain(
      manager.prepare(raw, { messages: manager.project(raw) }, profile, 'current', 'manual'),
    );
    expect(prepared.events.some((event) => event.type === 'compaction_finish')).toBe(true);
    expect(prepared.request.messages.at(-1)).toEqual(current);
    expect(inspectSkillContent(raw, prepared.request.messages)[0].state).toBe('present');
  });
  it('keeps existing skill content present when summary generation fails', async () => {
    const raw = history();
    const provider = new ScriptedProvider([]);
    provider.create = async function* () {
      yield { type: 'text_delta', text: 'partial' };
      throw new Error('unavailable');
    };
    const manager = new ContextManager({
      conversationId: 'failed-summary',
      router: new SimpleModelRouter(profile, provider),
    });
    const prepared = await drain(
      manager.prepare(raw, { messages: manager.project(raw) }, profile, undefined, 'manual'),
    );
    expect(prepared.events.some((event) => event.type === 'compaction_failed')).toBe(true);
    expect(prepared.request.messages).toEqual(manager.project(raw));
    expect(inspectSkillContent(raw, prepared.request.messages)[0].state).toBe('present');
    expect(JSON.stringify(prepared.request.messages)).not.toContain('requires_reload');
  });
  it('requires intact rendered text in actual projection and ignores unknown source versions', () => {
    const raw = history();
    expect(inspectSkillContent(raw, raw)[0].state).toBe('present');
    const projected = structuredClone(raw);
    const block = projected[0].content[1];
    if (block.type === 'text') block.text = 'rewritten text';
    expect(inspectSkillContent(raw, projected)[0].state).toBe('requires_reload');
    const unknown = structuredClone(raw);
    const oldBlock = unknown[0].content[1];
    if (oldBlock.type === 'text' && oldBlock.skillSource)
      (oldBlock.skillSource as { version: number }).version = 99;
    expect(inspectSkillContent(unknown, unknown)).toEqual([]);
  });
  it('adds deterministic reload facts when an old body leaves summary projection, preserving current units', async () => {
    const raw = history();
    const original = structuredClone(raw);
    const provider = new ScriptedProvider([
      [
        {
          type: 'text_delta',
          text: JSON.stringify({
            schemaVersion: 1,
            goal: 'continue',
            constraints: [],
            decisions: [],
            completedWork: [],
            pendingWork: [],
            references: [],
            unknownEffects: [],
          }),
        },
        { type: 'message_stop' },
      ],
    ]);
    const manager = new ContextManager({
      conversationId: 'skills',
      router: new SimpleModelRouter(profile, provider),
    });
    const prepared = await drain(
      manager.prepare(raw, { messages: manager.project(raw) }, profile, undefined, 'manual'),
    );
    expect(prepared.events.some((e) => e.type === 'compaction_finish')).toBe(true);
    const summary = JSON.stringify(prepared.request.messages[0]);
    expect(summary).toContain('requires_reload');
    expect(summary).toContain(source.contentDigest);
    expect(summary).not.toContain('Follow these exact instructions');
    expect(prepared.request.messages.slice(-3)).toEqual(raw.slice(-3));
    expect(inspectSkillContent(raw, manager.project(raw))[0].state).toBe('requires_reload');
    expect(raw).toEqual(original);
  });
});
