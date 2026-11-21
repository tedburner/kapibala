import type { AgentSession } from '@kiturone/kapibala';
import type { SkillImportScan } from '@kiturone/kapibala-host/internal';
import { describe, expect, it, vi } from 'vitest';
import type { CommandOutput } from '../src/command-output.js';
import { COMMAND_CATALOG } from '../src/commands/catalog.js';
import type { CommandContext } from '../src/commands/dispatcher.js';
import { CommandDispatcher } from '../src/commands/dispatcher.js';
import { parseSkillImportArgs, skillCommand, skillsCommand } from '../src/commands/skills.js';

function output(): CommandOutput & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: (message) => lines.push(message),
    error: (message) => lines.push(message),
    write: (text) => lines.push(text),
  };
}

function scanFixture(): SkillImportScan {
  return {
    partial: false,
    diagnostics: [],
    sources: [
      {
        harness: 'claude-code',
        label: 'Claude Code',
        roots: [{ path: '/home/u/.claude/skills', scope: 'global', readable: true }],
        candidates: 2,
        partial: false,
        truncated: 0,
      },
      {
        harness: 'codex',
        label: 'Codex',
        roots: [],
        candidates: 1,
        partial: false,
        truncated: 0,
      },
    ],
    candidates: [
      {
        harness: 'claude-code',
        name: 'review-guide',
        directoryName: 'review-guide',
        description: 'Review code',
        sourceRef: '/home/u/.claude/skills/review-guide',
        origin: 'global',
        files: 2,
        bytes: 2048,
        hasScripts: false,
        strippedFields: ['model'],
        conflict: 'none',
      },
      {
        harness: 'claude-code',
        name: 'shared-name',
        directoryName: 'shared-name',
        description: 'One',
        sourceRef: '/home/u/.claude/skills/shared-name',
        origin: 'global',
        files: 1,
        bytes: 512,
        hasScripts: false,
        strippedFields: [],
        conflict: 'exists-enabled',
      },
      {
        harness: 'codex',
        name: 'shared-name',
        directoryName: 'shared-name',
        description: 'Two',
        sourceRef: '/home/u/.codex/skills/shared-name',
        origin: 'global',
        files: 1,
        bytes: 512,
        hasScripts: false,
        strippedFields: [],
        conflict: 'none',
      },
    ],
  };
}

function harness() {
  const out = output();
  const importSkills = vi.fn(async () => ({
    scope: 'global' as const,
    items: [
      {
        harness: 'claude-code',
        name: 'review-guide',
        status: 'imported' as const,
        targetPath: '/home/u/.kapibala/skills/review-guide',
      },
    ],
    imported: 1,
    unchanged: 0,
    skippedConflict: 0,
    skippedLimit: 0,
    failed: 0,
    truncated: 0,
    diagnostics: [],
  }));
  const context: CommandContext = {
    session: {
      isBusy: () => false,
      getSkills: () => ({
        enabled: true,
        skills: [
          {
            name: 'review-guide',
            scope: 'global',
            available: true,
            userInvocable: true,
            modelInvocable: true,
            disabled: false,
            description: 'Review code',
            sourceRoot: '/home/u/.kapibala/skills',
            filePath: '/home/u/.kapibala/skills/review-guide/SKILL.md',
          },
        ],
        diagnostics: [
          { code: 'SKILL_SHADOWED', level: 'warn', path: '/p/SKILL.md', message: '覆盖' },
        ],
        roots: [
          { path: '/home/u/.kapibala/skills', scope: 'global', kind: 'native', trusted: true },
        ],
        lifecycle: [
          {
            phase: 'discovered',
            name: 'review-guide',
            scope: 'global',
            sourceRoot: '/home/u/.kapibala/skills',
            filePath: '/home/u/.kapibala/skills/review-guide/SKILL.md',
          },
        ],
        activations: [],
        catalog: { included: 1, omitted: 0 },
      }),
    } as unknown as AgentSession,
    settings: { defaultModel: 'x', profiles: [] },
    output: out,
    onModelSwitched: () => {},
    onExit: () => {},
    scanImportableSkills: async () => scanFixture(),
    importSkills,
  };
  const dispatcher = new CommandDispatcher();
  for (const name of ['skills', 'skill'])
    dispatcher.registerDefinition(
      COMMAND_CATALOG.find((definition) => definition.name === name)!,
      name === 'skills' ? skillsCommand : skillCommand,
    );
  return { context, dispatcher, out, importSkills };
}

