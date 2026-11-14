import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';
import { desktopLaunchEnv } from './launch-env.mjs';

const entry = path.resolve('.');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-dbg-'));
execFileSync('git', ['init', '--quiet', home]);
// 与 e2e 一致：文件在启动前创建
const root = path.join(home, '.kapibala/workspaces/default');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.writeFileSync(path.join(root, 'src/demo.ts'), 'demo');

const app = await electron.launch({
  args: [entry],
  env: desktopLaunchEnv(process.env, {
    KPBL_DESKTOP_E2E: '1',
    KPBL_DESKTOP_HOME: home,
    KPBL_DESKTOP_USER_DATA: path.join(home, 'desktop-state'),
  }),
});
const page = await app.firstWindow();
page.on('pageerror', (error) => console.log('[pageerror]', error.message.slice(0, 200)));
await page.waitForTimeout(3500);
await page.getByLabel('发送消息').fill('@de');
await page.waitForTimeout(1500);
const probe = await page.evaluate(() => ({
  value: document.querySelector('.kapibala-composer textarea')?.value,
  hasPanel: Boolean(document.querySelector('.absolute.bottom-full')),
  panelText: document.querySelector('.absolute.bottom-full')?.textContent ?? '',
}));
console.log('probe:', JSON.stringify(probe));
await app.evaluate(({ app }) => app.quit()).catch(() => {});
fs.rmSync(home, { recursive: true, force: true });
process.exit(0);
