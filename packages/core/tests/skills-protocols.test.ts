import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileTool } from '../src/capabilities/tools/builtin/fs.js';
import { SessionStore } from '../src/context/session-store.js';
import { AgentSession } from '../src/context/session/index.js';
import { AnthropicProvider } from '../src/models/anthropic/index.js';
import type { ModelProfile } from '../src/models/index.js';
import { OpenAICompatibleProvider } from '../src/models/openai-compatible/index.js';
import { OpenAIResponsesProvider } from '../src/models/openai-responses/index.js';
import type { SessionEvent } from '../src/types/index.js';
import { findDanglingToolUses } from './helpers/mock.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
function response(
  protocol: ModelProfile['provider'],
  id: string,
  name?: string,
  input?: unknown,
  text = 'done',
): Response {
  if (protocol === 'openai-compatible')
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: name ? { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } : { content: text }, finish_reason: name ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
  const events =
    protocol === 'openai-responses'
      ? [
          {
            type: 'response.completed',
            response: {
              id,
              status: 'completed',
              output: name
                ? [
                    {
                      type: 'reasoning',
                      id: `reason-${id}`,
                      encrypted_content: `PRIVATE-${id}`,
                      summary: [],
                      status: 'completed',
                    },
                    {
                      type: 'function_call',
                      id: `fc-${id}`,
                      call_id: id,
                      name,
                      arguments: JSON.stringify(input),
                      status: 'completed',
                    },
                  ]
                : [
                    {
                      type: 'message',
                      id: `msg-${id}`,
                      role: 'assistant',
                      status: 'completed',
                      content: [{ type: 'output_text', text, annotations: [] }],
                    },
                  ],
            },
          },
        ]
      : [
          {
            type: 'message_start',
            message: {
              id,
              type: 'message',
              role: 'assistant',
              content: [],
              usage: { input_tokens: 10 },
            },
          },
          ...(name
            ? [
                {
                  type: 'content_block_start',
                  index: 0,
                  content_block: {
                    type: 'thinking',
                    thinking: 'read the skill',
                    signature: `PRIVATE-${id}`,
                  },
                },
                { type: 'content_block_stop', index: 0 },
              ]
            : []),
          {
            type: 'content_block_start',
            index: name ? 1 : 0,
            content_block: name ? { type: 'tool_use', id, name, input } : { type: 'text', text },
          },
          { type: 'content_block_stop', index: name ? 1 : 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: name ? 'tool_use' : 'end_turn' },
            usage: { output_tokens: 10 },
          },
          { type: 'message_stop' },
        ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
  );
}

