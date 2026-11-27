import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { resolvePnpmCommand, sanitizeNodeOptions, toolchainEnv } from '../process-env.mjs';

const repository = path.resolve('.');
// 宿主注入的典型形态：装在应用包内的 shim，用绝对路径 --require 预加载。
const externalShim =
  '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/vendor/shim/node-language-shim.cjs';

it('剥离仓库外的预加载钩子，保留堆参数与仓库内的预加载', () => {
  expect(
    sanitizeNodeOptions(
      `--require="${externalShim}" --max-old-space-size=8192 --import ./tooling/probe.mjs`,
      repository,
    ),
  ).toBe('--max-old-space-size=8192 --import ./tooling/probe.mjs');
  expect(sanitizeNodeOptions(`-r ${externalShim} --enable-source-maps`, repository)).toBe(
    '--enable-source-maps',
  );
  // 裸说明符与 data: URL 无法确认来源，等同于任意代码注入点。
  expect(
    sanitizeNodeOptions('--import "data:text/javascript,process.exit(1)"', repository),
  ).toBeUndefined();
  expect(sanitizeNodeOptions(undefined, repository)).toBeUndefined();
});

it('工具链环境只摘钩子，其余变量与额外注入原样保留', () => {
  const env = toolchainEnv(
    {
      PATH: '/usr/bin',
      HOME: '/Users/example',
      CI: 'true',
      NODE_OPTIONS: `--require="${externalShim}"`,
      ELECTRON_RUN_AS_NODE: '1',
    },
    repository,
    { GITHUB_OUTPUT: '/tmp/pack-output.txt' },
  );
  expect(env.CI).toBe('true');
  expect(env.HOME).toBe('/Users/example');
  expect(env.GITHUB_OUTPUT).toBe('/tmp/pack-output.txt');
  expect(env.NODE_OPTIONS).toBeUndefined();
  expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  expect(toolchainEnv({ NODE_OPTIONS: '--max-old-space-size=8192' }, repository).NODE_OPTIONS).toBe(
    '--max-old-space-size=8192',
  );
});

it('跨平台解析 pnpm 调用且不依赖 shell:true（Node 24 --throw-deprecation 零 DEP0190 告警）', () => {
  const winFallback = resolvePnpmCommand(
    ['--version'],
    { ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATH: '' },
    'win32',
  );
  expect(winFallback).toEqual({
    command: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', 'pnpm.cmd', '--version'],
  });

  // GitHub Actions pnpm/setup@v3 (pnpm 10+/12+) 仅安装独立原生 pnpm.exe（无 pnpm.cjs 与 pnpm.cmd）
  const setupPnpmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-setup-pnpm-'));
  try {
    const standaloneExe = path.join(setupPnpmDir, 'pnpm.exe');
    fs.writeFileSync(standaloneExe, 'MZ-pnpm-exe');
    expect(
      resolvePnpmCommand(
        ['dev', '--no-start'],
        { npm_execpath: standaloneExe, PATH: setupPnpmDir },
        'win32',
      ),
    ).toEqual({
      command: standaloneExe,
      args: ['dev', '--no-start'],
    });
    expect(
      resolvePnpmCommand(
        ['verify'],
        { PNPM_HOME: setupPnpmDir, PATH: 'C:\\Windows\\System32' },
        'win32',
      ),
    ).toEqual({
      command: standaloneExe,
      args: ['verify'],
    });
  } finally {
    fs.rmSync(setupPnpmDir, { recursive: true, force: true });
  }

  const posixFallback = resolvePnpmCommand(['build'], {}, 'linux');
  expect(posixFallback).toEqual({
    command: 'pnpm',
    args: ['build'],
  });

  // 成对正反例断言：确保正则能捕获两类危险写法，同时所有真实入口均不含它们。
  const shellOptionPattern = /\bshell:\s*(?:true|process\.platform\s*===\s*['"]win32['"])/;
  expect(shellOptionPattern.test("shell: process.platform === 'win32'")).toBe(true);
  expect(shellOptionPattern.test('shell: true')).toBe(true);
  for (const scriptRel of [
    'scripts/build.mjs',
    'scripts/dev.mjs',
    'packages/desktop/scripts/dev.mjs',
    'packages/desktop/scripts/try-packaged.mjs',
  ]) {
    const content = fs.readFileSync(path.join(repository, scriptRel), 'utf8');
    expect(content, `${scriptRel} still uses shell option with spawn args`).not.toMatch(
      shellOptionPattern,
    );
  }

  const devDesktopContent = fs.readFileSync(
    path.join(repository, 'scripts/dev-desktop.mjs'),
    'utf8',
  );
  expect(devDesktopContent).toContain('kpbl:dev-parent-stop');

  const actual = resolvePnpmCommand(['--version'], process.env, process.platform);
  const probe = spawnSync(
    process.execPath,
    [
      '--throw-deprecation',
      '-e',
      'const { spawnSync } = require("node:child_process"); const res = spawnSync(process.argv[1], process.argv.slice(2), { stdio: "pipe" }); process.exit(res.status ?? 1);',
      actual.command,
      ...actual.args,
    ],
    { encoding: 'utf8' },
  );
  expect(probe.status).toBe(0);
});
