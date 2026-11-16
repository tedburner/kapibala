import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime, ToolRegistry } from '@kiturone/kapibala';
import { describe, expect, it } from 'vitest';
import { registerBuiltinTools } from '../src/host/tool-registration.js';
import { formatMcpToolLabel, resolveToolDisplay } from '../src/host/ui/tool-presentation.js';

describe('tool display registry gate', () => {
  it('resolves a display entry for every tool registered by registerBuiltinTools', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-tool-display-'));
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, {
      cwd,
      detect: () => ({
        kind: 'bash',
        executable: '/bin/bash',
        executableDigest: 'test',
        cwd,
      }),
      runtime: new AgentRuntime(),
    });
    const names = registry.list().map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const display = resolveToolDisplay(name);
      // 门禁语义：登记 = 命中显示名表（表内所有条目都带中文动词）；未登记会走未知回退，无 verb。
      expect(display.verb, `内置工具 '${name}' 未登记显示名表`).toBeTruthy();
      expect(display.label.length).toBeGreaterThan(0);
    }
  });

  it('resolves skill runtime tools defined in core (registered dynamically per session)', () => {
    // 技能工具由 SkillRuntime.syncTools 按会话动态注册（core/src/capabilities/skills/loader.ts），
    // 不经 registerBuiltinTools；此处显式断言三个名字都在显示名表命中，防止改名后漏登记。
    for (const name of ['load_skill', 'list_skills', 'read_skill_resource']) {
      expect(resolveToolDisplay(name).verb, `技能工具 '${name}' 未登记显示名表`).toBeTruthy();
    }
  });

  it('normalizes mcp tool names into the same server/tool label as /mcp', () => {
    const display = resolveToolDisplay('mcp__doc-server__read_file');
    expect(display.label).toBe(formatMcpToolLabel('doc-server', 'read_file'));
    expect(display.label).toBe('doc-server · read_file');
    expect(display.mono).toBe(true);
  });

  it('falls back gracefully for unknown tools without throwing or returning empty labels', () => {
    const unknown = resolveToolDisplay('some_unknown_plugin_tool');
    expect(unknown.label).toBe('Some unknown plugin tool');
    expect(unknown.label.length).toBeLessThanOrEqual(24);
    const prefixed = resolveToolDisplay('mcp__server__a__b');
    expect(prefixed.label).toBe('server · a__b');
    // 畸形输入不抛错、不返回空串。
    expect(resolveToolDisplay('').label.length).toBeGreaterThan(0);
    expect(resolveToolDisplay('___').label.length).toBeGreaterThan(0);
  });
});
