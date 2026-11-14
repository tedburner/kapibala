import path from 'node:path';
import { expect, it } from 'vitest';
import { sanitizeNodeOptions, toolchainEnv } from '../process-env.mjs';

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
