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
  it('完整包含十三个内置预设（含 omp、qoder/qoder-cn、trae/trae-cn）且静态默认 enabled 为 false', () => {
    const ids = BUILTIN_EXTERNAL_HARNESSES.map((item) => item.id);
    expect(ids).toEqual([
      'claude-code',
      'codex',
      'pi',
      'antigravity',
      'opencode',
      'deepseek-harness',
      'gemini',
      'qwen-code',
      'omp',
      'qoder',
      'qoder-cn',
      'trae',
      'trae-cn',
    ]);
    expect(BUILTIN_EXTERNAL_HARNESSES.every((item) => item.enabled === false)).toBe(true);
    expect(BUILTIN_EXTERNAL_HARNESSES.find((h) => h.id === 'claude-code')?.transport).toBe(
      'claude-cli',
    );
    expect(BUILTIN_EXTERNAL_HARNESSES.find((h) => h.id === 'codex')?.transport).toBe(
      'codex-app-server',
    );
    expect(BUILTIN_EXTERNAL_HARNESSES.find((h) => h.id === 'pi')?.transport).toBe('pi-rpc');
    expect(BUILTIN_EXTERNAL_HARNESSES.find((h) => h.id === 'antigravity')?.args).toEqual(['acp']);
    expect(BUILTIN_EXTERNAL_HARNESSES.find((h) => h.id === 'omp')).toMatchObject({
      transport: 'acp',
      command: 'omp',
      args: ['acp'],
      env: { PI_NO_PTY: '1' },
    });
    expect(BUILTIN_EXTERNAL_HARNESSES.find((h) => h.id === 'qoder')).toMatchObject({
      transport: 'acp',
      command: 'qodercli',
      args: ['--acp'],
    });
    expect(BUILTIN_EXTERNAL_HARNESSES.find((h) => h.id === 'qoder-cn')).toMatchObject({
      transport: 'acp',
      command: 'qoderclicn',
      args: ['--acp'],
    });
    expect(BUILTIN_EXTERNAL_HARNESSES.find((h) => h.id === 'trae')).toMatchObject({
      transport: 'acp',
      command: 'traecli',
      args: ['acp', 'serve'],
    });
    expect(BUILTIN_EXTERNAL_HARNESSES.find((h) => h.id === 'trae-cn')).toMatchObject({
      transport: 'acp',
      command: 'traecli',
      args: ['acp', 'serve'],
    });
    expect(ACP_REGISTRY_TEMPLATES.length).toBeGreaterThanOrEqual(5);
  });

  it('未手动覆写时按本机是否已安装自动决定默认启用，且手动停用已安装预设不会被清回开启', () => {
    const homeDir = makeTempHome('kpbl-ext-cfg-autodetect-');
    const qoderCnBinDir = path.join(homeDir, '.qoder-cn', 'bin', 'qoderclicn');
    fs.mkdirSync(qoderCnBinDir, { recursive: true });
    const qoderCnBin = path.join(
      qoderCnBinDir,
      process.platform === 'win32' ? 'qoderclicn.exe' : 'qoderclicn',
    );
    fs.writeFileSync(qoderCnBin, 'MZ-qodercn', { mode: 0o755 });

    const isolatedHostEnv = { PATH: '' };
    const resolved = listResolvedExternalHarnesses({ homeDir, hostEnv: isolatedHostEnv });
    expect(resolved.find((r) => r.definition.id === 'qoder-cn')?.definition.enabled).toBe(true);
    // 非隔离系统默认目录（如 macOS `/opt/homebrew/bin`、`/usr/local/bin`）可能已由开发者本机安装了部分 CLI；
    // 仅对系统默认目录中实际未安装的内置预设断言默认保持关闭。
    const systemDirs = process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin'];
    const hasSystemBinary = (cmd: string) =>
      systemDirs.some((dir) => fs.existsSync(path.join(dir, cmd)));
    if (!hasSystemBinary('gemini')) {
      expect(resolved.find((r) => r.definition.id === 'gemini')?.definition.enabled).toBe(false);
    }
    if (!hasSystemBinary('omp')) {
      expect(resolved.find((r) => r.definition.id === 'omp')?.definition.enabled).toBe(false);
    }

    // 手动停用已安装的 qoder-cn：必须持久化 enabled: false，不能因等于静态 builtin.enabled 而被删掉
    toggleExternalHarness('qoder-cn', false, { homeDir });
    const afterDisable = listResolvedExternalHarnesses({ homeDir, hostEnv: isolatedHostEnv });
    expect(afterDisable.find((r) => r.definition.id === 'qoder-cn')?.definition.enabled).toBe(
      false,
    );

    // 验证 TRAE 官方安装器（Programs\TraeCLI\bin\traecli.cmd -> %~dp0traex.exe + trae-installation.json）按 channel 单选启用国际版或国内版
    if (process.platform === 'win32') {
      const traeBinDir = path.join(homeDir, 'AppData', 'Local', 'Programs', 'TraeCLI', 'bin');
      fs.mkdirSync(traeBinDir, { recursive: true });
      fs.writeFileSync(path.join(traeBinDir, 'traex.exe'), 'MZ-traex');
      fs.writeFileSync(
        path.join(traeBinDir, 'traecli.cmd'),
        '@echo off\r\n"%~dp0traex.exe" %*\r\n',
      );
      fs.writeFileSync(
        path.join(traeBinDir, 'trae-installation.json'),
        JSON.stringify({ channel: 'public' }),
      );
      const withPublicTrae = listResolvedExternalHarnesses({ homeDir, hostEnv: isolatedHostEnv });
      expect(withPublicTrae.find((r) => r.definition.id === 'trae')?.definition.enabled).toBe(true);
      expect(withPublicTrae.find((r) => r.definition.id === 'trae-cn')?.definition.enabled).toBe(
        false,
      );

      fs.writeFileSync(
        path.join(traeBinDir, 'trae-installation.json'),
        JSON.stringify({ channel: 'cn' }),
      );
      const withCnTrae = listResolvedExternalHarnesses({ homeDir, hostEnv: isolatedHostEnv });
      expect(withCnTrae.find((r) => r.definition.id === 'trae')?.definition.enabled).toBe(false);
      expect(withCnTrae.find((r) => r.definition.id === 'trae-cn')?.definition.enabled).toBe(true);
    }
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
    const digestD = computeHarnessConfigDigest({ ...base, flavor: 'generic' });

    expect(digestA).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digestB).not.toBe(digestA);
    expect(digestC).not.toBe(digestA);
    expect(digestD).not.toBe(digestA);
  });

  it('拦截 envFrom 中的下划线密钥、PATH/受禁变量、盘符相对路径与远程 UNC 命令，且不物化未改动的默认 args/envFrom', () => {
    const homeDir = makeTempHome('kpbl-ext-cfg-sec-');

    expect(() =>
      upsertCustomExternalHarness(
        {
          id: 'bad-ghp',
          name: 'Bad GHP',
          command: 'copilot',
          args: ['--acp'],
          envFrom: [`ghp_${'A'.repeat(36)}`],
          enabled: true,
        },
        { homeDir },
      ),
    ).toThrowError(expect.objectContaining({ code: 'EXTERNAL_CONFIG_INVALID' }));

    expect(() =>
      upsertCustomExternalHarness(
        {
          id: 'bad-path-env',
          name: 'Bad PATH envFrom',
          command: 'copilot',
          args: ['--acp'],
          envFrom: ['PATH'],
          enabled: true,
        },
        { homeDir },
      ),
    ).toThrowError(expect.objectContaining({ code: 'EXTERNAL_CONFIG_INVALID' }));

    expect(() =>
      upsertCustomExternalHarness(
        {
          id: 'bad-drv-rel',
          name: 'Bad Drive Relative',
          command: 'C:evil.exe',
          args: [],
          enabled: true,
        },
        { homeDir },
      ),
    ).toThrowError(expect.objectContaining({ code: 'EXTERNAL_CONFIG_INVALID' }));

    expect(() =>
      upsertCustomExternalHarness(
        {
          id: 'bad-unc',
          name: 'Bad UNC',
          command: '\\\\127.0.0.1\\share\\evil.exe',
          args: [],
          enabled: true,
        },
        { homeDir },
      ),
    ).toThrowError(expect.objectContaining({ code: 'EXTERNAL_CONFIG_INVALID' }));

    // 提交与内置默认一致的 command/args/envFrom 时不应物化空覆写
    saveBuiltinHarnessOverride(
      'opencode',
      {
        command: 'opencode',
        args: ['acp'],
        envFrom: [],
      },
      { homeDir },
    );
    const resolvedOc = listResolvedExternalHarnesses({ homeDir }).find(
      (i) => i.definition.id === 'opencode',
    )!;
    expect(resolvedOc.hasOverride).toBe(false);
  });

  it('拦截原型保留属性键（constructor/__proto__），且内置代理支持传空串清空 command 覆写而保留 args/envFrom', () => {
    const homeDir = makeTempHome('kpbl-ext-cfg-proto-');

    expect(() =>
      upsertCustomExternalHarness(
        {
          id: 'constructor',
          name: 'Bad Proto',
          command: 'opencode',
          args: ['acp'],
          enabled: true,
        },
        { homeDir },
      ),
    ).toThrowError(expect.objectContaining({ code: 'EXTERNAL_CONFIG_INVALID' }));

    saveBuiltinHarnessOverride(
      'pi',
      {
        command: 'C:\\custom\\pi.exe',
        args: ['--provider', 'anthropic'],
        envFrom: ['ANTHROPIC_API_KEY'],
      },
      { homeDir },
    );

    // 单独将 command 传空串：回退默认命令名 'pi'，同时保留 args 与 envFrom 覆写
    saveBuiltinHarnessOverride('pi', { command: '' }, { homeDir });
    const resolvedPi = listResolvedExternalHarnesses({ homeDir }).find(
      (i) => i.definition.id === 'pi',
    )!;
    expect(resolvedPi.definition.command).toBe('pi');
    expect(resolvedPi.definition.args).toEqual(['--provider', 'anthropic']);
    expect(resolvedPi.hasOverride).toBe(true);
  });
});