describe('parseSkillImportArgs', () => {
  it('接受名称、全部与来源/作用域/覆盖选项', () => {
    expect(parseSkillImportArgs('').value).toEqual({
      all: false,
      scope: 'global',
      overwrite: false,
    });
    expect(parseSkillImportArgs('demo --from codex --project --force').value).toEqual({
      all: false,
      name: 'demo',
      from: 'codex',
      scope: 'project',
      overwrite: true,
    });
    expect(parseSkillImportArgs('--all').value?.all).toBe(true);
  });
  it('拒绝未知来源、未知选项与 --all 和名称并用', () => {
    expect(parseSkillImportArgs('demo --from claude').error).toContain('未知来源');
    expect(parseSkillImportArgs('--nope').error).toContain('未知选项');
    expect(parseSkillImportArgs('--all demo').error).toContain('不能同时使用');
  });
});

describe('/skills inspect', () => {
  it('输出发现环境、技能来源与生命周期事件', async () => {
    const { dispatcher, context, out } = harness();
    await dispatcher.dispatch('/skills inspect', context);
    const text = out.lines.join('\n');
    expect(text).toContain('发现模式: 已启用');
    expect(text).toContain('[global/native] 已信任');
    expect(text).toContain('生命周期事件');
    expect(text).toContain('[SKILL_SHADOWED]');
  });

  it('--json 与文本视图同源', async () => {
    const { dispatcher, context, out } = harness();
    await dispatcher.dispatch('/skills inspect --json', context);
    const payload = JSON.parse(out.lines.join('\n')) as {
      enabled: boolean;
      roots: unknown[];
      lifecycle: unknown[];
    };
    expect(payload.enabled).toBe(true);
    expect(payload.roots).toHaveLength(1);
    expect(payload.lifecycle).toHaveLength(1);
  });
});

describe('/skill import', () => {
  it('无参时只列出候选，不触碰导入', async () => {
    const { dispatcher, context, out, importSkills } = harness();
    await dispatcher.dispatch('/skill import', context);
    expect(importSkills).not.toHaveBeenCalled();
    const text = out.lines.join('\n');
    expect(text).toContain('可导入来源');
    expect(text).toContain('review-guide');
    expect(text).toContain('已存在（启用）');
  });

  it('--all 带来源身份执行，并打印五桶汇总', async () => {
    const { dispatcher, context, out, importSkills } = harness();
    await dispatcher.dispatch('/skill import --all --from claude-code', context);
    expect(importSkills).toHaveBeenCalledWith({
      scope: 'global',
      overwrite: false,
      items: [
        {
          harness: 'claude-code',
          name: 'review-guide',
          expectedSourceRef: '/home/u/.claude/skills/review-guide',
        },
        {
          harness: 'claude-code',
          name: 'shared-name',
          expectedSourceRef: '/home/u/.claude/skills/shared-name',
        },
      ],
    });
    expect(out.lines.join('\n')).toContain('导入完成');
  });

  it('同名跨来源要求 --from，不猜一个', async () => {
    const { dispatcher, context, out, importSkills } = harness();
    await dispatcher.dispatch('/skill import shared-name', context);
    expect(importSkills).not.toHaveBeenCalled();
    expect(out.lines.join('\n')).toContain('--from');
  });

  it('列目录不是变更操作，--all 是变更操作', () => {
    const definition = COMMAND_CATALOG.find((item) => item.name === 'skill')!;
    expect(definition.mutates(['import'])).toBe(false);
    expect(definition.mutates(['import --all'])).toBe(true);
    expect(definition.validate(['import --all'])).toBeUndefined();
  });
});
