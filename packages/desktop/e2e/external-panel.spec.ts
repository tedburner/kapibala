/// <reference path="../src/renderer/global.d.ts" />
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test';
import { desktopLaunchEnv } from '../scripts/launch-env.mjs';

const entry = path.resolve('.');
const fakeAcpScript = path.resolve('../host/tests/fixtures/fake-acp-agent.mjs');

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

async function firstWindow(app: ElectronApplication) {
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return page;
}

test.describe
  .serial('外部代理设置面板与会话审批工作台', () => {
    let home: string;
    let userData: string;
    let app: ElectronApplication;
    let page: ReturnType<typeof firstWindow> extends Promise<infer T> ? T : never;

    test.beforeEach(async () => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-electron-external-'));
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

    test('设置页「外部代理」图形化启停、模板回填、保存前握手测试与配置落盘', async () => {
      await page.getByRole('button', { name: '打开设置' }).click();
      await page.getByRole('tab', { name: '外部代理' }).click();

      const builtinRegion = page.getByRole('region', { name: '内置外部代理' });
      await expect(builtinRegion.getByText('Claude Code', { exact: true })).toBeVisible();
      await expect(builtinRegion.getByText('Codex', { exact: true })).toBeVisible();
      await expect(builtinRegion.getByText('Pi Coding Agent', { exact: true })).toBeVisible();
      await expect(builtinRegion.getByText('Antigravity', { exact: true })).toBeVisible();
      await expect(builtinRegion.getByText('OpenCode', { exact: true })).toBeVisible();

      // 1. 切换内置代理启停开关，验证只写 overrides 差量而不物化全部内置项
      await page.getByLabel('启用 Gemini CLI', { exact: true }).click();
      const configPath = path.join(home, '.kapibala/external/harnesses.json');
      await expect
        .poll(
          () => {
            try {
              const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
                overrides?: Record<string, { enabled?: boolean }>;
              };
              return saved.overrides?.gemini?.enabled;
            } catch {
              return undefined;
            }
          },
          { timeout: 15_000 },
        )
        .toBe(false);

      // 2. 从官方 ACP 目录模板回填表单，并替换为本地受控假 ACP 子进程测试保存前握手
      await page.getByRole('button', { name: '从 ACP 目录选择模板' }).click();
      await page.getByRole('button', { name: '选用 Cline CLI 模板' }).click();
      await expect(page.getByLabel('自定义代理标识 ID')).toHaveValue('cline');

      await page.getByLabel('自定义代理显示名称').fill('本地验收 ACP');
      await page.getByLabel('自定义代理标识 ID').fill('e2e-acp');
      await page.getByLabel('自定义代理可执行命令').fill(process.execPath);
      await page
        .getByLabel('自定义代理启动参数')
        .fill([fakeAcpScript, '--mode=generic'].join('\n'));

      await page.getByRole('button', { name: '测试握手' }).click();
      await expect(page.getByText(/握手成功：custom-generic-agent · 1\.0\.0/)).toBeVisible({
        timeout: 15_000,
      });

      const proofDir = path.resolve('test-results/visual-proof');
      fs.mkdirSync(proofDir, { recursive: true });
      await page.screenshot({
        path: path.join(proofDir, 'external-settings-panel.png'),
        animations: 'disabled',
      });

      // 3. 保存自定义代理并核验磁盘 JSON
      await page.getByRole('button', { name: '保存代理' }).click();
      await expect(page.getByText('已保存自定义 ACP 代理「本地验收 ACP」。')).toBeVisible();

      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        custom?: Record<string, { name: string; command: string; args: string[] }>;
      };
      expect(saved.custom?.['e2e-acp']?.name).toBe('本地验收 ACP');
    });

    test('侧栏新建外部代理任务、内联审批交互、任务进度 pill 与关闭后只读归档门禁', async () => {
      // 预置仅启用本地受控自定义 ACP 代理，确保新建弹窗默认聚焦可离线确定性运行的代理
      const extDir = path.join(home, '.kapibala/external');
      fs.mkdirSync(extDir, { recursive: true });
      fs.writeFileSync(
        path.join(extDir, 'harnesses.json'),
        JSON.stringify({
          version: 1,
          overrides: {
            'claude-code': { enabled: false },
            codex: { enabled: false },
            pi: { enabled: false },
            antigravity: { enabled: false },
            opencode: { enabled: false },
            'deepseek-harness': { enabled: false },
            gemini: { enabled: false },
            'qwen-code': { enabled: false },
          },
          custom: {
            'e2e-acp': {
              name: '本地验收 ACP',
              command: process.execPath,
              args: [fakeAcpScript, '--mode=generic'],
              enabled: true,
            },
          },
        }),
      );

      // 在默认空间新建外部代理任务并投递触发审批的首轮任务
      await page.getByRole('button', { name: '在 默认空间 新建外部代理任务', exact: true }).click();
      await expect(page.getByText(/新建外部代理任务/)).toBeVisible();
      await page.getByLabel('外部代理首轮任务').fill('NEED_APPROVAL');
      await page.getByRole('button', { name: '创建外部任务' }).click();

      // 校验顶部边界提示、计划 pill 与内联外部审批卡
      await expect(page.getByText('外部代理 · 遵循该工具自有权限与登录态')).toBeVisible({
        timeout: 15_000,
      });
      const approvalSection = page.getByRole('region', { name: '外部代理待处理审批' });
      await expect(approvalSection).toBeVisible({ timeout: 15_000 });
      await expect(approvalSection.getByText(/外部代理请求授权：/)).toBeVisible();
      await expect(page.getByRole('button', { name: '任务清单', exact: true })).toContainText(
        '任务 0/2',
      );

      const proofDir = path.resolve('test-results/visual-proof');
      fs.mkdirSync(proofDir, { recursive: true });
      await page.screenshot({
        path: path.join(proofDir, 'external-session-approval.png'),
        animations: 'disabled',
      });

      // 点击扩展选项「本会话允许」，验证消息流完整收口且只读快照落盘
      await approvalSection.getByRole('button', { name: '本会话允许', exact: true }).click();
      await expect(page.getByText('执行完毕（allow-session）')).toBeVisible({ timeout: 15_000 });

      // 主动关闭子进程：通用自定义 ACP 不声明可恢复，验证历史归档不空白且输入框切换为只读归档态
      await page.getByRole('button', { name: 'NEED_APPROVAL 的外部会话操作' }).click();
      await page.getByRole('menuitem', { name: '关闭进程' }).click();

      await expect(page.getByText('执行完毕（allow-session）')).toBeVisible();
      await expect(page.getByLabel('发送消息')).toBeDisabled({ timeout: 10_000 });
      await expect(page.getByLabel('发送消息')).toHaveAttribute(
        'placeholder',
        '当前为外部代理只读历史归档，如需继续请新建外部会话',
      );
      await expect(
        page.getByRole('button', { name: '新建 本地验收 ACP 会话', exact: true }),
      ).toBeVisible();
    });
  });
