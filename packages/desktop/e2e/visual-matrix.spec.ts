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
  async function checkSurface(surface: Locator, name: string, expectedMaxWidth?: number) {
    await expect(surface).toBeVisible();
    await expect
      .poll(async () =>
        surface.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      )
      .toBe(true);
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    if (expectedMaxWidth !== undefined) {
      expect(box!.width).toBeLessThanOrEqual(expectedMaxWidth + 1);
    }
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    // Windows 分数缩放下 innerWidth/innerHeight 取整，而 fixed/dialog 的亚像素盒宽可能高出 <1px。
    expect(box!.x + box!.width).toBeLessThanOrEqual((await page.evaluate(() => innerWidth)) + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual((await page.evaluate(() => innerHeight)) + 1);
    measurements.push({
      name,
      box,
      window: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    });
  }
  try {
    // 操作、命令面板入口和空间树在正常尺寸与最小窗口的展开/折叠状态下保持可达。
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    if (process.platform !== 'darwin') {
      const menuBarVisible = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isMenuBarVisible(),
      );
      expect(menuBarVisible).toBe(false);
    }
    const inlineRail = page.locator('aside.kpbl-nav-rail').first();
    await expect(inlineRail.locator('.kpbl-rail-wordmark')).toHaveText('Kapibala');
    const cmdTrigger = inlineRail.getByRole('button', { name: '搜索或运行命令', exact: true });
    await expect(cmdTrigger).toBeVisible();
    await expect(inlineRail.getByRole('button', { name: '新建对话', exact: true })).toBeVisible();
    const geometry = await inlineRail.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const trigger = element.querySelector('.kpbl-rail-cmd-trigger')!.getBoundingClientRect();
      return {
        width: bounds.width,
        triggerWidth: trigger.width,
        left: trigger.left - bounds.left,
        right: bounds.right - trigger.right,
      };
    });
    // UI 2.0 展开导航轨固定 248px（--kpbl-rail-width），命令触发器左右留白对称。
    expect(geometry.width).toBeCloseTo(248, 0);
    expect(geometry.triggerWidth).toBeGreaterThan(200);
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
    // 800px 落入 minimal 视口档：内联轨自动收起为 52px 图标轨，点击展开为覆盖抽屉。
    await expect(inlineRail).toHaveAttribute('data-collapsed', 'true');
    expect(
      await inlineRail.evaluate((element) => element.getBoundingClientRect().width),
    ).toBeCloseTo(52, 0);
    await inlineRail.getByRole('button', { name: '展开或收起侧栏' }).click();
    const drawerRail = page.locator('aside.kpbl-nav-rail[data-drawer="true"]');
    await expect(drawerRail).toBeVisible();
    await expect(drawerRail.getByRole('button', { name: '新建对话', exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(artifacts, 'sidebar-expanded-800.png'),
      animations: 'disabled',
    });
    await drawerRail.getByRole('button', { name: '展开或收起侧栏' }).click();
    await expect(drawerRail).toHaveCount(0);
    await expect(inlineRail.getByRole('button', { name: '新建对话', exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(artifacts, 'sidebar-collapsed-800.png'),
      animations: 'disabled',
    });
    // 在四档视口矩阵下测量项目创建模态框、壳内设置舞台（region[name="设置中心"]）与完全访问确认框。
    for (const [width, height] of [
      [1280, 800],
      [800, 800],
      [1280, 600],
      [800, 600],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h),
        [width, height],
      );
      await page.getByRole('button', { name: /会话空间：|选择空间/ }).click();
      await page.getByRole('menuitem', { name: '新建项目' }).click();
      const dialog = page.getByRole('dialog', { name: '创建项目', exact: true });
      await checkSurface(dialog, `create-${width}-${height}`, 460);
      await page.getByRole('button', { name: '关闭创建项目', exact: true }).click();
      await inlineRail.getByRole('button', { name: '打开设置', exact: true }).click();
      const settings = page.getByRole('region', { name: '设置中心', exact: true });
      await checkSurface(settings, `settings-${width}-${height}`);
      const actualInnerWidth = await page.evaluate(() => innerWidth);
      expect(
        await settings
          .locator('.kpbl-settings-rail')
          .evaluate((element) => element.getBoundingClientRect().width),
      ).toBeCloseTo(actualInnerWidth < 860 ? 164 : 196, 0);
      await settings.getByRole('tab', { name: '模型与服务商', exact: true }).click();
      await checkSurface(settings, `providers-${width}-${height}`);
      await settings.getByRole('tab', { name: '常规', exact: true }).click();
      await checkSurface(settings, `general-${width}-${height}`);
      await page.screenshot({
        path: path.join(artifacts, `settings-${width}-${height}.png`),
        animations: 'disabled',
      });
      await settings.getByRole('button', { name: '返回工作台', exact: true }).click();
    }
    await inlineRail.getByRole('button', { name: '新建对话', exact: true }).click();
    await page.getByRole('button', { name: /会话模式/ }).click();
    await page.getByRole('menuitem', { name: /完全访问/ }).click();
    await checkSurface(
      page.getByRole('dialog', { name: '启用完全访问？', exact: true }),
      'full-access',
      460,
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
