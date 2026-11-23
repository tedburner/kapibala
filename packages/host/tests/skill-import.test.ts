import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SKILL_IMPORT_LIMITS,
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
    // 来源身份按 native realpath 归一：Windows 8.3 短名与 macOS /var 软链都必须与预览一致。
    expect(provenance?.sourceRef).toBe(fs.realpathSync.native(sourceDir));
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

describe('导入链路边界回归', () => {
  it('二进制资源按原始字节哈希：utf8 解码相同但字节不同判为 changed', async () => {
    const home = temp('kpbl-import-binary-');
    const project = temp('kpbl-import-binary-proj-');
    const sourceRoot = path.join(home, '.claude', 'skills');
    writeSourceSkill(sourceRoot, 'bin-guide');
    // 0xC3 0x28 是非法 UTF-8 序列（解码为 U+FFFD + "("）；0xEF 0xBF 0xBD 是合法 U+FFFD 编码：
    // 两个文件 utf8 解码结果完全相同、字节内容不同，utf8 摘要会把它们折叠成同一份。
    const invalidUtf8 = Buffer.from([0xc3, 0x28]);
    const replacementUtf8 = Buffer.from([0xef, 0xbf, 0xbd, 0x28]);
    expect(invalidUtf8.toString('utf8')).toBe(replacementUtf8.toString('utf8'));
    fs.writeFileSync(path.join(sourceRoot, 'bin-guide', 'resource.bin'), invalidUtf8);
    const options = {
      homeDir: home,
      projectRoot: project,
      projectTrusted: true,
      settings: settingsWith(),
      scope: 'global' as const,
      items: [],
    };
    await importSkills(options);
    const targetDir = path.join(home, '.kapibala', 'skills', 'bin-guide');
    const provenance = await readImportedSkillProvenance(targetDir);
    expect(provenance?.installedDigest.startsWith('sha256:')).toBe(true);

    fs.writeFileSync(path.join(sourceRoot, 'bin-guide', 'resource.bin'), replacementUtf8);
    const scan = await scanImportableSkills(options);
    const candidate = scan.candidates.find((item) => item.name === 'bin-guide');
    // 字节级摘要必须区分两个不同的二进制文件：来源判为变化而不是 unchanged。
    expect(candidate?.previouslyImported?.sourceUnchanged).toBe(false);
    expect(candidate?.previouslyImported?.changedFiles).toContain('resource.bin');
    const diff = await diffImportedSkill(targetDir, path.join(sourceRoot, 'bin-guide'));
    expect(diff.changedFiles).toContain('resource.bin');
  });

  it('来源根是指向真实目录的符号链接时按可读来源正常扫描', async (context) => {
    const home = temp('kpbl-import-linkroot-');
    const project = temp('kpbl-import-linkroot-proj-');
    const realRoot = path.join(home, 'data', 'skills');
    writeSourceSkill(realRoot, 'linked-guide');
    try {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.symlinkSync(realRoot, path.join(home, '.claude', 'skills'), 'dir');
    } catch {
      // Windows 未开开发者模式时创建符号链接需要特权；此环境无法构造该用例。
      context.skip();
      return;
    }
    const scan = await scanImportableSkills({
      homeDir: home,
      projectRoot: project,
      projectTrusted: false,
      settings: settingsWith(),
    });
    const source = scan.sources.find((item) => item.harness === 'claude-code');
    expect(source?.roots[0]?.readable).toBe(true);
    expect(scan.candidates.find((item) => item.name === 'linked-guide')).toBeDefined();
    expect(scan.diagnostics.some((item) => item.code === 'import_source_unreadable')).toBe(false);
  });

  it('悬空符号链接来源根产生告警而不是静默跳过', async (context) => {
    const home = temp('kpbl-import-dangling-');
    const project = temp('kpbl-import-dangling-proj-');
    const danglingRoot = path.join(home, '.codex', 'skills');
    try {
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
      fs.symlinkSync(path.join(home, 'missing-target'), danglingRoot, 'dir');
    } catch {
      context.skip();
      return;
    }
    const scan = await scanImportableSkills({
      homeDir: home,
      projectRoot: project,
      projectTrusted: false,
      settings: settingsWith(),
    });
    const source = scan.sources.find((item) => item.harness === 'codex');
    expect(source?.roots[0]?.readable).toBe(false);
    expect(
      scan.diagnostics.some(
        (item) => item.code === 'import_source_unreadable' && item.path === danglingRoot,
      ),
    ).toBe(true);
    expect(scan.candidates).toHaveLength(0);
  });

  it('复制期条目被换成越界符号链接时跳过并诊断（TOCTOU 防护）', async (context) => {
    const home = temp('kpbl-import-copyguard-');
    const project = temp('kpbl-import-copyguard-proj-');
    const sourceRoot = path.join(home, '.claude', 'skills');
    writeSourceSkill(sourceRoot, 'guard-guide');
    fs.writeFileSync(path.join(sourceRoot, 'guard-guide', 'resource.md'), 'resource');
    const preview = await scanImportableSkills({
      homeDir: home,
      projectRoot: project,
      projectTrusted: true,
      settings: settingsWith(),
    });
    const candidate = preview.candidates.find((item) => item.name === 'guard-guide');
    expect(candidate).toBeDefined();
    // 预览后把普通文件换成指向包外的符号链接：来源身份（包目录）不变，复制期必须按物理位置拦截。
    try {
      fs.rmSync(path.join(sourceRoot, 'guard-guide', 'resource.md'));
      fs.symlinkSync(
        path.join(home, 'outside.txt'),
        path.join(sourceRoot, 'guard-guide', 'resource.md'),
      );
    } catch {
      context.skip();
      return;
    }
    fs.writeFileSync(path.join(home, 'outside.txt'), 'outside');
    const result = await importSkills({
      homeDir: home,
      projectRoot: project,
      projectTrusted: true,
      settings: settingsWith(),
      scope: 'global',
      items: [
        {
          harness: 'claude-code',
          name: 'guard-guide',
          expectedSourceRef: candidate?.sourceRef ?? '',
        },
      ],
    });
    expect(result.imported).toBe(1);
    expect(result.diagnostics.some((item) => item.code === 'import_symlink_skipped')).toBe(true);
    expect(
      fs.existsSync(path.join(home, '.kapibala', 'skills', 'guard-guide', 'resource.md')),
    ).toBe(false);
  });

  it('来源包含超过整包字节预算的文件时不进入候选，导入不落地', async () => {
    const home = temp('kpbl-import-bytes-');
    const project = temp('kpbl-import-bytes-proj-');
    const sourceRoot = path.join(home, '.claude', 'skills');
    writeSourceSkill(sourceRoot, 'big-guide');
    fs.writeFileSync(
      path.join(sourceRoot, 'big-guide', 'huge.bin'),
      Buffer.alloc(SKILL_IMPORT_LIMITS.bytes + 1, 0x41),
    );
    const options = {
      homeDir: home,
      projectRoot: project,
      projectTrusted: true,
      settings: settingsWith(),
      scope: 'global' as const,
      items: [],
    };
    const scan = await scanImportableSkills(options);
    expect(scan.partial).toBe(true);
    expect(scan.candidates.find((item) => item.name === 'big-guide')).toBeUndefined();
    await importSkills(options);
    expect(fs.existsSync(path.join(home, '.kapibala', 'skills', 'big-guide'))).toBe(false);
  });

  it('目标目录出现循环符号链接时摘要收集终止且结论不漂移', async (context) => {
    const home = temp('kpbl-import-cycle-');
    const project = temp('kpbl-import-cycle-proj-');
    const sourceRoot = path.join(home, '.claude', 'skills');
    writeSourceSkill(sourceRoot, 'cycle-guide');
    const options = {
      homeDir: home,
      projectRoot: project,
      projectTrusted: true,
      settings: settingsWith(),
      scope: 'global' as const,
      items: [],
    };
    await importSkills(options);
    const targetDir = path.join(home, '.kapibala', 'skills', 'cycle-guide');
    // 指向祖先目录的循环链接：摘要收集必须靠物理去重终止，不能无限递归。
    try {
      fs.symlinkSync(targetDir, path.join(targetDir, 'assets'), 'dir');
    } catch {
      context.skip();
      return;
    }
    const scan = await scanImportableSkills(options);
    const candidate = scan.candidates.find((item) => item.name === 'cycle-guide');
    expect(candidate?.previouslyImported).toBeDefined();
    expect(candidate?.previouslyImported?.sourceUnchanged).toBe(true);
    expect(candidate?.previouslyImported?.changedFiles).toEqual([]);
  });

  it('摘要收集超过深度上限时跳过深层内容并诊断', async () => {
    const home = temp('kpbl-import-deepdigest-');
    const project = temp('kpbl-import-deepdigest-proj-');
    const sourceRoot = path.join(home, '.claude', 'skills');
    writeSourceSkill(sourceRoot, 'deep-guide');
    const options = {
      homeDir: home,
      projectRoot: project,
      projectTrusted: true,
      settings: settingsWith(),
      scope: 'global' as const,
      items: [],
    };
    await importSkills(options);
    // 目标侧手工构造超过 6 层的目录链：第 7 层的文件不再参与摘要，且给出诊断。
    let deep = path.join(home, '.kapibala', 'skills', 'deep-guide');
    for (let i = 1; i <= 7; i++) {
      deep = path.join(deep, `d${i}`);
      fs.mkdirSync(deep, { recursive: true });
    }
    fs.writeFileSync(path.join(deep, 'leaf.md'), 'deep leaf');
    const scan = await scanImportableSkills(options);
    expect(
      scan.diagnostics.some(
        (item) => item.code === 'import_depth_skipped' && item.path.includes('d7'),
      ),
    ).toBe(true);
    const candidate = scan.candidates.find((item) => item.name === 'deep-guide');
    // 深层文件被跳过后不进入差异清单：来源与目标的可见层仍然一致。
    expect(candidate?.previouslyImported?.changedFiles).toEqual([]);
  });

  it('按目标导入作用域（而非来源作用域）判定冲突与重导入差异', async () => {
    const home = temp('kpbl-import-scope-');
    const project = temp('kpbl-import-scope-proj-');
    // 来源在项目目录（origin = 'project'），而目标将导入全局目录（scope = 'global'）
    const projectClaudeRoot = path.join(project, '.claude', 'skills');
    writeSourceSkill(projectClaudeRoot, 'cross-scope-skill');
    fs.mkdirSync(path.join(home, '.kapibala', 'skills', 'cross-scope-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.kapibala', 'skills', 'cross-scope-skill', 'SKILL.md'),
      '---\nname: cross-scope-skill\ndescription: existing\n---\nbody',
    );
    const globalScan = await scanImportableSkills({
      homeDir: home,
      projectRoot: project,
      projectTrusted: true,
      settings: settingsWith(),
      scope: 'global',
    });
    expect(globalScan.candidates.find((c) => c.name === 'cross-scope-skill')?.conflict).toBe(
      'exists-enabled',
    );

    const projectScan = await scanImportableSkills({
      homeDir: home,
      projectRoot: project,
      projectTrusted: true,
      settings: settingsWith(),
      scope: 'project',
    });
    expect(projectScan.candidates.find((c) => c.name === 'cross-scope-skill')?.conflict).toBe(
      'none',
    );
  });
});
