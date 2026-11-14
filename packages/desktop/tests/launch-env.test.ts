import { expect, it } from 'vitest';
import { DESKTOP_ENV_KEYS, desktopLaunchEnv } from '../scripts/launch-env.mjs';

// 宿主注入的典型形态：装在应用包内的 shim，用绝对路径 --require 预加载。
const externalShim =
  '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/vendor/shim/node-language-shim.cjs';

it('启动环境只保留白名单变量，宿主注入的钩子与私有变量一律不出现', () => {
  const env = desktopLaunchEnv(
    {
      PATH: '/usr/bin',
      HOME: '/Users/example',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      NODE_OPTIONS: `--require="${externalShim}"`,
      ELECTRON_RUN_AS_NODE: '1',
      CODEBUDDY_TOOL_CALL_ID: 'call-1',
      KPBL_LEAK: 'secret',
    },
    { ELECTRON_RENDERER_URL: 'http://127.0.0.1:5173', KPBL_DESKTOP_DEV_TOKEN: 'token' },
  );
  expect(env.PATH).toBe('/usr/bin');
  expect(env.HOME).toBe('/Users/example');
  expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7897');
  expect(env.ELECTRON_RENDERER_URL).toBe('http://127.0.0.1:5173');
  expect(env.KPBL_DESKTOP_DEV_TOKEN).toBe('token');
  expect(env.NODE_OPTIONS).toBeUndefined();
  expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  expect(env.CODEBUDDY_TOOL_CALL_ID).toBeUndefined();
  expect(env.KPBL_LEAK).toBeUndefined();
});

it('白名单本身不登记任何预加载钩子或运行模式开关', () => {
  expect(DESKTOP_ENV_KEYS).not.toContain('NODE_OPTIONS');
  expect(DESKTOP_ENV_KEYS).not.toContain('ELECTRON_RUN_AS_NODE');
  expect(DESKTOP_ENV_KEYS.some((key) => key.startsWith('CODEBUDDY_'))).toBe(false);
});
