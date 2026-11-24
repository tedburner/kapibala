import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeHarnessConfigDigest,
  getExternalHarnessesConfigPath,
  listResolvedExternalHarnesses,
  removeCustomExternalHarness,
  resetBuiltinHarnessOverride,
  saveBuiltinHarnessOverride,
  toggleExternalHarness,
  upsertCustomExternalHarness,
} from '../src/host/external/config.js';
import {
  ACP_REGISTRY_TEMPLATES,
  BUILTIN_EXTERNAL_HARNESSES,
} from '../src/host/external/presets.js';

const tempDirs: string[] = [];
function makeTempHome(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('外部代理内置预设与官方 ACP Registry 模板', () => {
  it('完整包含七个内置预设（含三套驱动路由）与官方 ACP 模板清单', () => {
    const ids = BUILTIN_EXTERNAL_HARNESSES.map((item) => item.id);
    expect(ids).toEqual([
      'claude-code',
      'codex',
      'antigravity',
      'opencode',
      'deepseek-harness',
      'gemini',
      'qwen-code',
    ]);
    expect(BUILTIN_EXTERNAL_HARNESSES.find((h) => h.id === 'claude-code')?.transport).toBe(
      'claude-cli',
    );
    expect(BUILTIN_EXTERNAL_HARNESSES.find((h) => h.id === 'codex')?.transport).toBe(
      'codex-app-server',
    );
    expect(BUILTIN_EXTERNAL_HARNESSES.find((h) => h.id === 'antigravity')?.args).toEqual(['acp']);
    expect(ACP_REGISTRY_TEMPLATES.length).toBeGreaterThanOrEqual(5);
  });
});

describe('harnesses.json 独占锁增量配置事务', () => {
  it('仅把内置预设覆写差量写入磁盘（不物化全部内置项），且支持一键恢复默认', () => {
    const homeDir = makeTempHome('kpbl-ext-cfg-delta-');

    saveBuiltinHarnessOverride(
      'deepseek-harness',
      {
        command: 'C:\\tools\\dsh.exe',
        envFrom: ['DEEPSEEK_API_KEY', 'CUSTOM_PROXY_TOKEN'],
      },
      { homeDir },
    );
    toggleExternalHarness('qwen-code', false, { homeDir });

    const rawDisk = JSON.parse(
      fs.readFileSync(getExternalHarnessesConfigPath(homeDir), 'utf8'),
    ) as {
      version: number;
      overrides: Record<string, unknown>;
      custom: Record<string, unknown>;
    };
    expect(rawDisk.version).toBe(1);
    expect(Object.keys(rawDisk.overrides).sort()).toEqual(['deepseek-harness', 'qwen-code']);

    const resolved = listResolvedExternalHarnesses({ homeDir });
    const dsh = resolved.find((item) => item.definition.id === 'deepseek-harness')!;
    expect(dsh.hasOverride).toBe(true);
    expect(dsh.definition.command).toBe('C:\\tools\\dsh.exe');
    expect(dsh.definition.envFrom).toEqual(['DEEPSEEK_API_KEY', 'CUSTOM_PROXY_TOKEN']);

    const qwen = resolved.find((item) => item.definition.id === 'qwen-code')!;
    expect(qwen.definition.enabled).toBe(false);

    resetBuiltinHarnessOverride('deepseek-harness', { homeDir });
    const afterReset = listResolvedExternalHarnesses({ homeDir }).find(
      (item) => item.definition.id === 'deepseek-harness',
    )!;
    expect(afterReset.hasOverride).toBe(false);
    expect(afterReset.definition.command).toBe('dsh');
  });

  it('支持自定义 Local ACP Command 增删改，并拦截与内置 ID 冲突、相对路径及明文 API Key', () => {
    const homeDir = makeTempHome('kpbl-ext-cfg-custom-');

    upsertCustomExternalHarness(
      {
        id: 'my-copilot',
        name: 'GitHub Copilot ACP',
        command: 'copilot',
        args: ['--acp'],
        registryId: 'copilot',
        envFrom: ['GITHUB_TOKEN'],
        enabled: true,
      },
      { homeDir },
    );

    const list1 = listResolvedExternalHarnesses({ homeDir });
    const custom = list1.find((item) => item.definition.id === 'my-copilot')!;
    expect(custom.definition.transport).toBe('acp');
    expect(custom.definition.builtin).toBe(false);
    expect(custom.definition.registryId).toBe('copilot');

    // 禁止覆盖内置 ID
    expect(() =>
      upsertCustomExternalHarness(
        {
          id: 'opencode',
          name: 'Shadow OpenCode',
          command: 'opencode',
          args: ['acp'],
          enabled: true,
        },
        { homeDir },
      ),
    ).toThrowError(expect.objectContaining({ code: 'EXTERNAL_CONFIG_INVALID' }));

    // 禁止在 env 中存放敏感凭据键或明文密钥（强制走 envFrom）
    expect(() =>
      upsertCustomExternalHarness(
        {
          id: 'bad-secret',
          name: 'Bad Secret',
          command: 'demo-acp',
          args: [],
          env: { OPENAI_API_KEY: 'sk-1234567890abcdef' },
          enabled: true,
        },
        { homeDir },
      ),
    ).toThrowError(expect.objectContaining({ code: 'EXTERNAL_CONFIG_INVALID' }));

    // 禁止相对路径命令
    expect(() =>
      upsertCustomExternalHarness(
        {
          id: 'bad-rel',
          name: 'Bad Relative',
          command: './scripts/agent.exe',
          args: [],
          enabled: true,
        },
        { homeDir },
      ),
    ).toThrowError(expect.objectContaining({ code: 'EXTERNAL_CONFIG_INVALID' }));

    expect(removeCustomExternalHarness('my-copilot', { homeDir })).toBe(true);
    expect(
      listResolvedExternalHarnesses({ homeDir }).some((i) => i.definition.id === 'my-copilot'),
    ).toBe(false);
  });

  it('独占锁被占用时报 EXTERNAL_CONFIG_BUSY，文件损坏时报 EXTERNAL_CONFIG_CORRUPT 拒绝覆盖', () => {
    const homeDir = makeTempHome('kpbl-ext-cfg-lock-');
    const filePath = getExternalHarnessesConfigPath(homeDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const lockPath = `${filePath}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify({ owner: 'other-proc', pid: 99999 }));
    expect(() => toggleExternalHarness('opencode', false, { homeDir })).toThrowError(
      expect.objectContaining({ code: 'EXTERNAL_CONFIG_BUSY' }),
    );
    fs.unlinkSync(lockPath);

    fs.writeFileSync(filePath, '{ broken json !!!');
    expect(() => toggleExternalHarness('opencode', false, { homeDir })).toThrowError(
      expect.objectContaining({ code: 'EXTERNAL_CONFIG_CORRUPT' }),
    );
    // 确认未破坏现场文件
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{ broken json !!!');
  });

  it('computeHarnessConfigDigest 对任意启动字段变化产生不同 sha256 指纹', () => {
    const base = BUILTIN_EXTERNAL_HARNESSES.find((h) => h.id === 'opencode')!;
    const digestA = computeHarnessConfigDigest(base);
    const digestB = computeHarnessConfigDigest({ ...base, args: ['acp', '--verbose'] });
    const digestC = computeHarnessConfigDigest({ ...base, envFrom: ['EXTRA_KEY'] });

    expect(digestA).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digestB).not.toBe(digestA);
    expect(digestC).not.toBe(digestA);
  });
});
