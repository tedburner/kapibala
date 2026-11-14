/// <reference path="../src/renderer/global.d.ts" />
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test';
import { desktopLaunchEnv } from '../scripts/launch-env.mjs';

const entry = path.resolve('.');

function environment(home: string, userData: string): Record<string, string> {
  return desktopLaunchEnv(process.env, {
    KPBL_DESKTOP_E2E: '1',
    KPBL_DESKTOP_HOME: home,
    KPBL_DESKTOP_USER_DATA: userData,
  });
}

async function stop(app: ElectronApplication) {
  const closed = app.waitForEvent('close', { timeout: 30_000 });
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await closed;
}

/** 统一按减少动效启动；库浮层入场位移会让自动化点击落在移动前的坐标。 */
async function firstWindow(app: ElectronApplication) {
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return page;
}

test.describe
  .serial('资源管理面板', () => {
    let home: string;
    let userData: string;
    let app: ElectronApplication;
    let page: ReturnType<typeof firstWindow> extends Promise<infer T> ? T : never;

    test.beforeEach(async () => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-electron-resource-'));
      userData = path.join(home, 'desktop-state');
      execFileSync('git', ['init', '--quiet', home]);
      app = await electron.launch({ args: [entry], env: environment(home, userData) });
      page = await firstWindow(app);
      await expect(page.getByRole('button', { name: '打开设置' })).toBeVisible();
    });

    test.afterEach(async () => {
      await stop(app);
      fs.rmSync(home, { recursive: true, force: true });
    });

    test('空态、新增 stdio 服务器与校验拒绝', async () => {
      await page.getByRole('button', { name: '打开设置' }).click();
      await page.getByRole('tab', { name: '资源管理' }).click();
      // 空态：无任何配置时不报错，展示空态文案
      await expect(page.getByText('未配置任何 MCP 服务器。')).toBeVisible();
      // 新增 http 服务器且缺 url：宿主层事务拒绝，错误反馈可见且配置文件不变
      await page.getByRole('button', { name: '新增服务器' }).click();
      await page.getByLabel('名称').fill('broken');
      await page.getByLabel('传输类型').click();
      await page.getByRole('option', { name: 'HTTP（远程端点）' }).click();
      await page.getByRole('button', { name: '保存' }).click();
      // 面板内可见的拒绝原因（错误横幅被模态弹窗遮住，资源面板有本地错误条）
      await expect(page.getByRole('alert')).toContainText('必须提供端点 URL');
      expect(fs.existsSync(path.join(home, '.kapibala/mcp.json'))).toBe(false);
      // 改为合法 stdio 并保存：清单出现且 mcp.json 落盘
      await page.getByLabel('传输类型').click();
      await page.getByRole('option', { name: 'stdio（本地命令）' }).click();
      await page.getByLabel('启动命令').fill('node resource-e2e-server.js');
      await page.getByRole('button', { name: '保存' }).click();
      await expect(page.getByText('resource-e2e-server.js')).toBeVisible();
      const config = JSON.parse(fs.readFileSync(path.join(home, '.kapibala/mcp.json'), 'utf8')) as {
        mcpServers: Record<string, { command?: string; enabled?: boolean }>;
      };
      // 第一次保存（http 缺 url）被拒绝，第二次（合法 stdio）以同一名称落盘
      expect(config.mcpServers.broken?.command).toBe('node resource-e2e-server.js');
      expect(config.mcpServers.broken?.enabled).toBe(true);
    });

    test('启停开关写回配置文件', async () => {
      const file = path.join(home, '.kapibala/mcp.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({ mcpServers: { demo: { type: 'stdio', command: 'demo-cmd' } } }),
      );
      await page.getByRole('button', { name: '打开设置' }).click();
      await page.getByRole('tab', { name: '资源管理' }).click();
      await expect(page.getByText('demo-cmd')).toBeVisible();
      await page.getByLabel('启用 demo', { exact: true }).click();
      // 点击与宿主写回是异步链路：轮询文件直到反映变更，避免固定延时竞态
      await expect
        .poll(() => {
          try {
            const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as {
              mcpServers?: Record<string, { enabled?: boolean }>;
            };
            return saved.mcpServers?.demo?.enabled;
          } catch {
            return undefined;
          }
        })
        .toBe(false);
    });
  });
