/// <reference path="../src/renderer/global.d.ts" />
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '@kiturone/kapibala';
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test';

const entry = path.resolve('.');
const artifacts = path.resolve('../../.workbuddy/desktop-stage-e');
function environment(home: string, userData: string): Record<string, string> {
  const env: Record<string, string> = {};
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
  return {
    ...env,
    KPBL_DESKTOP_E2E: '1',
    KPBL_DESKTOP_HOME: home,
    KPBL_DESKTOP_USER_DATA: userData,
  };
}
async function stop(app: ElectronApplication) {
  const closed = app.waitForEvent('close', { timeout: 30_000 });
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await closed;
}
/** 统一按减少动效启动；库浮层 150ms 入场位移会让自动化点击落在移动前的坐标。 */
async function firstWindow(app: ElectronApplication) {
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return page;
}
test('隔离默认空间的真实窗口、发送与清理', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-electron-'));
  const userData = path.join(home, 'desktop-state');
  const requests: unknown[] = [];
  let cancelled = 0;
  execFileSync('git', ['init', '--quiet', home]);
  const server = http.createServer(async (request, response) => {
    let data = '';
    for await (const chunk of request) data += chunk;
    const body = JSON.parse(data);
    requests.push(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const input =
      [...body.messages].reverse().find((message: { role: string }) => message.role === 'user')
        ?.content ?? '';
    if (JSON.stringify(input).includes('cancel-stream')) {
      response.write(
        `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: '等待取消。' }, finish_reason: null }] })}\n\n`,
      );
      response.on('close', () => {
        cancelled++;
      });
      return;
    }
    if (JSON.stringify(input).includes('write-proof') && body.messages.at(-1)?.role !== 'tool') {
      response.end(
        `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: JSON.stringify(input).includes('pending') ? 'pending-proof.txt' : 'proof.txt', content: 'electron-tool-proof' }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    response.write(
      `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '本地链路验证完成。' }, finish_reason: null }] })}\n\n`,
    );
    response.end(
      `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  fs.mkdirSync(path.join(home, '.kapibala'));
  fs.writeFileSync(
    path.join(home, '.kapibala/settings.json'),
    JSON.stringify({
      profiles: [
        {
          id: 'unconfigured-fixture',
          name: '未配置的验收模型',
          provider: 'openai-compatible',
          modelName: 'unconfigured',
          baseURL: 'http://localhost:1/v1',
          apiKeyEnv: 'KPBL_MISSING_FIXTURE_KEY',
          contextWindow: 32000,
        },
        {
          id: 'fixture',
          name: '本地验收模型',
          provider: 'openai-compatible',
          modelName: 'fixture',
          baseURL: `http://127.0.0.1:${address.port}/v1`,
          apiKeyEnv: 'KPBL_FIXTURE_KEY',
          apiKey: 'test-only-local-credential',
          contextWindow: 32000,
        },
      ],
      defaultModel: 'unconfigured-fixture',
    }),
  );
  const app = await electron.launch({ args: [entry], env: environment(home, userData) });
  const page = await firstWindow(app);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    fs.mkdirSync(artifacts, { recursive: true });
    expect(
      await page
        .evaluate(() => window.kapibala.app.getInfo())
        .then((info) => ({ name: info.name, version: info.version, testBuild: info.testBuild })),
    ).toEqual({
      name: 'Kapibala',
      version: JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version,
      testBuild: true,
    });
    // 默认空间默认信任：首屏输入框直接可用，发送即创建会话，不出现中间确认。
    await expect(page.getByRole('textbox', { name: '发送消息' })).toBeEnabled();
    // 默认模型未配置密钥时，展示的回退模型必须真实用于首个请求。
    await page.getByRole('button', { name: /新对话模型/ }).click();
    await expect(page.getByRole('menuitem', { name: '本地验收模型' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: '未配置的验收模型' })).toHaveCount(0);
    await page.getByRole('menuitem', { name: '本地验收模型' }).click();
    const input = page.getByRole('textbox', { name: '发送消息' });
    const widthBefore = (await input.boundingBox())!.width;
    await input.fill('验证本地对话');
    expect((await input.boundingBox())!.width).toBeCloseTo(widthBefore, 0);
    expect(widthBefore).toBeGreaterThan(500);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByText('本地链路验证完成。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
    expect(requests.length).toBeGreaterThan(0);
    expect((requests[0] as { model: string }).model).toBe('fixture');
    const bubble = page.getByRole('article', { name: '你的消息' }).first();
    const geometry = await bubble.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      parentWidth: element.parentElement!.getBoundingClientRect().width,
      rightGap:
        element.parentElement!.getBoundingClientRect().right -
        element.getBoundingClientRect().right,
    }));
    expect(geometry.width).toBeLessThan(geometry.parentWidth / 2);
    expect(geometry.rightGap).toBeLessThan(30);
    await page.evaluate(() => window.kapibala.settings.setDefault('fixture'));
    const send = async (input: string) => {
      await page.getByRole('textbox', { name: '发送消息' }).fill(input);
      await page.getByRole('button', { name: '发送', exact: true }).click();
    };
    const approve = async () => {
      await page.getByRole('button', { name: '审批 1', exact: true }).click();
      await page.getByRole('button', { name: '批准一次', exact: true }).click();
      await expect(page.getByText('当前没有待处理请求。')).toBeVisible();
      await page.getByRole('button', { name: '关闭审批队列' }).click();
    };
    await send('write-proof-default');
    await approve();
    const defaultRoot = path.join(home, '.kapibala/workspaces/default');
    await expect.poll(() => fs.existsSync(path.join(defaultRoot, 'proof.txt'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'proof.txt'))).toBe(false);
    await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '查看详情', exact: true }).first().click();
    await expect(page.getByRole('dialog', { name: '工具详情' })).toBeVisible();
    const composer = page.getByRole('textbox', { name: '发送消息' });
    await composer.fill('保留中文草稿');
    await composer.press('Tab');
    await expect(page.getByRole('dialog', { name: '工具详情' })).toBeVisible();
    await composer.dispatchEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      isComposing: true,
      bubbles: true,
    });
    await expect(composer).toHaveValue('保留中文草稿');
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await expect(page.getByRole('button', { name: '查看详情', exact: true }).first()).toBeFocused();
    await page.getByRole('button', { name: '会话状态', exact: true }).click();
    await expect(page.getByRole('heading', { name: '运行事实', exact: true })).toBeVisible();
    await expect(
      page.getByText('观察不会收集结果或唤醒模型；投递未知时不补成已收集。'),
    ).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'details-1280.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1199, 800));
    await expect(page.getByRole('dialog', { name: '会话状态', exact: true })).toHaveAttribute(
      'aria-modal',
      'true',
    );
    await page.screenshot({ path: path.join(artifacts, 'details-1199.png') });
    await page.mouse.click(400, 200);
    await expect(page.getByRole('dialog', { name: '会话状态', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: '会话状态', exact: true })).toBeFocused();
    await expect(composer).toHaveValue('保留中文草稿');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
    await page.getByRole('button', { name: '会话状态', exact: true }).click();
    await composer.click();
    await expect(page.getByRole('dialog', { name: '会话状态', exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'details-1200.png') });
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    await send('cancel-stream');
    await expect(page.getByText('等待取消。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect.poll(() => cancelled).toBe(1);
    await expect(page.getByRole('button', { name: '正在取消', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '关闭当前会话' }).click();
    await page.getByRole('button', { name: '验证本地对话', exact: true }).click();
    await expect(page.getByText('验证本地对话', { exact: true }).last()).toBeVisible();
    const project = path.join(home, 'project');
    fs.mkdirSync(project);
    execFileSync('git', ['init', '--quiet', project]);
    await app.evaluate(({ dialog }, selection) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selection] });
    }, project);
    const beforeProjectCalls = requests.length;
    // 首页空态也提供「添加项目」；取侧栏入口，保持与既有断言同一目标。
    await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
    const creation = page.getByRole('dialog', { name: '创建项目', exact: true });
    await creation.getByRole('textbox', { name: '项目名称', exact: true }).fill('API 项目');
    await expect(creation.getByText('在此电脑上添加文件夹')).toBeVisible();
    await expect(creation.getByRole('button', { name: '创建项目', exact: true })).toBeDisabled();
    await creation.getByRole('button', { name: '选择文件夹', exact: true }).click();
    await expect(creation.getByRole('textbox', { name: '项目名称', exact: true })).toHaveValue(
      'API 项目',
    );
    expect((await page.evaluate(() => window.kapibala.preferences.read())).recent).toHaveLength(0);
    await expect(creation.getByRole('button', { name: '创建项目', exact: true })).toBeEnabled();
    await expect(creation).toHaveCSS('max-width', '500px');
    await page.screenshot({
      path: path.join(artifacts, 'project-create-1280.png'),
      animations: 'disabled',
    });
    await creation.getByRole('button', { name: '创建项目', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '信任此文件夹吗？', exact: true });
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toHaveCSS('max-width', '440px');
    await page.screenshot({
      path: path.join(artifacts, 'project-trust-1280.png'),
      animations: 'disabled',
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 600));
    await confirmation
      .getByRole('button', { name: '信任文件夹并创建', exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      confirmation.getByRole('button', { name: '信任文件夹并创建', exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      path: path.join(artifacts, 'project-trust-800.png'),
      animations: 'disabled',
    });
    await page.evaluate(() => window.kapibala.preferences.update('dark'));
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
    await page.screenshot({
      path: path.join(artifacts, 'project-trust-dark.png'),
      animations: 'disabled',
    });
    await page.evaluate(() => window.kapibala.preferences.update('light'));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    await expect(creation.getByRole('textbox', { name: '项目名称', exact: true })).toHaveValue(
      'API 项目',
    );
    await expect(
      creation.getByText(fs.realpathSync.native(project), { exact: true }),
    ).toBeVisible();
    expect(fs.existsSync(path.join(project, '.kapibala'))).toBe(false);
    expect((await page.evaluate(() => window.kapibala.preferences.read())).recent).toHaveLength(0);
    await creation.getByRole('button', { name: '创建项目', exact: true }).click();
    await confirmation.getByRole('button', { name: '信任文件夹并创建', exact: true }).click();
    await expect(creation).toBeHidden();
    await expect(page.getByRole('button', { name: 'API 项目', exact: true })).toBeVisible();
    expect((await page.evaluate(() => window.kapibala.preferences.read())).recent[0].name).toBe(
      'API 项目',
    );
    expect(requests.length).toBe(beforeProjectCalls);
    // 新对话输入区可在已登记项目和默认空间之间切换，再在所选项目中创建会话。
    await page.getByRole('button', { name: '会话空间：API 项目' }).click();
    await page.getByRole('menuitem', { name: '默认空间' }).click();
    await expect(page.getByRole('button', { name: '会话空间：默认空间' })).toBeVisible();
    await page.getByRole('button', { name: '会话空间：默认空间' }).click();
    await page.getByRole('menuitem', { name: 'API 项目' }).click();
    await expect(page.getByRole('button', { name: '会话空间：API 项目' })).toBeVisible();
    await page.getByRole('button', { name: '新建对话', exact: true }).last().click();
    await send('write-proof-project');
    await approve();
    await expect.poll(() => fs.existsSync(path.join(project, 'proof.txt'))).toBe(true);
    await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
    await send('write-proof-pending');
    await expect(page.getByRole('button', { name: '审批 1', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '默认空间', exact: true }).click();
    await expect(page.getByRole('button', { name: '审批 1', exact: true })).toBeVisible();
    await expect(page.getByLabel('API 项目 待审批', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: '审批 0', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'API 项目', exact: true }).click();
    expect(fs.existsSync(path.join(project, 'pending-proof.txt'))).toBe(false);
    await page.getByRole('button', { name: 'write-proof-project', exact: true }).click();
    await expect(page.getByText('本地链路验证完成。', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'chat-1280.png') });
    await page.getByRole('button', { name: '打开设置' }).click();
    await expect(page.getByRole('textbox', { name: '新 API Key', exact: true })).toHaveValue('');
    const beforeSettings = fs.readFileSync(path.join(home, '.kapibala/settings.json'), 'utf8');
    const beforeCalls = requests.length;
    await page.getByRole('spinbutton', { name: '最大输出 Token', exact: true }).fill('256');
    await page.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(page.getByText('确认模型与凭证', { exact: true })).toBeVisible();
    expect(fs.readFileSync(path.join(home, '.kapibala/settings.json'), 'utf8')).toBe(
      beforeSettings,
    );
    await page.getByRole('combobox', { name: '本次凭证选择' }).click();
    await page.getByRole('option', { name: '明确复用目标分组或环境凭证', exact: true }).click();
    await page.getByRole('button', { name: '确认保存配置', exact: true }).click();
    await expect(page.getByText('配置已保存。连接是否可用将在明确发送任务后验证。')).toBeVisible();
    expect(
      JSON.parse(fs.readFileSync(path.join(home, '.kapibala/settings.json'), 'utf8')).profiles.find(
        (profile: { id: string }) => profile.id === 'fixture',
      ).maxOutputTokens,
    ).toBe(256);
    expect(requests.length).toBe(beforeCalls);
    await page.getByRole('tab', { name: '外观与应用' }).click();
    await page.getByRole('combobox', { name: '主题', exact: true }).click();
    await page.getByRole('option', { name: '深色', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.screenshot({ path: path.join(artifacts, 'chat-dark.png') });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: '打开设置' }).click();
    await page.getByRole('tab', { name: '外观与应用' }).click();
    await page.getByRole('combobox', { name: '主题', exact: true }).click();
    await page.getByRole('option', { name: '浅色', exact: true }).click();
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 600));
    await expect(page.locator('[data-sidebar-wrapper]')).toHaveAttribute('data-state', 'collapsed');
    await page.screenshot({ path: path.join(artifacts, 'chat-800.png') });
    const bounds = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width);
    await stop(app);
    expect(fs.existsSync(path.join(userData, 'host-guard.json'))).toBe(false);
  } finally {
    await app.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('默认目录不可用时保持阻断且可使用项目入口，不回退到 home', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-electron-unavailable-'));
  const userData = path.join(home, 'desktop-state');
  fs.mkdirSync(path.join(home, '.kapibala'));
  fs.writeFileSync(path.join(home, '.kapibala/workspaces'), 'occupied');
  const project = path.join(home, 'project');
  fs.mkdirSync(project);
  const app = await electron.launch({ args: [entry], env: environment(home, userData) });
  try {
    const page = await firstWindow(app);
    await expect(page.getByRole('alert')).toContainText('无法使用默认空间');
    await expect(page.getByRole('button', { name: '新建对话', exact: true }).last()).toBeDisabled();
    await app.evaluate(({ dialog }, selection) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selection] });
    }, project);
    // 首页空态也提供「添加项目」；取侧栏入口，保持与既有断言同一目标。
    await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
    await page.getByRole('button', { name: '选择文件夹', exact: true }).click();
    await page.getByRole('button', { name: '创建项目', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '信任此文件夹吗？', exact: true })).toBeVisible();
    await page
      .getByRole('dialog', { name: '信任此文件夹吗？', exact: true })
      .getByRole('button', { name: '取消', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: '创建项目', exact: true })
      .getByRole('button', { name: '取消', exact: true })
      .click();
    expect(fs.readFileSync(path.join(home, '.kapibala/workspaces'), 'utf8')).toBe('occupied');
    expect(fs.existsSync(path.join(home, 'proof.txt'))).toBe(false);
    await stop(app);
    expect(fs.existsSync(path.join(userData, 'host-guard.json'))).toBe(false);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Host 异常退出保留 guard，下一次启动不自动 fork 或重放', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-electron-crash-'));
  const userData = path.join(home, 'desktop-state');
  let app = await electron.launch({ args: [entry], env: environment(home, userData) });
  try {
    let page = await firstWindow(app);
    await expect(page.getByRole('textbox', { name: '发送消息' })).toBeEnabled();
    const record = fs.readFileSync(path.join(userData, 'host-guard.json'), 'utf8');
    await app.evaluate(({ app }) => {
      const host = app.getAppMetrics().find((item) => item.name === 'Kapibala Agent Host');
      if (!host) throw new Error('Missing utility Host');
      process.kill(host.pid, 'SIGKILL');
    });
    await expect(page.getByRole('alert')).toContainText('Host 已断开');
    expect(fs.readFileSync(path.join(userData, 'host-guard.json'), 'utf8')).toBe(record);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await stop(app);
    app = await electron.launch({ args: [entry], env: environment(home, userData) });
    page = await firstWindow(app);
    await expect(page.getByRole('alert')).toContainText('上次执行未确认完成清理');
    expect(
      await app.evaluate(
        ({ app }) =>
          app.getAppMetrics().filter((item) => item.name === 'Kapibala Agent Host').length,
      ),
    ).toBe(0);
    expect(fs.readFileSync(path.join(userData, 'host-guard.json'), 'utf8')).toBe(record);
    await stop(app);
    expect(fs.existsSync(path.join(userData, 'host-guard.json'))).toBe(true);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('千条历史虚拟化、Markdown 复制、阅读位置与已卸载触发器焦点返回', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-electron-history-'));
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
  const handle = await new SessionManager({
    workspaceRoot: root,
    projectRootMode: 'exact',
    homeDirectory: home,
  }).create();
  for (let i = 0; i < 500; i++) {
    await handle.store.append({
      role: 'user',
      content: [{ type: 'text', text: i === 0 ? '长历史滚动验收' : `第 ${i} 条问题` }],
    });
    await handle.store.append({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: `第 ${i} 条回复\n\n${'用于真实阅读位置和动态测量的长段落。'.repeat(30)}`,
        },
      ],
    });
  }
  await handle.store.append({ role: 'user', content: [{ type: 'text', text: '显示代码和工具' }] });
  await handle.store.append({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '可折叠的公开思考' },
      {
        type: 'text',
        text: '# Markdown 验收\n\n```typescript\nconst answer = 42;\n```\n\n| 名称 | 值 |\n| --- | --- |\n| answer | 42 |\n\n<script>window.forbidden = true</script>',
      },
      { type: 'tool_use', id: 'history-tool', name: 'read_file', input: { path: 'proof.txt' } },
    ],
  });
  await handle.store.append({
    role: 'tool',
    content: [
      {
        type: 'tool_result',
        toolUseId: 'history-tool',
        content:
          '只读历史工具结果\n--- a/proof.txt\n+++ b/proof.txt\n@@ -1 +1 @@\n-旧内容\n+新内容',
        durationMs: 12,
      },
    ],
  });
  await handle.release();
  // 后续元数据晚于长历史，确保长历史位于第二页；通过真实列表验证后台刷新保留页码。
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  const histories = new SessionManager({
    workspaceRoot: root,
    projectRootMode: 'exact',
    homeDirectory: home,
  });
  for (let i = 0; i < 50; i++) {
    const other = await histories.create();
    await other.store.append({
      role: 'user',
      content: [
        { type: 'text', text: i === 0 ? '分页对话 test-only-offline-key' : `分页对话 ${i}` },
      ],
    });
    await other.release();
  }
  const app = await electron.launch({
    args: [entry],
    env: environment(home, path.join(home, 'desktop-state')),
  });
  try {
    const page = await firstWindow(app);
    const search = page.getByRole('searchbox', { name: '搜索空间与对话' });
    await search.fill('test-only-offline-key');
    await expect(
      page.getByText('已打开的空间中没有匹配的对话。最近项目需先打开才能搜索。'),
    ).toBeVisible();
    await search.fill('长历史滚动验收');
    await expect(page.getByRole('button', { name: '长历史滚动验收', exact: true })).toBeVisible();
    await search.fill('');
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.getByRole('button', { name: '长历史滚动验收', exact: true }).click();
    await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Markdown 验收', exact: true })).toBeVisible();
    expect(await page.getByRole('article').count()).toBeLessThan(40);
    await expect(page.getByText('可折叠的公开思考', { exact: true })).toBeHidden();
    await page.getByRole('button', { name: '思考过程', exact: true }).click();
    await expect(page.getByText('可折叠的公开思考', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '查看差异预览', exact: true }).click();
    await expect(page.getByText('+新内容', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'diff-preview.png') });
    await page.getByRole('button', { name: '复制代码', exact: true }).click();
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe('const answer = 42;');
    expect(await page.evaluate(() => 'forbidden' in window)).toBe(false);
    await page.getByRole('button', { name: /当前会话模型/ }).click();
    // 通过菜单键盘操作打开子菜单，避免鼠标悬停受窗口布局影响。
    const roleTrigger = page.getByRole('menuitem', { name: /会话角色/ });
    const fastRole = page.getByRole('menuitem', { name: '快速', exact: true });
    await roleTrigger.focus();
    await roleTrigger.press('ArrowRight');
    await expect(fastRole).toBeVisible();
    await fastRole.click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /会话模式/ }).click();
    await page.getByRole('menuitem', { name: '计划', exact: true }).click();
    await expect(page.getByRole('button', { name: /会话模式/ })).toContainText('计划');
    await page.getByRole('button', { name: /会话模式/ }).click();
    await page.getByRole('menuitem', { name: '逐次审批', exact: true }).click();
    await page.getByRole('textbox', { name: '发送消息' }).fill('切换后保留的草稿');
    const sendButton = page.getByRole('button', { name: '发送', exact: true });
    const styles: unknown[] = [];
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((theme) => window.kapibala.preferences.update(theme), theme);
      await expect(page.locator('html')).toHaveAttribute('data-mode', theme);
      for (const state of ['normal', 'hover', 'focus', 'active'] as const) {
        await page.mouse.move(0, 0);
        if (state === 'hover' || state === 'active') await sendButton.hover();
        if (state === 'focus') {
          await sendButton.focus();
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Tab');
          await expect(sendButton).toBeFocused();
        }
        if (state === 'active') await page.mouse.down();
        styles.push(
          await sendButton.evaluate(
            (button, scenario) => {
              const style = getComputedStyle(button);
              const before = getComputedStyle(
                button.querySelector('span[aria-hidden="true"]') ?? button,
              );
              const canvas = document.createElement('canvas');
              canvas.width = 1;
              canvas.height = 1;
              const context = canvas.getContext('2d')!;
              const rgb = (color: string) => {
                context.fillStyle = color;
                context.fillRect(0, 0, 1, 1);
                return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
              };
              const luminance = (color: string) =>
                rgb(color)
                  .map((byte) => {
                    const value = byte / 255;
                    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
                  })
                  .reduce((total, value, i) => total + value * [0.2126, 0.7152, 0.0722][i], 0);
              const contrast = (a: string, b: string) => {
                const x = luminance(a);
                const y = luminance(b);
                return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
              };
              const base = getComputedStyle(document.documentElement).getPropertyValue(
                '--color-kumo-base',
              );
              const samples = [
                '--kumo-button-emphasis-bg',
                '--kumo-button-emphasis-gradient-start',
                '--kumo-button-emphasis-gradient-end',
              ].map((token) => style.getPropertyValue(token));
              return {
                ...scenario,
                textContrast: Math.min(...samples.map((sample) => contrast(style.color, sample))),
                boundaryContrast: contrast(
                  style.getPropertyValue('--kumo-button-emphasis-ring'),
                  base,
                ),
                focusContrast: contrast(style.outlineColor, base),
                color: style.color,
                background: style.backgroundColor,
                gradient: before.backgroundImage,
                pseudoBackground: before.backgroundColor,
                focus: style.outlineColor,
                outlineWidth: style.outlineWidth,
                base: getComputedStyle(document.documentElement).getPropertyValue(
                  '--color-kumo-base',
                ),
              };
            },
            { theme, state },
          ),
        );
        if (state === 'active') {
          await page.mouse.move(0, 0);
          await page.mouse.up();
        }
      }
    }
    fs.writeFileSync(path.join(artifacts, 'button-states.json'), JSON.stringify(styles, null, 2));
    for (const sample of styles as Array<{
      state: string;
      textContrast: number;
      boundaryContrast: number;
      focusContrast: number;
      outlineWidth: string;
    }>) {
      expect(sample.textContrast).toBeGreaterThanOrEqual(4.5);
      expect(sample.boundaryContrast).toBeGreaterThanOrEqual(3);
      if (sample.state === 'focus') {
        expect(sample.focusContrast).toBeGreaterThanOrEqual(3);
        expect(Number.parseFloat(sample.outlineWidth)).toBeGreaterThanOrEqual(2);
      }
    }
    await page.evaluate(() => window.kapibala.preferences.update('system'));
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark';
    });
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'light';
    });
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'light');
    expect(
      await page.evaluate(() => window.kapibala.preferences.read().then((prefs) => prefs.theme)),
    ).toBe('system');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await sendButton.evaluate((button) => getComputedStyle(button).transitionDuration)).toBe(
      '0s',
    );
    await page.getByRole('button', { name: '查看详情', exact: true }).click();
    const log = page.getByRole('log', { name: '对话内容' });
    await log.dispatchEvent('wheel', { deltaY: -100, bubbles: true });
    await log.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(page.getByRole('button', { name: '查看详情', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await expect(log).toBeFocused();
    await page.getByRole('button', { name: '新建对话', exact: true }).first().click();
    await page.getByRole('button', { name: '长历史滚动验收', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '发送消息' })).toHaveValue('切换后保留的草稿');
    await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBeLessThan(10);
    await expect(page.getByRole('button', { name: '返回底部', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回底部', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Markdown 验收', exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'history-virtualized.png') });
    await stop(app);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('渲染层异常由错误边界兜底，恢复界面可重载回正常会话', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-electron-boundary-'));
  const userData = path.join(home, 'desktop-state');
  const app = await electron.launch({ args: [entry], env: environment(home, userData) });
  const page = await firstWindow(app);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    fs.mkdirSync(artifacts, { recursive: true });
    await expect(page.getByRole('textbox', { name: '发送消息' })).toBeEnabled();
    // 注入必须发生在渲染期：专用事件只把探针置位，下一次渲染抛错并由错误边界兜底。
    await page.evaluate(() => {
      window.dispatchEvent(new Event('kpbl-e2e-render-fault'));
    });
    await expect(page.getByRole('heading', { name: '界面渲染出现异常' })).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'boundary-fallback.png') });
    // 按钮动作就是整页重载，noWaitAfter 避免 Playwright 把导航本身当待完成动作等待。
    await page.getByRole('button', { name: '重新加载界面', exact: true }).click({
      noWaitAfter: true,
    });
    await expect(page.getByRole('textbox', { name: '发送消息' })).toBeEnabled();
    // 边界捕获的渲染错误不是未处理异常，不应产生 pageerror。
    expect(errors).toEqual([]);
    await stop(app);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});