describe('skills across three protocol adapters', () => {
  it.each(['anthropic', 'openai-responses', 'openai-compatible'] as const)(
    'keeps %s provenance local and closes load/resource/dedup/denied-write transactions',
    async (protocol) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kpbl-skill-protocol-'));
      dirs.push(root);
      const skills = path.join(root, 'skills');
      const dir = path.join(skills, 'guide');
      await fs.mkdir(path.join(dir, 'references'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'SKILL.md'),
        `---\nname: guide\ndescription: 中文多行审查\nallowed-tools: []\n---\n先读 references/guide.md，保留证据。\n${'记录真实证据，不执行脚本。'.repeat(300)}`,
      );
      await fs.writeFile(path.join(dir, 'references/guide.md'), '资源证据');
      const requests: Record<string, unknown>[] = [];
      const sequence = [
        response(protocol, 'load', 'load_skill', { name: 'guide' }),
        response(protocol, 'resource', 'read_skill_resource', {
          name: 'guide',
          path: 'references/guide.md',
        }),
        response(protocol, 'dedup', 'load_skill', { name: 'guide' }),
        response(protocol, 'invalid', 'read_skill_resource', { name: 'guide', path: '../outside' }),
        response(protocol, 'denied', 'write_file', { path: 'blocked.txt', content: 'bad' }),
        response(protocol, 'final'),
        response(protocol, 'explicit'),
        response(
          protocol,
          'summary',
          undefined,
          undefined,
          JSON.stringify({
            schemaVersion: 1,
            goal: 'continue',
            constraints: [],
            decisions: [],
            completedWork: [],
            pendingWork: [],
            references: [],
            unknownEffects: [],
          }),
        ),
        response(protocol, 'cancel', 'load_skill', { name: 'guide' }),
      ];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, init) => {
          requests.push(JSON.parse(init.body));
          return sequence.shift()!;
        }),
      );
      const profile: ModelProfile = {
        id: protocol,
        name: protocol,
        provider: protocol,
        modelName: 'fixture',
        baseURL: 'https://example.test/v1',
        apiKeyEnv: 'NONE',
        contextWindow: 128000,
      };
      const options = { modelName: 'fixture', baseURL: profile.baseURL, apiKey: 'fixture-key' };
      const provider =
        protocol === 'anthropic'
          ? new AnthropicProvider(options)
          : protocol === 'openai-responses'
            ? new OpenAIResponsesProvider(options)
            : new OpenAICompatibleProvider(options);
      const store = await SessionStore.create(path.join(root, 'history.jsonl'), {
        conversationId: 'protocol',
        projectRoot: root,
        initialCwd: root,
      });
      const session = new AgentSession({
        defaultProfile: profile,
        defaultProvider: provider,
        skills: { roots: [{ path: skills, scope: 'global' }] },
        store,
        rootDir: root,
        userInstructionsPath: path.join(root, 'missing'),
        loggingDirectory: path.join(root, 'logging'),
        mode: 'FullAccess',
      });
      session.tools.register(writeFileTool);
      const events: SessionEvent[] = [];
      for await (const event of session.run('请按技能审查')) events.push(event);
      const finishes = events.filter((event) => event.type === 'tool_finish');
      expect(finishes.find((event) => event.id === 'resource')?.result).toContain('资源证据');
      expect(finishes.find((event) => event.id === 'dedup')?.result).toContain('already_present');
      expect(finishes.find((event) => event.id === 'invalid')?.result).toContain(
        'SKILL_RESOURCE_DENIED',
      );
      expect(finishes.find((event) => event.id === 'denied')?.result).toContain(
        'SKILL_POLICY_DENIED',
      );
      expect(events.filter((event) => event.type === 'skill_loaded')).toHaveLength(1);
      const wire = JSON.stringify(requests);
      expect(wire).not.toContain('skillSource');
      expect(wire).not.toContain('renderedDigest');
      expect(wire).toContain('先读 references/guide.md');
      expect(findDanglingToolUses(await store.load())).toEqual([]);
      expect(session.getSkills().activations).toEqual([]);
      for await (const _ of session.runSkill('guide', '用户原始任务 "a  b"\n第二行')) {
        /* drain */
      }
      expect(requests).toHaveLength(7);
      expect(findDanglingToolUses(await store.load())).toEqual([]);
      const compact: SessionEvent[] = [];
      for await (const event of session.compact()) compact.push(event);
      expect(compact.some((event) => event.type === 'compaction_finish')).toBe(true);
      expect(JSON.stringify(session.getContextHistory())).toContain('requires_reload');
      expect(findDanglingToolUses(session.getContextHistory())).toEqual([]);
      for await (const event of session.run('取消技能任务'))
        if (event.type === 'skill_loaded') break;
      expect(session.getLastRunMetrics()?.status).toBe('aborted');
      expect(session.isBusy()).toBe(false);
      expect(session.getSkills().activations).toEqual([]);
      expect(findDanglingToolUses(await store.load())).toEqual([]);
      const restored = new AgentSession({
        defaultProfile: profile,
        defaultProvider: provider,
        store: await SessionStore.open(store.filePath),
        rootDir: root,
        skills: { roots: [] },
        userInstructionsPath: path.join(root, 'missing'),
        loggingDirectory: path.join(root, 'restore-logs'),
      });
      await restored.init();
      expect(restored.getSkills().activations).toEqual([]);
      expect(
        restored
          .getHistory()
          .flatMap((message) => message.content)
          .some((block) => block.type === 'text' && block.skillSource?.caller === 'user'),
      ).toBe(true);
      await session.destroy();
      await restored.destroy();
    },
  );
});
