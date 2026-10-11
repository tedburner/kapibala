import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionApprovalCache } from '../src/capabilities/security/approval.js';
import { estimateSkillTokens } from '../src/capabilities/skills/catalog.js';
import { SkillRuntime } from '../src/capabilities/skills/loader.js';
import { SkillRegistry } from '../src/capabilities/skills/registry.js';
import { readFileTool, writeFileTool } from '../src/capabilities/tools/builtin/fs.js';
import { defineTool } from '../src/capabilities/tools/index.js';
import { ToolRegistry } from '../src/capabilities/tools/registry.js';
import { HookRegistry } from '../src/extensibility/hooks/registry.js';
import { type ExecutorOptions, ToolExecutor } from '../src/runtime/executor/index.js';
import type { CanonicalMessage, ToolUseBlock } from '../src/types/index.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
const call = (id: string, name: string, input: Record<string, unknown>): ToolUseBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
});
async function fixture(extra = 'allowed-tools: [Read]\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kpbl-runtime-'));
  dirs.push(root);
  const dir = path.join(root, 'review');
  await fs.mkdir(path.join(dir, 'references'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: review\ndescription: Review code\n${extra}---\nRead references/guide.md before reviewing.`,
  );
  await fs.writeFile(path.join(dir, 'references', 'guide.md'), 'Use evidence.');
  const registry = new SkillRegistry({ roots: [{ path: root, scope: 'global' }] });
  await registry.refresh();
  const tools = new ToolRegistry();
  tools.register(readFileTool);
  tools.register(writeFileTool);
  const history: CanonicalMessage[] = [];
  const runtime = new SkillRuntime(registry, tools);
  runtime.begin(
    'run-1',
    () => history,
    () => 9000,
  );
  runtime.syncTools();
  const hooks = new HookRegistry();
  const executor = new ToolExecutor({
    tools,
    hooks,
    rootDir: root,
    mode: 'FullAccess',
    hardDenial: (tool) => runtime.denial(tool),
    onToolResult: (tool, _input, result) => runtime.acceptResult(tool, result),
  });
  return { root, dir, runtime, registry, tools, history, executor, hooks };
}

describe('skill transaction and minimum permission', () => {
  it('reads committed global resources without expanding the ordinary workspace sandbox', async () => {
    const f = await fixture();
    const project = path.join(f.root, 'isolated-project');
    await fs.mkdir(project);
    const prepared = await f.runtime.prepare('review', 'user');
    f.history.push({
      id: 'user',
      role: 'user',
      content: [{ type: 'text', text: prepared.text, skillSource: prepared.source }],
    });
    f.runtime.acceptUser(prepared);
    await f.runtime.commit(async () => {}, 'memory');
    const executor = new ToolExecutor({
      tools: f.tools,
      hooks: f.hooks,
      rootDir: project,
      mode: 'FullAccess',
      hardDenial: (tool) => f.runtime.denial(tool),
    });
    const ordinary = await executor.executeOne(
      call('ordinary', 'read_file', {
        path: path.join(f.dir, 'references/guide.md'),
      }),
    );
    expect(ordinary.isError).toBe(true);
    expect(ordinary.content).not.toContain('Use evidence.');
    const resource = await executor.executeOne(
      call('resource', 'read_skill_resource', {
        name: 'review',
        path: 'references/guide.md',
      }),
    );
    expect(resource.isError).toBe(false);
    expect(resource.content).toContain('Use evidence.');
  });
  it('includes serialized newlines and provenance in a complete body budget', async () => {
    const f = await fixture();
    await fs.appendFile(path.join(f.dir, 'SKILL.md'), '\na\n'.repeat(3000));
    await f.registry.refresh();
    f.runtime.begin(
      'budget',
      () => f.history,
      () => 3000,
    );
    await expect(f.runtime.prepare('review', 'model')).rejects.toMatchObject({
      code: 'SKILL_BODY_BUDGET_EXCEEDED',
    });
  });
  it('marks resource listings truncated when depth hides files', async () => {
    const f = await fixture();
    const deep = path.join(f.dir, ...Array.from({ length: 7 }, (_, index) => `d-${index}`));
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(path.join(deep, 'hidden.md'), 'not pre-read');
    const prepared = await f.runtime.prepare('review', 'user');
    expect(prepared.text).toContain('Resources truncated: true');
    expect(prepared.text).not.toContain('not pre-read');
  });
  it('intersects multiple restrictions and refuses white-list escape even with cached approvals', async () => {
    const f = await fixture('allowed-tools: [Read, Write]\n');
    const dir = path.join(f.root, 'readonly');
    await fs.mkdir(dir);
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      '---\nname: readonly\ndescription: no writes\nallowed-tools: [Read]\n---\nInspect only.',
    );
    await f.registry.refresh();
    await f.executor.executeOne(call('first', 'load_skill', { name: 'review' }));
    expect(f.runtime.denial(writeFileTool)).toBeUndefined();
    await f.executor.executeOne(call('second', 'load_skill', { name: 'readonly' }));
    const cache = new SessionApprovalCache();
    cache.set(
      {
        toolName: 'write_file',
        capabilities: ['fs:write'],
        input: { path: 'blocked', content: 'x' },
        rootDir: f.root,
        sessionAllowed: true,
      },
      'allow',
    );
    const executor = new ToolExecutor({
      tools: f.tools,
      hooks: f.hooks,
      rootDir: f.root,
      mode: 'FullAccess',
      approvalCache: cache,
      hardDenial: (tool) => f.runtime.denial(tool),
    });
    expect(
      (await executor.executeOne(call('write', 'write_file', { path: 'blocked', content: 'x' })))
        .errorCode,
    ).toBe('SKILL_POLICY_DENIED');
    expect(f.runtime.denial(readFileTool)).toBeUndefined();
    f.runtime.clear();
    const open = await fixture('');
    await open.executor.executeOne(call('open', 'load_skill', { name: 'review' }));
    expect(open.runtime.denial(writeFileTool)).toBeUndefined();
    const empty = await fixture('allowed-tools: []\n');
    await empty.executor.executeOne(call('empty', 'load_skill', { name: 'review' }));
    expect(empty.runtime.denial(readFileTool)?.code).toBe('SKILL_POLICY_DENIED');
  });
  it('does not exempt same-named plugins or install a catalog loader over them', async () => {
    const f = await fixture('allowed-tools: []\n');
    const prepared = await f.runtime.prepare('review', 'user');
    f.runtime.acceptUser(prepared);
    const fake = defineTool({
      name: 'load_skill',
      description: 'fake',
      parameters: { type: 'object' },
      execute: async () => prepared.text,
    });
    f.tools.unregister('load_skill');
    f.tools.register(fake);
    f.runtime.syncTools();
    expect(f.tools.get('load_skill')).toBe(fake);
    expect(f.runtime.denial(fake)?.code).toBe('SKILL_POLICY_DENIED');
    f.runtime.clear();
    f.runtime.acceptResult(fake, {
      type: 'tool_result',
      toolUseId: 'fake',
      content: prepared.text,
    });
    expect(f.runtime.activations).toEqual([]);
    const unknown = await fixture('allowed-tools: [Unknown]\n');
    expect(
      (await unknown.executor.executeOne(call('bad', 'load_skill', { name: 'review' }))).errorCode,
    ).toBe('SKILL_UNSUPPORTED');
  });
  it('allows genuine skill control reads in Plan but preserves a host deny', async () => {
    const f = await fixture();
    const options: ExecutorOptions = {
      tools: f.tools,
      hooks: f.hooks,
      rootDir: f.root,
      mode: 'Plan',
      hardDenial: (tool) => f.runtime.denial(tool),
      onToolResult: (tool, _input, result) => f.runtime.acceptResult(tool, result),
    };
    expect(
      (await new ToolExecutor(options).executeOne(call('load', 'load_skill', { name: 'review' })))
        .isError,
    ).toBe(false);
    const denied = new ToolExecutor({
      ...options,
      permissionRules: [{ action: 'deny', capability: 'fs:read' }],
    });
    expect((await denied.executeOne(call('query', 'list_skills', {}))).errorCode).toBe(
      'PERMISSION_DENIED',
    );
  });
  it('deduplicates only complete bodies still present in the current projection', async () => {
    const f = await fixture();
    const calls = [call('first', 'load_skill', { name: 'review' })];
    const results = await f.executor.runAll(calls);
    f.history.push(
      { id: 'a', role: 'assistant', content: calls },
      { id: 't', role: 'tool', content: results },
    );
    await f.runtime.commit(async () => {}, 'memory');
    const repeated = await f.executor.executeOne(call('second', 'load_skill', { name: 'review' }));
    expect(repeated.content).toContain('already_present');
    expect(repeated.content).not.toContain('Read references/guide.md before reviewing.');
    f.history.splice(0);
    const reloaded = await f.executor.executeOne(call('third', 'load_skill', { name: 'review' }));
    expect(reloaded.content).toContain('Read references/guide.md before reviewing.');
  });
  it('restricts later calls in a batch, commits resource access only after history closes', async () => {
    const f = await fixture();
    const calls = [
      call('load', 'load_skill', { name: 'review' }),
      call('write', 'write_file', { path: 'blocked.txt', content: 'bad' }),
      call('early', 'read_skill_resource', { name: 'review', path: 'references/guide.md' }),
    ];
    const results = await f.executor.runAll(calls);
    expect(results[0]?.isError).toBe(false);
    expect(results[1]?.errorCode).toBe('SKILL_POLICY_DENIED');
    expect(results[2]).toMatchObject({
      errorCode: 'SKILL_NOT_COMMITTED',
      retryPolicy: 'immediate',
    });
    await expect(fs.stat(path.join(f.root, 'blocked.txt'))).rejects.toThrow();
    f.history.push(
      { id: 'assistant', role: 'assistant', content: calls },
      { id: 'results', role: 'tool', content: results },
    );
    const audit = vi.fn(async () => {});
    const events = await f.runtime.commit(audit, 'memory');
    expect(events[0]).toMatchObject({ type: 'skill_loaded', persistence: 'memory' });
    const read = await f.executor.executeOne(
      call('later', 'read_skill_resource', { name: 'review', path: 'references/guide.md' }),
    );
    expect(read.isError).toBe(false);
    expect(read.content).toContain('Use evidence.');
    f.runtime.clear();
    expect(f.runtime.denial(writeFileTool)).toBeUndefined();
  });
  it('does not activate when result processing fails and rejects permission patterns', async () => {
    const f = await fixture();
    f.hooks.on('tool:after', async (_ctx, tool) => {
      if (tool.name === 'load_skill') throw new Error('failed');
    });
    const failed = await f.executor.executeOne(call('load', 'load_skill', { name: 'review' }));
    expect(failed.isError).toBe(true);
    expect(f.runtime.denial(writeFileTool)).toBeUndefined();
    const pattern = await fixture('allowed-tools: Bash(git:*)\n');
    expect(
      (await pattern.executor.executeOne(call('pattern', 'load_skill', { name: 'review' })))
        .errorCode,
    ).toBe('SKILL_UNSUPPORTED');
  });
  it('blocks caller forgery and reads user-only resources after explicit activation', async () => {
    const f = await fixture('disable-model-invocation: true\n');
    await expect(f.runtime.prepare('review', 'model')).rejects.toMatchObject({
      code: 'SKILL_INVOCATION_FORBIDDEN',
    });
    const prepared = await f.runtime.prepare('review', 'user');
    f.history.push({
      id: 'user',
      role: 'user',
      content: [{ type: 'text', text: prepared.text, skillSource: prepared.source }],
    });
    f.runtime.acceptUser(prepared);
    await f.runtime.commit(async () => {}, 'memory');
    f.runtime.syncTools();
    expect(f.tools.get('load_skill')).toBeUndefined();
    expect(
      (
        await f.executor.executeOne(
          call('user-resource', 'read_skill_resource', {
            name: 'review',
            path: 'references/guide.md',
          }),
        )
      ).isError,
    ).toBe(false);
  });
  it('keeps resources confined to the skill and returns bounded continuations', async () => {
    const f = await fixture();
    const prepared = await f.runtime.prepare('review', 'user');
    f.history.push({
      id: 'user',
      role: 'user',
      content: [{ type: 'text', text: prepared.text, skillSource: prepared.source }],
    });
    f.runtime.acceptUser(prepared);
    await f.runtime.commit(async () => {}, 'memory');
    for (const denied of ['../outside.txt', f.root, 'C:\\outside', '\\\\server\\share']) {
      expect(
        (
          await f.executor.executeOne(
            call(denied, 'read_skill_resource', { name: 'review', path: denied }),
          )
        ).isError,
      ).toBe(true);
    }
    await fs.writeFile(path.join(f.dir, 'references', 'large.md'), '文'.repeat(30000));
    const first = await f.runtime.readResource({ name: 'review', path: 'references/large.md' });
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(65536);
    expect(first.nextOffset).toBeGreaterThan(0);
    const next = await f.runtime.readResource({
      name: 'review',
      path: 'references/large.md',
      offset: first.nextOffset,
    });
    expect(first.text + next.text).toBe('文'.repeat(30000));
    await fs.writeFile(path.join(f.dir, 'references/binary.bin'), Buffer.from([1, 0, 2]));
    await expect(
      f.runtime.readResource({ name: 'review', path: 'references/binary.bin' }),
    ).rejects.toMatchObject({ code: 'SKILL_RESOURCE_DENIED' });
    await fs.symlink(f.root, path.join(f.dir, 'external'), 'junction');
    await fs.writeFile(path.join(f.root, 'outside.md'), 'outside');
    await expect(
      f.runtime.readResource({ name: 'review', path: 'external/outside.md' }),
    ).rejects.toMatchObject({ code: 'SKILL_RESOURCE_DENIED' });
    await expect(
      f.runtime.readResource({ name: 'review', path: 'references' }),
    ).rejects.toMatchObject({ code: 'SKILL_RESOURCE_DENIED' });
    await fs.writeFile(path.join(f.dir, 'references/guide.md'), 'Updated resource.');
    expect(
      (await f.runtime.readResource({ name: 'review', path: 'references/guide.md' })).text,
    ).toBe('Updated resource.');
    await fs.appendFile(path.join(f.dir, 'SKILL.md'), '\nchanged');
    await expect(
      f.runtime.readResource({ name: 'review', path: 'references/guide.md' }),
    ).rejects.toMatchObject({ code: 'SKILL_CHANGED', retryPolicy: 'after_user_action' });
  });
  it('reserves pending body space and refuses deterministic invocation inputs without retrying internally', async () => {
    const f = await fixture();
    f.runtime.begin(
      'budget',
      () => f.history,
      () => 50,
    );
    await expect(f.runtime.prepare('review', 'model')).rejects.toMatchObject({
      code: 'SKILL_BODY_BUDGET_EXCEEDED',
      retryPolicy: 'after_user_action',
    });
    await expect(f.runtime.prepare('../outside', 'model')).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
      retryPolicy: 'never',
    });
    expect(f.runtime.activations).toEqual([]);
    f.runtime.begin(
      'budget',
      () => f.history,
      () => 9000,
    );
    const prepared = await f.runtime.prepare('review', 'model');
    f.runtime.begin(
      'budget',
      () => f.history,
      () =>
        estimateSkillTokens(
          JSON.stringify({
            type: 'tool_result',
            toolUseId: prepared.source.invocationId,
            content: prepared.text,
            skillSource: prepared.source,
          }),
        ) + 42,
    );
    const first = await f.executor.executeOne(
      call('first-budget', 'load_skill', { name: 'review' }),
    );
    expect(first.isError).toBe(false);
    const second = await f.executor.executeOne(
      call('second-budget', 'load_skill', { name: 'review' }),
    );
    expect(second.errorCode).toBe('SKILL_BODY_BUDGET_EXCEEDED');
  });
});
