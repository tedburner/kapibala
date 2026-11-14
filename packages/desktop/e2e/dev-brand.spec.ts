import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { developmentExecutable } from '../scripts/dev-runtime.mjs';

test('macOS 开发应用包使用 Kapibala 名称且不改变原 Electron 包', async () => {
  test.skip(process.platform !== 'darwin', '仅 macOS 通过应用包提供菜单栏与 Dock 名称');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-dev-brand-'));
  const cache = path.join(home, 'runtime');
  const electronExecutable = createRequire(import.meta.url)('electron') as string;
  const executable = developmentExecutable(electronExecutable, cache);
  const info = path.resolve(executable, '../../Info.plist');
  const sourceInfo = path.resolve(electronExecutable, '../../Info.plist');
  try {
    for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
      expect(
        execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, info], {
          encoding: 'utf8',
        }).trim(),
      ).toBe('Kapibala');
      expect(
        execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, sourceInfo], {
          encoding: 'utf8',
        }).trim(),
      ).toBe('Electron');
    }
    expect(developmentExecutable(electronExecutable, cache)).toBe(executable);
    const app = await electron.launch({
      executablePath: executable,
      args: [path.resolve('.')],
      env: {
        PATH: process.env.PATH ?? '',
        TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
        KPBL_DESKTOP_E2E: '1',
        KPBL_DESKTOP_HOME: home,
        KPBL_DESKTOP_USER_DATA: path.join(home, 'state'),
      },
    });
    try {
      const window = await app.firstWindow();
      await expect(window.getByRole('button', { name: '打开设置' })).toBeVisible();
      expect(await app.evaluate(({ app }) => app.getName())).toBe('Kapibala');
      expect(
        await app.evaluate(({ Menu }) =>
          Menu.getApplicationMenu()?.items.map((item) => item.label),
        ),
      ).toEqual(['Kapibala', '编辑', '视图']);
    } finally {
      await app.close();
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
