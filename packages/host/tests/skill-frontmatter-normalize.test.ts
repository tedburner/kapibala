import { describe, expect, it } from 'vitest';
import { normalizeImportedSkill } from '../src/host/resource/skill-import.js';

const FILE = '/skills/demo/SKILL.md';

function doc(header: string, body = 'Body.'): string {
  return `---\n${header}\n---\n${body}`;
}

describe('normalizeImportedSkill', () => {
  it('没有需要剥离的字段时原样返回（保持来源字节）', () => {
    const content = doc(
      'name: demo\ndescription: "Help: with # demo"\nlicense: MIT\nallowed-tools: [Read, Grep]\nwhen_to_use: When demo',
    );
    const result = normalizeImportedSkill(content, FILE);
    expect(result.content).toBe(content);
    expect(result.strippedFields).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('剥离执行扩展与未知字段，并保留合法字段与正文', () => {
    const content = doc(
      'name: demo\ndescription: Demo\ncontext: fork\nagent: coder\nmodel: claude-3\neffort: high\nhooks:\n  pre: run\ncustom-field: 1',
      'Body of demo.',
    );
    const result = normalizeImportedSkill(content, FILE);
    expect(result.strippedFields).toEqual([
      'context',
      'agent',
      'model',
      'effort',
      'hooks',
      'custom-field',
    ]);
    expect(result.content).not.toContain('context:');
    expect(result.content).not.toContain('model:');
    expect(result.content).not.toContain('custom-field');
    expect(result.content).toContain('name: demo');
    expect(result.content).toContain('description: Demo');
    expect(result.content).toContain('Body of demo.');
    expect(result.diagnostics[0]?.code).toBe('SKILL_IMPORT_FIELD_STRIPPED');
    // 归一后的内容必须仍能被 core 解析成同名技能。
    expect(result.document.name).toBe('demo');
  });

  it('allowed-tools 含参数模式时整条丢弃', () => {
    const content = doc(
      'name: demo\ndescription: Demo\nallowed-tools: ["Bash(git:*)", Read]\nmodel: x',
    );
    const result = normalizeImportedSkill(content, FILE);
    expect(result.strippedFields).toEqual(['model', 'allowed-tools']);
    expect(result.content).not.toContain('allowed-tools');
    expect(result.diagnostics.some((item) => item.code === 'SKILL_IMPORT_TOOLS_DROPPED')).toBe(
      true,
    );
  });

  it('metadata 与布尔开关按可解析格式保留', () => {
    const content = doc(
      'name: demo\ndescription: Demo\nmetadata:\n  owner: team-a\ndisable-model-invocation: true\nmodel: x',
    );
    const result = normalizeImportedSkill(content, FILE);
    expect(result.strippedFields).toEqual(['model']);
    expect(result.content).toContain('metadata:');
    expect(result.content).toContain('  owner: team-a');
    expect(result.content).toContain('disable-model-invocation: true');
  });

  it('正文动态 shell 只诊断不改写', () => {
    const content = doc('name: demo\ndescription: Demo\nmodel: x', 'Run !`git status`.');
    const result = normalizeImportedSkill(content, FILE);
    expect(result.content).toContain('Run !`git status`.');
    expect(result.diagnostics.some((item) => item.code === 'SKILL_IMPORT_DYNAMIC_SHELL')).toBe(
      true,
    );
  });
});
