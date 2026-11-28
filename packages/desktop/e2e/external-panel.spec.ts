/// <reference path="../src/renderer/global.d.ts" />
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test';
import { desktopExternalLaunchEnv, desktopLaunchEnv } from '../scripts/launch-env.mjs';

const entry = path.resolve('.');
const fakeAcpScript = path.resolve('../host/tests/fixtures/fake-acp-agent.mjs');
const fakeCodexScript = path.resolve('../host/tests/fixtures/fake-codex-app-server.mjs');

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
  await app.evaluate(({ app, BrowserWindow }) => {
    if (process.platform === 'darwin') app.focus({ steal: true });
    BrowserWindow.getAllWindows()[0]?.focus();
  });
  await page.bringToFront();
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
      await expect(builtinRegion.getByText('Oh My Pi (OMP)', { exact: true })).toBeVisible();
      await expect(builtinRegion.getByText('Qoder', { exact: true })).toBeVisible();
      await expect(builtinRegion.getByText('Qoder CN', { exact: true })).toBeVisible();
      await expect(builtinRegion.getByText('TRAE', { exact: true })).toBeVisible();
      await expect(builtinRegion.getByText('TRAE CN', { exact: true })).toBeVisible();

      // 1. 本地未安装的预设默认不启用；切换启停开关只写 overrides 差量而不物化全部内置项
      const geminiSwitch = page.getByLabel('启用 Gemini CLI', { exact: true });
      const initialChecked = (await geminiSwitch.getAttribute('aria-checked')) === 'true';
      await geminiSwitch.click();
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
        .toBe(!initialChecked);

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

      // 3. 保存自定义代理并核验磁盘 JSON 与设置页模型缓存手动刷新
      await page.getByRole('button', { name: '保存代理' }).click();
      await expect(page.getByText('已保存自定义 ACP 代理「本地验收 ACP」。')).toBeVisible();

      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        custom?: Record<string, { name: string; command: string; args: string[] }>;
      };
      expect(saved.custom?.['e2e-acp']?.name).toBe('本地验收 ACP');

      await page.getByRole('button', { name: '刷新 本地验收 ACP 模型缓存' }).click();
      await expect(page.getByText(/已刷新 本地验收 ACP 本地缓存/)).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText(/模型缓存：已缓存 \d+ 个模型/)).toBeVisible();
    });

    test('输入框选择外部代理并发送首轮，侧栏保留会话，审批与只读归档可用', async () => {
      // 预置仅启用本地受控自定义 ACP 代理，离线验证输入框直发。
      const extDir = path.join(home, '.kapibala/external');
      fs.mkdirSync(extDir, { recursive: true });
      fs.writeFileSync(
        path.join(extDir, 'harnesses.json'),
        JSON.stringify({
          version: 1,
          overrides: {
            'claude-code': { enabled: false },
            codex: {
              command: process.execPath,
              args: [fakeCodexScript],
              enabled: true,
            },
            pi: { enabled: false },
            antigravity: { enabled: false },
            opencode: { enabled: false },
            'deepseek-harness': { enabled: false },
            gemini: { enabled: false },
            'qwen-code': { enabled: false },
            omp: { enabled: false },
            qoder: { enabled: false },
            'qoder-cn': { enabled: false },
            trae: { enabled: false },
            'trae-cn': { enabled: false },
          },
          custom: {
            'e2e-acp': {
              name: '本地验收 ACP',
              command: process.execPath,
              args: [fakeAcpScript, '--mode=generic', '--require-review-env'],
              envFrom: ['KPBL_E2E_EXTERNAL_VALUE'],
              enabled: true,
            },
          },
        }),
      );

      // 用开发/试包启动器同一入口重新取值，验证声明变量从启动脚本到 ACP 子进程。
      const externalEnv = await desktopExternalLaunchEnv(
        {
          ...process.env,
          KPBL_E2E_EXTERNAL_VALUE: 'review-value',
          KPBL_E2E_UNDECLARED_VALUE: 'discard-me',
        },
        home,
      );
      await stop(app);
      app = await electron.launch({
        args: [entry],
        env: { ...environment(home, userData), ...externalEnv },
      });
      page = await firstWindow(app);

      await expect(page.getByRole('button', { name: '会话空间：默认空间' })).toBeVisible();
      await expect(page.getByText('外部代理', { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: '新建对话', exact: true }).click();
      const input = page.getByRole('textbox', { name: '发送消息' });
      await expect(input).toBeFocused();
      await input.fill('NEED_APPROVAL');
      const picker = page.getByRole('button', { name: /新对话模型或代理/ });
      await expect(picker).toBeEnabled();
      await picker.press('Enter');
      const search = page.getByRole('searchbox', { name: '搜索代理或模型' });
      await expect(search).toBeFocused();
      await page
        .getByRole('navigation', { name: '按代理浏览' })
        .getByRole('button', { name: '本地验收 ACP', exact: true })
        .click();
      await expect(page.getByRole('option', { name: /^使用默认模型(?:\s|$)/ })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(picker).toBeFocused();
      await picker.press('Enter');
      await search.fill('验收 ACP');
      await expect(page.getByRole('option', { name: /^本地验收 ACP\b/ })).toBeVisible();
      await search.press('Enter');
      await expect(input).toHaveValue('NEED_APPROVAL');
      await expect(page.getByRole('button', { name: '新对话代理：本地验收 ACP' })).toBeVisible();
      await expect(page.getByText(/还没有可用模型，请先在/)).toHaveCount(0);
      await input.press('Enter');

      // 校验统一页头外部代理徽章、动态运行收件箱、计划 pill 与内联审批叠卡
      await expect(page.locator('.kpbl-session-header').getByText('本地验收 ACP')).toBeVisible({
        timeout: 15_000,
      });
      const approvalSection = page.getByRole('region', { name: '待处理审批', exact: true });
      await expect(approvalSection).toBeVisible({ timeout: 15_000 });
      await expect(
        page
          .getByRole('complementary', { name: '空间与会话' })
          .getByRole('button', { name: /NEED_APPROVAL/ })
          .first(),
      ).toBeVisible();
      const localSessions = await page.evaluate(async () => {
        const workspace = await window.kapibala.workspace.openDefault();
        return window.kapibala.session.list(workspace.id);
      });
      expect(localSessions.items).toHaveLength(0);
      await expect(approvalSection.getByText(/外部代理请求授权：/)).toBeVisible();
      await expect(page.getByRole('button', { name: '任务清单', exact: true })).toContainText(
        '清单 0/2',
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
      await page.getByRole('button', { name: '会话操作', exact: true }).click();
      await page.getByRole('menuitem', { name: '关闭进程' }).click();

      await expect(page.getByText('执行完毕（allow-session）')).toBeVisible();
      await expect(page.getByLabel('发送消息')).toBeDisabled({ timeout: 10_000 });
      await expect(page.getByLabel('发送消息')).toHaveAttribute(
        'placeholder',
        '当前为外部代理只读历史归档，如需继续请新建外部会话',
      );
      await page.getByRole('button', { name: '新建 本地验收 ACP 会话', exact: true }).click();
      await expect(page.getByRole('button', { name: '新对话代理：本地验收 ACP' })).toBeVisible();
      await expect(input).toBeEnabled();
      await expect(input).toHaveValue('');

      // 验证三栏选择器：切到 Codex 自动拉取模型列表、按模型联动推理档位并直发入会话
      await page.getByRole('button', { name: '新对话代理：本地验收 ACP' }).click();
      await page
        .getByRole('navigation', { name: '按代理浏览' })
        .getByRole('button', { name: 'Codex', exact: true })
        .click();
      await expect(page.getByRole('option', { name: /^GPT-6-Astra\b/ })).toBeVisible({
        timeout: 15_000,
      });
      const configRegion = page.getByRole('region', { name: '推理强度' });
      await expect(configRegion).toBeVisible();

      // GPT-6-Luna 不支持 Ultra，点击后右栏自动收敛候选档位；切回 GPT-6-Astra 恢复 Ultra 并点选 Extra High
      await page.getByRole('option', { name: /^GPT-6-Luna\b/ }).click();
      await expect(configRegion.getByRole('button', { name: 'Ultra', exact: true })).toHaveCount(0);
      await page.getByRole('option', { name: /^GPT-6-Astra\b/ }).click();
      await expect(configRegion.getByRole('button', { name: 'Ultra', exact: true })).toBeVisible();
      await configRegion.getByRole('button', { name: 'Extra High', exact: true }).click();
      await page.keyboard.press('Escape');

      await expect(
        page.getByRole('button', {
          name: '新对话代理：Codex · GPT-6-Astra · Extra High',
          exact: true,
        }),
      ).toBeVisible();

      await input.fill('echo-config');
      await input.press('Enter');
      await expect(
        page.getByText('Codex config: model=gpt-6-astra, effort=xhigh, sandbox=workspaceWrite'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByRole('button', {
          name: '当前会话代理：Codex · GPT-6-Astra · Extra High',
          exact: true,
        }),
      ).toBeVisible();
      // 验证第 1 轮回答尾部常驻展示当轮代理、模型与推理强度
      const chatLog = page.getByRole('log', { name: '对话内容' });
      await expect(chatLog.getByText('Codex · GPT-6-Astra · Extra High')).toBeVisible();

      // 在历史会话中切换到另一模型与推理档位（GPT-6-Luna · High），验证仅在下一轮生效且第 1 轮尾部信息保持不变
      await page
        .getByRole('button', {
          name: '当前会话代理：Codex · GPT-6-Astra · Extra High',
          exact: true,
        })
        .click();
      await page.getByRole('option', { name: /^GPT-6-Luna\b/ }).click();
      await page
        .getByRole('region', { name: '推理强度' })
        .getByRole('button', { name: 'High', exact: true })
        .click();
      await page.keyboard.press('Escape');
      await expect(page.getByText(/将在下一轮发送时生效/)).toBeVisible();

      await page.getByRole('textbox', { name: '发送消息' }).fill('echo-config');
      await page.getByRole('textbox', { name: '发送消息' }).press('Enter');
      await expect(
        page.getByText('Codex config: model=gpt-6-luna, effort=high, sandbox=workspaceWrite'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(chatLog.getByText('Codex · GPT-6-Astra · Extra High')).toBeVisible();
      await expect(chatLog.getByText('Codex · GPT-6-Luna · High')).toBeVisible();
    });
  });
