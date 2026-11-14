/// <reference path="../src/renderer/global.d.ts" />
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Locator, _electron as electron, expect, test } from '@playwright/test';

test('全局浮层密度在常规、最窄、最低和最小窗口下保持边界与可操作性', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-visual-'));
  const artifacts = path.resolve('../../.workbuddy/desktop-stage-e');
  fs.mkdirSync(path.join(home, '.kapibala'));
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.kapibala/settings.json'),
    JSON.stringify({
      profiles: [
        {
          id: 'fixture',
          name: '本地界面验收',
          provider: 'openai-compatible',
          modelName: 'fixture',
          baseURL: 'http://127.0.0.1:1/v1',
          apiKeyEnv: 'FIXTURE_KEY',
          apiKey: 'test-only-visual-fixture',
          contextWindow: 32000,
        },
      ],
      defaultModel: 'fixture',
    }),
  );
  const env: Record<string, string> = {
    KPBL_DESKTOP_E2E: '1',
    KPBL_DESKTOP_HOME: home,
    KPBL_DESKTOP_USER_DATA: path.join(home, 'state'),
  };
  for (const key of [
    'PATH',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'WINDIR',
    'DISPLAY',
    'XAUTHORITY',
    'LANG',
  ])
    if (process.env[key]) env[key] = process.env[key]!;
  const app = await electron.launch({ args: [path.resolve('.')], env });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const measurements: unknown[] = [];
  async function check(dialog: Locator, name: string, width: number | 'none') {
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS('max-width', width === 'none' ? 'none' : `${width}px`);
    await expect
      .poll(async () =>
        dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      )
      .toBe(true);
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
    expect(box!.y + box!.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
    measurements.push({
      name,
      box,
      window: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    });
  }
  try {
    // 操作、搜索和空间树在正常尺寸与最小窗口的展开/折叠状态下保持可达。
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    const sidebar = page.getByRole('complementary', { name: '空间与会话' });
    const search = page.getByRole('searchbox', { name: '搜索空间与对话' });
    await expect(search).toBeVisible();
    await expect(sidebar.getByRole('button', { name: '新建对话', exact: true })).toBeVisible();
    // 项目创建入口已收敛到输入框旁的空间选择器，侧栏不再提供常驻添加入口。
    await expect(sidebar.getByRole('button', { name: '添加项目' })).toHaveCount(0);
    const geometry = await sidebar.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const input = element
        .querySelector('input[type=search]')!
        .parentElement!.getBoundingClientRect();
      return {
        width: bounds.width,
        inputWidth: input.width,
        left: input.left - bounds.left,
        right: bounds.right - input.right,
      };
    });
    expect(geometry.width).toBe(275);
    expect(geometry.inputWidth).toBeGreaterThan(200);
    expect(Math.abs(geometry.left - geometry.right)).toBeLessThan(3);
    await page.screenshot({
      path: path.join(artifacts, 'sidebar-light-1280.png'),
      animations: 'disabled',
    });
    await page.evaluate(() => window.kapibala.preferences.update('dark'));
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
    await page.screenshot({
      path: path.join(artifacts, 'sidebar-dark-1280.png'),
      animations: 'disabled',
    });
    await page.evaluate(() => window.kapibala.preferences.update('light'));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 600));
    await expect(search).toBeHidden();
    await page.getByRole('button', { name: '展开或收起侧栏' }).click();
    await expect(search).toBeVisible();
    await expect(sidebar.getByRole('button', { name: '新建对话', exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(artifacts, 'sidebar-expanded-800.png'),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '展开或收起侧栏' }).click();
    await expect(search).toBeHidden();
    await expect(sidebar.locator('.kapibala-sidebar-search')).toBeHidden();
    await expect(sidebar.getByRole('button', { name: '新建对话', exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(artifacts, 'sidebar-collapsed-800.png'),
      animations: 'disabled',
    });
    // 默认空间默认信任，首屏不再出现信任浮层；浮层密度改为测量项目创建、设置、凭证、
    // 完全访问与审批队列。
    for (const [width, height] of [
      [1280, 800],
      [800, 800],
      [1280, 600],
      [800, 600],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, [width, height]) =>
          BrowserWindow.getAllWindows()[0].setSize(width, height),
        [width, height],
      );
      // 项目创建入口统一在输入框旁的空间选择器；浮层密度测量沿用同一目标。
      await page.getByRole('button', { name: /会话空间：|选择空间/ }).click();
      await page.getByRole('menuitem', { name: '新建项目' }).click();
      const dialog = page.getByRole('dialog', { name: '创建项目', exact: true });
      await check(dialog, `create-${width}-${height}`, 500);
      await page.getByRole('button', { name: '关闭创建项目', exact: true }).click();
      await page.getByRole('button', { name: '打开设置', exact: true }).click();
      const settings = page.getByRole('dialog', { name: '设置', exact: true });
      // 设置是 PI 式整页导航：铺满窗口、不设弹窗宽度上限，左栏固定 275px。
      await check(settings, `settings-${width}-${height}`, 'none');
      expect(
        await settings
          .locator('.kapibala-settings-rail')
          .evaluate((element) => element.getBoundingClientRect().width),
      ).toBe(275);
      // 模型设置已改为一次落盘，凭证二次确认浮层不复存在；这里只保留外观页的密度测量。
      await settings.getByRole('tab', { name: '外观与应用', exact: true }).click();
      await check(settings, `appearance-${width}-${height}`, 'none');
      await page.screenshot({
        path: path.join(artifacts, `settings-${width}-${height}.png`),
        animations: 'disabled',
      });
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    }
    await page.getByRole('button', { name: '新建对话', exact: true }).last().click();
    await page.getByRole('button', { name: /会话模式/ }).click();
    await page.getByRole('menuitem', { name: /完全访问/ }).click();
    await check(
      page.getByRole('dialog', { name: '启用完全访问？', exact: true }),
      'full-access',
      440,
    );
    await page.getByRole('button', { name: '取消完全访问', exact: true }).click();
    // 标题栏的常驻审批计数已移除，空审批队列没有可触达的打开路径；500px 宽度基线
    // 改由 desktop.spec 在真实审批弹出时断言，这里不再截空队列。
    const closed = app.waitForEvent('close');
    await app.evaluate(({ app }) => app.quit());
    await closed;
    fs.writeFileSync(
      path.join(artifacts, 'visual-measurements.json'),
      JSON.stringify(measurements, null, 2),
    );
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});
