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

      const proofDir = path.resolve('test-results/visual-proof');
      fs.mkdirSync(proofDir, { recursive: true });
      await page.screenshot({
        path: path.join(proofDir, 'resource-mcp-panel.png'),
        animations: 'disabled',
      });
    });

    test('技能导入抽屉：切换目标作用域重算冲突并采集真图', async () => {
      const extSkill = path.join(home, '.claude/skills/ext-review');
      fs.mkdirSync(extSkill, { recursive: true });
      fs.writeFileSync(
        path.join(extSkill, 'SKILL.md'),
        '---\nname: ext-review\ndescription: 跨工具导入验收技能\nmodel: claude-sonnet\n---\nReview body.',
      );
      // 预先仅在全局目录放入同名技能，项目空间尚无同名技能
      const globalTarget = path.join(home, '.kapibala/skills/ext-review');
      fs.mkdirSync(globalTarget, { recursive: true });
      fs.writeFileSync(
        path.join(globalTarget, 'SKILL.md'),
        '---\nname: ext-review\ndescription: 既有全局副本\n---\nOld.',
      );

      await page.getByRole('button', { name: '打开设置' }).click();
      await page.getByRole('tab', { name: '资源管理' }).click();
      // 技能区块的「从其它工具导入」按钮（MCP 区块同名按钮带 aria-label="从其它工具导入 MCP"）
      await page.getByRole('button', { name: '从其它工具导入', exact: true }).click();
      const drawer = page.getByRole('region', { name: '从其它工具导入技能' });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByText(/已存在（将跳过）/)).toBeVisible();

      // 切换目标作用域为「项目（需信任）」后重新扫描，项目目录无同名技能，冲突提示消失
      await drawer.getByLabel('目标作用域').click();
      await page.getByRole('option', { name: '项目（需信任）' }).click();
      await expect(drawer.getByText('ext-review', { exact: true })).toBeVisible();
      await expect(drawer.getByText(/已存在（将跳过）/)).toHaveCount(0);

      const proofDir = path.resolve('test-results/visual-proof');
      fs.mkdirSync(proofDir, { recursive: true });
      await page.screenshot({
        path: path.join(proofDir, 'resource-skill-import-drawer.png'),
        animations: 'disabled',
      });
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
      const toggle = page.getByRole('switch', { name: '启用 demo', exact: true });
      await expect(toggle).toBeEnabled();
      await toggle.click();
      // 点击与宿主写回是异步链路：轮询文件直到反映变更，避免固定延时竞态；
      // Windows runner 磁盘与 Host 往返更慢，放宽默认 5 秒轮询窗口。
      await expect
        .poll(
          () => {
            try {
              const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as {
                mcpServers?: Record<string, { enabled?: boolean }>;
              };
              return saved.mcpServers?.demo?.enabled;
            } catch {
              return undefined;
            }
          },
          { timeout: 15_000 },
        )
        .toBe(false);
    });
  });
