import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SKILL_PROVENANCE_FILE,
  diffImportedSkill,
  importSkills,
  readImportedSkillProvenance,
  scanImportableSkills,
} from '../src/host/resource/skill-import.js';
import { type UserSettings, createUserSettingsSkeleton } from '../src/host/settings.js';

const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** 在指定来源根写入一个技能包；frontmatter 追加内容由测试决定。 */
function writeSourceSkill(root: string, name: string, extra = '', body = `Body of ${name}.`): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Help with ${name}\n${extra}---\n${body}`,
  );
}

function settingsWith(disabled: string[] = []): UserSettings {
  const settings = createUserSettingsSkeleton();
  settings.skills = { enabled: true, disabled };
  return settings;
}

function readSettings(home: string): { skills?: { disabled?: string[] } } {
  return JSON.parse(fs.readFileSync(path.join(home, '.kapibala', 'settings.json'), 'utf8')) as {
    skills?: { disabled?: string[] };
  };
}

describe('scanImportableSkills', () => {
  it('只在来源目录存在时扫描，并给出冲突与剥离预览', async () => {
    const home = temp('kpbl-import-scan-');
    const project = temp('kpbl-import-scan-proj-');
    const sourceRoot = path.join(home, '.claude', 'skills');
    writeSourceSkill(sourceRoot, 'review-guide', 'model: claude-3-5\n');
    const targetDir = path.join(home, '.kapibala', 'skills', 'review-guide');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, 'SKILL.md'),
      '---\nname: review-guide\ndescription: old\n---\nold',
    );

    const scan = await scanImportableSkills({
      homeDir: home,
      projectRoot: project,
      projectTrusted: false,
      settings: settingsWith(),
    });
    const candidate = scan.candidates.find((item) => item.name === 'review-guide');
    expect(candidate).toBeDefined();
    expect(candidate?.harness).toBe('claude-code');
    expect(candidate?.strippedFields).toContain('model');
    expect(candidate?.conflict).toBe('exists-enabled');
    // 未信任项目不扫描项目级来源，也不产生不可读告警。
    expect(scan.sources.find((item) => item.harness === 'claude-code')?.roots).toHaveLength(1);
    expect(scan.diagnostics.some((item) => item.code === 'import_source_unreadable')).toBe(false);
  });

  it('单来源候选超过上限时截断并标记 partial', async () => {
    const home = temp('kpbl-import-limit-');
    const sourceRoot = path.join(home, '.codex', 'skills');
    for (let i = 0; i < 201; i++)
      writeSourceSkill(sourceRoot, `skill-${String(i).padStart(3, '0')}`);
    const scan = await scanImportableSkills({
      homeDir: home,
      projectRoot: temp('kpbl-import-limit-proj-'),
      projectTrusted: false,
      settings: settingsWith(),
    });
    const source = scan.sources.find((item) => item.harness === 'codex');
    expect(scan.partial).toBe(true);
    expect(source?.truncated).toBeGreaterThan(0);
    expect(scan.candidates).toHaveLength(200);
  });
});

describe('importSkills', () => {
  it('归一 frontmatter、复制资源、写溯源，且不执行来源脚本', async () => {
    const home = temp('kpbl-import-ok-');
    const project = temp('kpbl-import-ok-proj-');
    const sourceDir = path.join(home, '.claude', 'skills', 'review-guide');
    writeSourceSkill(
      path.join(home, '.claude', 'skills'),
      'review-guide',
      'context: fork\nmodel: claude-3-5\n',
    );
    fs.mkdirSync(path.join(sourceDir, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, 'scripts', 'run.sh'),
      `#!/bin/sh\ntouch "${path.join(home, 'executed-marker')}"\n`,
    );
    fs.writeFileSync(path.join(sourceDir, 'reference.md'), 'reference');

    const scan = await scanImportableSkills({
      homeDir: home,
      projectRoot: project,
      projectTrusted: true,
      settings: settingsWith(),
    });
    const candidate = scan.candidates.find((item) => item.name === 'review-guide');
    expect(candidate?.files).toBe(3);
    expect(candidate?.hasScripts).toBe(true);

    const result = await importSkills({
      homeDir: home,
      projectRoot: project,
      projectTrusted: true,
      settings: settingsWith(),
      scope: 'global',
      items: [],
    });
    expect(result.imported).toBe(1);
    const targetDir = path.join(home, '.kapibala', 'skills', 'review-guide');
    const skill = fs.readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8');
    expect(skill).not.toContain('context:');
    expect(skill).not.toContain('model:');
    expect(skill).toContain('Body of review-guide.');
    expect(fs.readFileSync(path.join(targetDir, 'reference.md'), 'utf8')).toBe('reference');
    expect(fs.existsSync(path.join(home, 'executed-marker'))).toBe(false);

    const provenance = await readImportedSkillProvenance(targetDir);
    expect(provenance?.harness).toBe('claude-code');
    expect(provenance?.sourceRef).toBe(sourceDir);
    expect(provenance?.strippedFields).toEqual(['context', 'model']);
    expect(provenance?.installedDigest.startsWith('sha256:')).toBe(true);
    expect(fs.existsSync(path.join(targetDir, SKILL_PROVENANCE_FILE))).toBe(true);
  });

  it('默认跳过冲突，显式覆盖时把旧副本移出技能根', async () => {
    const home = temp('kpbl-import-conflict-');
    const project = temp('kpbl-import-conflict-proj-');
    writeSourceSkill(path.join(home, '.claude', 'skills'), 'review-guide', '', 'new body');
    const targetDir = path.join(home, '.kapibala', 'skills', 'review-guide');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, 'SKILL.md'),
      '---\nname: review-guide\ndescription: old\n---\nold',
    );
    const base = {
      homeDir: home,
      projectRoot: project,
      projectTrusted: true,
      settings: settingsWith(),
      scope: 'global' as const,
      items: [],
    };
    const skipped = await importSkills(base);
    expect(skipped.skippedConflict).toBe(1);
    expect(fs.readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8')).toContain('old');

    const overwritten = await importSkills({ ...base, overwrite: true });
    expect(overwritten.imported).toBe(1);
    expect(fs.readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8')).toContain('new body');
    const backups = fs.readdirSync(path.join(home, '.kapibala', '.skill-backups'));
    expect(backups).toHaveLength(1);
    // 备份目录必须在技能根之外，不能被发现链扫成新技能。
    expect(fs.existsSync(path.join(home, '.kapibala', 'skills', '.skill-backups'))).toBe(false);
  });

  it('内容相同返回 unchanged 且不写盘', async () => {
    const home = temp('kpbl-import-unchanged-');
    const project = temp('kpbl-import-unchanged-proj-');
    writeSourceSkill(path.join(home, '.claude', 'skills'), 'review-guide');
    const options = {
      homeDir: home,
      projectRoot: project,
      projectTrusted: true,
      settings: settingsWith(),
      scope: 'global' as const,
      items: [],
    };
    expect((await importSkills(options)).imported).toBe(1);
    const targetSkill = path.join(home, '.kapibala', 'skills', 'review-guide', 'SKILL.md');
    const before = fs.statSync(targetSkill).mtimeMs;
    const second = await importSkills(options);
    expect(second.unchanged).toBe(1);
    expect(fs.statSync(targetSkill).mtimeMs).toBe(before);
  });

  it('expectedSourceRef 不一致时拒绝并说明重新扫描', async () => {
    const home = temp('kpbl-import-toctou-');
    const project = temp('kpbl-import-toctou-proj-');
    writeSourceSkill(path.join(home, '.claude', 'skills'), 'review-guide');
    const result = await importSkills({
      homeDir: home,
      projectRoot: project,
      projectTrusted: true,
      settings: settingsWith(),
      scope: 'global',
      items: [
        {
          harness: 'claude-code',
          name: 'review-guide',
          expectedSourceRef: path.join(home, '.claude', 'skills', 'other'),
        },
      ],
    });
    expect(result.failed).toBe(1);
    expect(fs.existsSync(path.join(home, '.kapibala', 'skills', 'review-guide'))).toBe(false);
  });

  it('未信任项目拒绝项目级导入', async () => {
    const home = temp('kpbl-import-untrusted-');
    const project = temp('kpbl-import-untrusted-proj-');
    await expect(
      importSkills({
        homeDir: home,
        projectRoot: project,
        projectTrusted: false,
        settings: settingsWith(),
        scope: 'project',
        items: [],
      }),
    ).rejects.toThrow(/信任/);
    expect(fs.existsSync(path.join(project, '.kapibala', 'skills'))).toBe(false);
  });

  it('符号链接越界跳过且不复制到目标', async (context) => {
    const home = temp('kpbl-import-symlink-');
    const project = temp('kpbl-import-symlink-proj-');
    const sourceRoot = path.join(home, '.claude', 'skills');
    writeSourceSkill(sourceRoot, 'review-guide');
    const outside = path.join(home, 'outside.txt');
    fs.writeFileSync(outside, 'outside');
    try {
      fs.symlinkSync(outside, path.join(sourceRoot, 'review-guide', 'outside-link.txt'));
    } catch {
      // Windows 未开开发者模式时创建符号链接需要特权；此环境无法构造该用例。
      context.skip();
      return;
    }

    const result = await importSkills({
      homeDir: home,
      projectRoot: project,
      projectTrusted: true,
      settings: settingsWith(),
      scope: 'global',
      items: [],
    });
    expect(result.imported).toBe(1);
    expect(
      fs.existsSync(path.join(home, '.kapibala', 'skills', 'review-guide', 'outside-link.txt')),
    ).toBe(false);
    expect(result.diagnostics.some((item) => item.code === 'import_symlink_skipped')).toBe(true);
  });

  it('导入成功后把名字从禁用列表移除（默认保持启用）', async () => {
    const home = temp('kpbl-import-enable-');
    const project = temp('kpbl-import-enable-proj-');
    writeSourceSkill(path.join(home, '.claude', 'skills'), 'review-guide');
    fs.mkdirSync(path.join(home, '.kapibala'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.kapibala', 'settings.json'),
      JSON.stringify({
        ...createUserSettingsSkeleton(),
        skills: { enabled: true, disabled: ['review-guide'] },
      }),
    );
    const result = await importSkills({
      homeDir: home,
      projectRoot: project,
      projectTrusted: true,
      settings: settingsWith(['review-guide']),
      scope: 'global',
      items: [],
    });
    expect(result.imported).toBe(1);
    expect(readSettings(home).skills?.disabled ?? []).toEqual([]);
  });

  it('重新导入预览能给出来源变化与差异文件', async () => {
    const home = temp('kpbl-import-reimport-');
    const project = temp('kpbl-import-reimport-proj-');
    const sourceRoot = path.join(home, '.claude', 'skills');
    writeSourceSkill(sourceRoot, 'review-guide');
    const options = {
      homeDir: home,
      projectRoot: project,
      projectTrusted: true,
      settings: settingsWith(),
      scope: 'global' as const,
      items: [],
    };
    await importSkills(options);
    fs.writeFileSync(path.join(sourceRoot, 'review-guide', 'extra.md'), 'extra');
    const scan = await scanImportableSkills(options);
    const candidate = scan.candidates.find((item) => item.name === 'review-guide');
    expect(candidate?.previouslyImported?.sourceUnchanged).toBe(false);
    expect(candidate?.previouslyImported?.changedFiles).toContain('extra.md');

    const targetDir = path.join(home, '.kapibala', 'skills', 'review-guide');
    const diff = await diffImportedSkill(targetDir, path.join(sourceRoot, 'review-guide'));
    expect(diff.changedFiles).toContain('extra.md');
  });
});
