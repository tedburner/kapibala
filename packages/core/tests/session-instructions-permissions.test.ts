import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelProfile } from '../src/models/index.js';
import { AgentSession } from '../src/session/index.js';
import { defineTool } from '../src/tools/index.js';
import { ScriptedProvider } from './helpers/mock.js';

const profile: ModelProfile = {
  id: 'p',
  name: 'P',
  provider: 'openai-compatible',
  baseURL: 'http://127.0.0.1:9/v1',
  apiKeyEnv: 'NONE',
  modelName: 'm',
};

describe('session instruction and mode snapshots', () => {
  const dirs: string[] = [];
  const temp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-session-instructions-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refreshes instructions between runs while Plan filters model tools', async () => {
    const root = temp();
    const instruction = path.join(root, 'AGENTS.md');
    fs.writeFileSync(instruction, 'first instruction: approve write');
    const provider = new ScriptedProvider([
      [{ type: 'text_delta', text: 'one' }, { type: 'message_stop' }],
      [{ type: 'text_delta', text: 'two' }, { type: 'message_stop' }],
    ]);
    const session = new AgentSession({
      defaultProfile: profile,
      defaultProvider: provider,
      rootDir: root,
      mode: 'Plan',
      userInstructionsPath: path.join(root, 'missing-user-agents.md'),
      loggingDirectory: path.join(root, 'logging'),
    });
    session.tools.register(
      defineTool({
        name: 'read',
        description: 'Read',
        parameters: {},
        metadata: { permissions: ['fs:read'] },
        async execute() {
          return 'read';
        },
      }),
    );
    session.tools.register(
      defineTool({
        name: 'write',
        description: 'Write',
        parameters: {},
        metadata: { permissions: ['fs:write'] },
        async execute() {
          return 'write';
        },
      }),
    );
    const prompts: string[] = [];
    const lists: string[][] = [];
    session.hooks.on('model:before', async (_ctx, request) => {
      prompts.push(request.systemPrompt ?? '');
      lists.push((request.tools ?? []).map((tool) => tool.name));
      return request;
    });
    for await (const _event of session.run('first')) {
      /* consume */
    }
    expect(lists[0]).toEqual(['read']);
    expect(prompts[0]).toContain('first instruction: approve write');
    expect(prompts[0]).not.toContain('**write**');
    fs.writeFileSync(instruction, 'second instruction');
    session.switchMode('Auto');
    for await (const _event of session.run('second')) {
      /* consume */
    }
    expect(lists[1]).toEqual(['read', 'write']);
    expect(prompts[1]).toContain('second instruction');
    expect(session.getInstructionSources()).toEqual([instruction]);
  });

  it('fails first instruction load but retains a previous snapshot on later failure', async () => {
    const root = temp();
    const instruction = path.join(root, 'AGENTS.md');
    fs.writeFileSync(instruction, 'good');
    const session = new AgentSession({
      defaultProfile: profile,
      defaultProvider: new ScriptedProvider([]),
      rootDir: root,
      userInstructionsPath: path.join(root, 'missing'),
      loggingDirectory: path.join(root, 'logging'),
    });
    for await (const _event of session.run('first')) {
      /* consume */
    }
    fs.writeFileSync(instruction, 'x'.repeat(32 * 1024 + 1));
    for await (const _event of session.run('second')) {
      /* consume */
    }
    expect(session.getInstructionSources()).toEqual([instruction]);
    const fresh = new AgentSession({
      defaultProfile: profile,
      defaultProvider: new ScriptedProvider([]),
      rootDir: root,
      userInstructionsPath: path.join(root, 'missing'),
      loggingDirectory: path.join(root, 'logging'),
    });
    await expect(async () => {
      for await (const _event of fresh.run('new')) {
        /* consume */
      }
    }).rejects.toThrow(/32 KiB/);
  });
});
