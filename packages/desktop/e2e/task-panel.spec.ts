/// <reference path="../src/renderer/global.d.ts" />
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '@kiturone/kapibala';
import { _electron as electron, expect, test } from '@playwright/test';
import { desktopLaunchEnv } from '../scripts/launch-env.mjs';

const entry = path.resolve('.');

/** 启动环境走白名单助手，宿主注入的 NODE_OPTIONS / ELECTRON_RUN_AS_NODE 不能进主进程。 */
function environment(home: string, userData: string): Record<string, string> {
  return desktopLaunchEnv(process.env, {
    KPBL_DESKTOP_E2E: '1',
    KPBL_DESKTOP_HOME: home,
    KPBL_DESKTOP_USER_DATA: userData,
  });
}

test('任务面板：pill 进度、浮层四态与底栏状态条', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-electron-todos-'));
  const root = path.join(home, '.kapibala/workspaces/default');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.kapibala/settings.json'),
    JSON.stringify({
      profiles: [
        {
          id: 'fixture',
          name: '离线观察模型',
          provider: 'openai-compatible',
          modelName: 'fixture',
          baseURL: 'http://127.0.0.1:1/v1',
          apiKeyEnv: 'FIXTURE_KEY',
          apiKey: 'test-only-offline-key',
          contextWindow: 32000,
        },
      ],
      defaultModel: 'fixture',
    }),
  );

  // 直接落一条成功 todo_write 历史：离线模型无法在线调用工具，靠历史重放验证投影。
  const handle = await new SessionManager({
    workspaceRoot: root,
    projectRootMode: 'exact',
    homeDirectory: home,
  }).create();
  await handle.store.append({
    role: 'user',
    content: [{ type: 'text', text: '任务面板验收' }],
  });
  await handle.store.append({
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'todo-1',
        name: 'todo_write',
        input: {
          items: [
            { id: '1', title: '写设计', status: 'completed' },
            { id: '2', title: '写代码', status: 'in_progress' },
            { id: '3', title: '补测试', status: 'in_progress' },
            { id: '4', title: '写文档', status: 'pending' },
            { id: '5', title: '遗留项', status: 'cancelled' },
          ],
        },
      },
    ],
  });
  await handle.store.append({
    role: 'tool',
    content: [{ type: 'tool_result', toolUseId: 'todo-1', content: '任务清单已更新：1/5 已完成' }],
  });
  await handle.store.append({
    role: 'assistant',
    content: [{ type: 'text', text: '计划已记录。' }],
  });
  await handle.release();

  const app = await electron.launch({
    args: [entry],
    env: environment(home, path.join(home, 'desktop-state')),
  });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('searchbox', { name: '搜索空间与对话' }).fill('任务面板验收');
    await page.getByRole('button', { name: '任务面板验收', exact: true }).click();

    // 可访问名固定为「任务清单」：不随开合态切换，状态由 aria-expanded 表达（组件契约）。
    const pill = page.getByRole('button', { name: '任务清单', exact: true });
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute('aria-expanded', 'false');
    await expect(pill).toContainText('任务 1/5');
    await expect(pill).toContainText('写代码');
    await expect(pill).toContainText('+1');
    // 任务胶囊水平居中对齐于内容列上方，不再偏向左侧。
    const pillAlign = await pill.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const parentBox = el.parentElement!.getBoundingClientRect();
      return Math.abs(box.left + box.width / 2 - (parentBox.left + parentBox.width / 2));
    });
    expect(pillAlign).toBeLessThan(4);

    await pill.click();
    const panel = page.getByRole('region', { name: '任务清单', exact: true });
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel('已完成：写设计', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('进行中：写代码', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('进行中：补测试', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('待办：写文档', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('已取消：遗留项', { exact: true })).toBeVisible();
    await expect(pill).toHaveAttribute('aria-expanded', 'true');

    const proofDir = path.resolve('test-results/visual-proof');
    fs.mkdirSync(proofDir, { recursive: true });
    await page.screenshot({
      path: path.join(proofDir, 'task-panel-open-light.png'),
      animations: 'disabled',
    });
    await page.evaluate(() => window.kapibala.preferences.update('dark'));
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
    await page.screenshot({
      path: path.join(proofDir, 'task-panel-open-dark.png'),
      animations: 'disabled',
    });
    await page.evaluate(() => window.kapibala.preferences.update('light'));

    await pill.press('Escape');
    await expect(panel).toBeHidden();
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});
