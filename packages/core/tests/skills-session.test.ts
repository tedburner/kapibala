import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptAssembler } from '../src/capabilities/prompt/index.js';
import { readFileTool, writeFileTool } from '../src/capabilities/tools/builtin/fs.js';
import { UnicodeTokenEstimator, createContextBudget } from '../src/context/budget.js';
import { SessionStore } from '../src/context/session-store.js';
import { AgentSession, type SessionConfig } from '../src/context/session/index.js';
import { JSONLMessageStore } from '../src/context/store/jsonl.js';
import type { ModelProfile } from '../src/models/index.js';
import type { ModelRequest } from '../src/types/index.js';
import type { SessionEvent } from '../src/types/index.js';
import { ScriptedProvider, findDanglingToolUses } from './helpers/mock.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
const profile: ModelProfile = {
  id: 'skills-test',
  name: 'Skills Test',
  provider: 'openai-compatible',
  baseURL: 'http://127.0.0.1:9/v1',
  apiKeyEnv: 'NONE',
  modelName: 'test',
  contextWindow: 32000,
};
async function fixture(
  extra = '',
  turns: ConstructorParameters<typeof ScriptedProvider>[0] = [
    [{ type: 'text_delta', text: 'done' }, { type: 'message_stop' }],
  ],
  durable = false,
  config: Partial<SessionConfig> = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kpbl-skill-session-'));
  dirs.push(root);
  const skills = path.join(root, 'skills');
  const dir = path.join(skills, 'review');
  await fs.mkdir(path.join(dir, 'references'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: review\ndescription: Review code\nallowed-tools: [Read]\n${extra}---\nRead references/guide.md.`,
  );
  await fs.writeFile(path.join(dir, 'references', 'guide.md'), 'Check edge cases.');
  const provider = new ScriptedProvider(turns);
  const store = durable ? new JSONLMessageStore(path.join(root, 'history.jsonl')) : undefined;
  const session = new AgentSession({
    defaultProfile: profile,
    defaultProvider: provider,
    rootDir: root,
    store,
    mode: 'FullAccess',
    skills: { roots: [{ path: skills, scope: 'global' }] },
    userInstructionsPath: path.join(root, 'missing'),
    loggingDirectory: path.join(root, 'logging'),
    ...config,
  });
  session.tools.register(readFileTool);
  session.tools.register(writeFileTool);
  return { session, provider, store, root, dir };
}
async function consume(stream: AsyncIterable<SessionEvent>) {
  const events: SessionEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('session skills harness', () => {
  it.each(['assistant', 'tool result'] as const)(
    'rejects loading before commitment when the pending %s consumes the body budget',
    async (pending) => {
      const preceding =
        pending === 'assistant'
          ? [{ type: 'text_delta' as const, text: '思'.repeat(1800) }]
          : [
              {
                type: 'tool_call_finish' as const,
                id: 'read',
                name: 'read_file',
                input: { path: 'large.txt' },
              },
            ];
      const f = await fixture(
        '',
        [
          [
            ...preceding,
            { type: 'tool_call_finish', id: 'load', name: 'load_skill', input: { name: 'review' } },
            { type: 'message_stop' },
          ],
          [{ type: 'text_delta', text: 'done' }, { type: 'message_stop' }],
        ],
        true,
        { defaultProfile: { ...profile, contextWindow: 16000 } },
      );
      await fs.appendFile(path.join(f.dir, 'SKILL.md'), '中'.repeat(10000));
      await fs.writeFile(path.join(f.root, 'large.txt'), '资'.repeat(1800));

      const events = await consume(f.session.run('task'));
      const load = events.find((event) => event.type === 'tool_finish' && event.id === 'load');
      expect(load).toMatchObject({ isError: true });
      expect(load?.type === 'tool_finish' && load.result).toContain('SKILL_BODY_BUDGET_EXCEEDED');
      expect(events.some((event) => event.type === 'skill_loaded')).toBe(false);
      expect(events.some((event) => event.type === 'context_budget_exceeded')).toBe(false);
      expect(f.provider.requests).toHaveLength(1);
      const persisted = await f.store!.load();
      expect(findDanglingToolUses(persisted)).toEqual([]);
      expect(
        persisted.some((message) =>
          message.content.some(
            (block) => block.type === 'tool_result' && block.skillSource !== undefined,
          ),
        ),
      ).toBe(false);
      if (pending === 'tool result')
        expect(
          persisted
            .flatMap((message) => message.content)
            .find((block) => block.type === 'tool_result' && block.toolUseId === 'read'),
        ).toMatchObject({ content: '资'.repeat(1800), isError: false });
    },
  );

  it('counts two pending skill bodies once and continues when the complete batch fits', async () => {
    const f = await fixture(
      '',
      [
        [
          { type: 'tool_call_finish', id: 'first', name: 'load_skill', input: { name: 'review' } },
          { type: 'tool_call_finish', id: 'second', name: 'load_skill', input: { name: 'guide' } },
          { type: 'message_stop' },
        ],
        [{ type: 'text_delta', text: 'done' }, { type: 'message_stop' }],
      ],
      false,
      { defaultProfile: { ...profile, contextWindow: 16000 } },
    );
    await fs.appendFile(path.join(f.dir, 'SKILL.md'), '中'.repeat(4000));
    const guide = path.join(f.root, 'skills', 'guide');
    await fs.mkdir(guide);
    await fs.writeFile(
      path.join(guide, 'SKILL.md'),
      `---\nname: guide\ndescription: Second guide\n---\n${'文'.repeat(4000)}`,
    );

    const events = await consume(f.session.run('task'));
    expect(events.filter((event) => event.type === 'skill_loaded')).toHaveLength(2);
    expect(f.provider.requests).toHaveLength(2);
    expect(f.session.getLastRunMetrics()?.status).toBe('completed');
    expect(findDanglingToolUses(f.session.getHistory())).toEqual([]);
  });

  it('does not commit activation or continue after a tool-message append fails', async () => {
    const f = await fixture(
      '',
      [
        [
          { type: 'tool_call_finish', id: 'load', name: 'load_skill', input: { name: 'review' } },
          { type: 'message_stop' },
        ],
      ],
      true,
    );
    const original = f.store!.append.bind(f.store);
    vi.spyOn(f.store!, 'append').mockImplementation(async (message) => {
      if (message.role === 'tool') throw new Error('storage failed');
      await original(message);
    });
    const events: SessionEvent[] = [];
    await expect(
      (async () => {
        for await (const event of f.session.run('task')) events.push(event);
      })(),
    ).rejects.toThrow();
    expect(f.provider.requests).toHaveLength(1);
    expect(events.some((event) => event.type === 'skill_loaded')).toBe(false);
    expect(f.session.getSkills().activations).toEqual([]);
    expect(f.session.isBusy()).toBe(false);
    expect(findDanglingToolUses(f.session.getHistory())).toEqual([]);
  });
  it('treats custom stores losing optional source as ordinary history, without restoring authorization', async () => {
    const f = await fixture('disable-model-invocation: true\n');
    const persisted: ReturnType<typeof f.session.getHistory> = [];
    const store = {
      append: async (message: (typeof persisted)[number]) => {
        const copy = structuredClone(message);
        for (const block of copy.content)
          if (block.type === 'text' || block.type === 'tool_result') block.skillSource = undefined;
        persisted.push(copy);
      },
      load: async () => structuredClone(persisted),
      clear: async () => {
        persisted.length = 0;
      },
    };
    const config = {
      defaultProfile: profile,
      defaultProvider: f.provider,
      rootDir: f.root,
      skills: { roots: [{ path: path.join(f.root, 'skills'), scope: 'global' as const }] },
      store,
      loggingDirectory: path.join(f.root, 'custom-logs'),
      userInstructionsPath: path.join(f.root, 'missing'),
    };
    const session = new AgentSession(config);
    await consume(session.runSkill('review', 'task'));
    const restored = new AgentSession(config);
    await restored.init();
    expect(restored.getSkills().content).toEqual([]);
    expect(restored.getSkills().activations).toEqual([]);
    expect(restored.tools.get('read_skill_resource')).toBeUndefined();
    const text = restored.getHistory()[0].content[1];
    expect(text.type === 'text' && text.text.includes('Read references/guide.md.')).toBe(true);
  });
  it('publishes memory commitment without a Store and rejects model-only explicit invocation before appending', async () => {
    const f = await fixture();
    const events = await consume(f.session.runSkill('review', 'task'));
    expect(events.find((event) => event.type === 'skill_loaded')).toMatchObject({
      persistence: 'memory',
    });
    const modelOnly = await fixture('user-invocable: false\n');
    await expect(consume(modelOnly.session.runSkill('review', 'task'))).rejects.toMatchObject({
      code: 'SKILL_INVOCATION_FORBIDDEN',
    });
    expect(modelOnly.session.getHistory()).toEqual([]);
    expect(modelOnly.provider.requests).toEqual([]);
  });
  it('degrades catalog to actual remaining space instead of blocking a task that otherwise fits', async () => {
    const f = await fixture();
    await f.session.init();
    const window = createContextBudget(profile.contextWindow, profile.maxOutputTokens).inputBudget;
    const input = f.session.tools.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    const estimator = new UnicodeTokenEstimator();
    const base = new PromptAssembler({ rootDir: f.root, tools: f.session.tools }).assemble();
    // 留出技能再激活规则与环境消息，但不足以容纳完整目录；原任务应保留。
    const overhead = estimator.estimate({ systemPrompt: base, messages: [], tools: input }).total;
    const task = '中'.repeat(window - overhead - 160);
    const requests: ModelRequest[] = [];
    f.session.hooks.on('model:before', async (_ctx, request) => {
      requests.push(structuredClone({ ...request, signal: undefined }));
      return request;
    });
    const events = await consume(f.session.run(task));
    expect(f.provider.requests).toHaveLength(1);
    expect(events.some((event) => event.type === 'context_budget_exceeded')).toBe(false);
    expect(
      requests[0].messages.some((m) => m.content.some((b) => b.type === 'text' && b.text === task)),
    ).toBe(true);
  });
  it('closes a loaded transaction on early iterator return and reactivates on a new run', async () => {
    const f = await fixture('', [
      [
        { type: 'tool_call_finish', id: 'first', name: 'load_skill', input: { name: 'review' } },
        { type: 'message_stop' },
      ],
      [
        { type: 'tool_call_finish', id: 'second', name: 'load_skill', input: { name: 'review' } },
        { type: 'message_stop' },
      ],
      [{ type: 'text_delta', text: 'done' }, { type: 'message_stop' }],
    ]);
    for await (const event of f.session.run('first task')) {
      if (event.type === 'skill_loaded') {
        expect(f.session.getSkills().activations).toHaveLength(1);
        break;
      }
    }
    expect(f.session.isBusy()).toBe(false);
    expect(f.session.getSkills().activations).toHaveLength(0);
    expect(findDanglingToolUses(f.session.getHistory())).toEqual([]);
    const events = await consume(f.session.run('second task'));
    expect(events.filter((e) => e.type === 'skill_loaded')).toHaveLength(1);
    const second = f.session
      .getHistory()
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_result' && b.toolUseId === 'second');
    expect(second).toMatchObject({ skillSource: { invocationId: 'second' } });
    if (second?.type === 'tool_result') expect(second.content).not.toContain('already_present');
  });
  it('does not publish activation or call another model when commit audit fails, retaining closed history', async () => {
    const f = await fixture(
      '',
      [
        [
          { type: 'tool_call_finish', id: 'load', name: 'load_skill', input: { name: 'review' } },
          { type: 'message_stop' },
        ],
      ],
      true,
      {
        eventLogger: {
          record: async () => {},
          recordAudit: async (input) => {
            if (input.event === 'skill.loaded') throw new Error('audit unavailable');
          },
        },
      },
    );
    const events: SessionEvent[] = [];
    await expect(
      (async () => {
        for await (const event of f.session.run('task')) events.push(event);
      })(),
    ).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(events.some((e) => e.type === 'skill_loaded')).toBe(false);
    expect(f.provider.requests).toHaveLength(1);
    expect(f.session.getSkills().activations).toHaveLength(0);
    expect(findDanglingToolUses(await f.store!.load())).toEqual([]);
    expect(
      f.session
        .getHistory()
        .flatMap((m) => m.content)
        .some((b) => b.type === 'tool_result' && b.skillSource),
    ).toBe(true);
  });
  it('refuses continuation when a hook alters active body while retaining source metadata', async () => {
    const f = await fixture('', [
      [
        { type: 'tool_call_finish', id: 'load', name: 'load_skill', input: { name: 'review' } },
        { type: 'message_stop' },
      ],
    ]);
    f.session.hooks.on('model:before', async (_ctx, request) => {
      for (const message of request.messages)
        for (const block of message.content)
          if (block.type === 'tool_result' && block.skillSource)
            block.content = 'altered instructions';
      return request;
    });
    await expect(consume(f.session.run('task'))).rejects.toMatchObject({
      code: 'SKILL_CONTEXT_LOST',
    });
    expect(f.provider.requests).toHaveLength(1);
    expect(findDanglingToolUses(f.session.getHistory())).toEqual([]);
  });
  it('round trips user provenance through stateful storage without restoring old authorization', async () => {
    const f = await fixture('disable-model-invocation: true\n');
    const file = path.join(f.root, 'stateful.jsonl');
    const store = await SessionStore.create(file, {
      conversationId: 'stateful',
      projectRoot: f.root,
      initialCwd: f.root,
    });
    const config = {
      defaultProfile: profile,
      defaultProvider: f.provider,
      rootDir: f.root,
      skills: { roots: [{ path: path.join(f.root, 'skills'), scope: 'global' as const }] },
      store,
      loggingDirectory: path.join(f.root, 'stateful-logging'),
      userInstructionsPath: path.join(f.root, 'missing'),
    };
    const session = new AgentSession(config);
    await consume(session.runSkill('review', 'task'));
    const loaded = await (await SessionStore.open(file)).load();
    expect(loaded[0].content[1]).toMatchObject({
      type: 'text',
      skillSource: { version: 1, caller: 'user' },
    });
    const restored = new AgentSession({
      ...config,
      rootDir: f.dir,
      projectRoot: f.dir,
      skills: { roots: [] },
      store: await SessionStore.open(file),
    });
    await restored.init();
    expect(restored.getSkills().activations).toEqual([]);
    expect(restored.tools.get('read_skill_resource')).toBeUndefined();
    expect(restored.getHistory()[0].content[1]).toEqual(loaded[0].content[1]);
    await expect(consume(restored.runSkill('review', 'again'))).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
    });
  });
  it('preserves skill commit identity and resource read facts through the real audit field projector', async () => {
    const f = await fixture('', [
      [
        { type: 'tool_call_finish', id: 'load', name: 'load_skill', input: { name: 'review' } },
        { type: 'message_stop' },
      ],
      [
        {
          type: 'tool_call_finish',
          id: 'resource',
          name: 'read_skill_resource',
          input: { name: 'review', path: 'references/guide.md' },
        },
        { type: 'message_stop' },
      ],
      [{ type: 'message_stop' }],
    ]);
    await consume(f.session.run('review'));
    // 默认日志按会话分目录，以真实审计文件断言身份没有被白名单静默丢弃。
    const auditFiles: string[] = [];
    async function walk(dir: string) {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        const target = path.join(dir, item.name);
        if (item.isDirectory()) await walk(target);
        else if (item.name.includes('audit')) auditFiles.push(target);
      }
    }
    await walk(path.join(f.root, 'logging'));
    const records = (await Promise.all(auditFiles.map((file) => fs.readFile(file, 'utf8'))))
      .join('\n')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(records.find((r) => r.event === 'skill.loaded')?.fields).toMatchObject({
      skillName: 'review',
      skillScope: 'global',
      caller: 'model',
      invocationId: 'load',
      contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(records.find((r) => r.event === 'skill.resource_read')?.fields).toMatchObject({
      skillName: 'review',
      resourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      outputBytes: 17,
    });
    expect(JSON.stringify(records)).not.toContain('Check edge cases.');
  });
  it('honors explicit read ask through the host approval channel before adding any user message', async () => {
    const f = await fixture();
    const requestApproval = vi.fn(async () => 'allow_once' as const);
    const session = new AgentSession({
      defaultProfile: profile,
      defaultProvider: f.provider,
      rootDir: f.root,
      skills: { roots: [{ path: path.join(f.root, 'skills'), scope: 'global' }] },
      permissionRules: [{ action: 'ask', tool: 'load_skill' }],
      approvalChannel: { requestApproval },
      userInstructionsPath: path.join(f.root, 'missing'),
      loggingDirectory: path.join(f.root, 'ask-logging'),
    });
    await consume(session.runSkill('review', 'task'));
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(session.getHistory()[0].content[0]).toMatchObject({ type: 'text', text: 'task' });
  });
  it('loads, closes and persists a tool skill before granting resources', async () => {
    const f = await fixture(
      '',
      [
        [
          { type: 'tool_call_finish', id: 'load', name: 'load_skill', input: { name: 'review' } },
          {
            type: 'tool_call_finish',
            id: 'write',
            name: 'write_file',
            input: { path: 'blocked', content: 'bad' },
          },
          { type: 'message_stop' },
        ],
        [
          {
            type: 'tool_call_finish',
            id: 'resource',
            name: 'read_skill_resource',
            input: { name: 'review', path: 'references/guide.md' },
          },
          { type: 'message_stop' },
        ],
        [{ type: 'text_delta', text: 'done' }, { type: 'message_stop' }],
      ],
      true,
    );
    const prompts: string[] = [];
    f.session.hooks.on('model:before', async (_ctx, request) => {
      prompts.push(request.systemPrompt ?? '');
      return request;
    });
    const events = await consume(f.session.run('review the project'));
    expect(prompts[0]).toContain('L2.5 Available Skills');
    expect(events.some((event) => event.type === 'skill_loaded')).toBe(true);
    const finishes = events.filter((event) => event.type === 'tool_finish');
    expect(finishes.find((event) => event.id === 'write')?.result).toContain('SKILL_POLICY_DENIED');
    expect(finishes.find((event) => event.id === 'resource')?.result).toContain(
      'Check edge cases.',
    );
    const persisted = await f.store!.load();
    expect(
      persisted.some((m) =>
        m.content.some((b) => b.type === 'tool_result' && b.skillSource?.name === 'review'),
      ),
    ).toBe(true);
    expect(f.session.getSkills().activations).toHaveLength(0);
  });
  it('injects a user-only skill in one user message and keeps task text intact', async () => {
    const f = await fixture('disable-model-invocation: true\n', undefined, true);
    const task = 'Check "a b"  carefully\nthen report.';
    const events = await consume(f.session.runSkill('review', task));
    expect(events.some((event) => event.type === 'skill_loaded')).toBe(true);
    const user = (await f.store!.load()).find((m) =>
      m.content.some((b) => b.type === 'text' && b.skillSource),
    );
    expect(user?.content[0]).toMatchObject({ type: 'text', text: task });
    expect(user?.content[1]).toMatchObject({
      type: 'text',
      skillSource: { caller: 'user', name: 'review' },
    });
    expect(f.session.tools.get('load_skill')).toBeUndefined();
  });
  it('rejects preflight failure without user history and releases the run lock', async () => {
    const f = await fixture();
    await expect(consume(f.session.runSkill('missing', 'task'))).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
    });
    expect(f.session.getHistory()).toHaveLength(0);
    expect(f.session.isBusy()).toBe(false);
    expect(f.provider.requests).toHaveLength(0);
  });
});
