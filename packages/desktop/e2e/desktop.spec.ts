/// <reference path="../src/renderer/global.d.ts" />
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '@kiturone/kapibala';
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test';
import { desktopLaunchEnv } from '../scripts/launch-env.mjs';

const entry = path.resolve('.');
const artifacts = path.resolve('../../.workbuddy/desktop-stage-e');
// 环境构造统一走白名单助手：宿主注入的 NODE_OPTIONS / ELECTRON_RUN_AS_NODE 不能进主进程。
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
/** 统一按减少动效启动；库浮层 150ms 入场位移会让自动化点击落在移动前的坐标。 */
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
    if (JSON.stringify(input).includes('html-proof') && body.messages.at(-1)?.role !== 'tool') {
      response.end(
        `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'preview.html', content: '<!doctype html><html><body><script>document.body.textContent="preview-ran";</script></body></html>' }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    if (JSON.stringify(input).includes('write-proof') && body.messages.at(-1)?.role !== 'tool') {
      response.end(
        `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: JSON.stringify(input).includes('pending') ? 'pending-proof.txt' : 'proof.txt', content: 'electron-tool-proof' }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    if (JSON.stringify(input).includes('image-proof') && body.messages.at(-1)?.role !== 'tool') {
      response.end(
        `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'preview-demo.png', content: 'not-a-real-png' }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    if (JSON.stringify(input).includes('markdown-proof')) {
      const content =
        '这是**重点**内容，图片如下：\n\n![示意图](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR4nGOwbvpGFcQwatCoQaMGjRo0atCoQQNvEABPRNLupSafpAAAAABJRU5ErkJggg==)';
      response.end(
        `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
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
    const pickerSearch = page.getByRole('combobox', { name: '搜索代理或模型' });
    await expect(pickerSearch).toBeFocused();
    await page.getByRole('button', { name: 'Kapibala', exact: true }).click();
    await expect(page.getByRole('option', { name: '本地验收模型' })).toBeVisible();
    await pickerSearch.fill('unconfigured');
    await expect(page.getByText('没有匹配的代理或模型')).toBeVisible();
    await expect(page.getByRole('option', { name: '未配置的验收模型' })).toHaveCount(0);
    await pickerSearch.fill('fixture');
    await expect(page.getByRole('option', { name: '本地验收模型' })).toBeVisible();
    await pickerSearch.press('Enter');
    // 选择即落盘为全局默认：重启后仍沿用该模型，而不是回落到初始默认值。
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.kapibala.settings.read().then((settings) => settings.defaultModel),
        ),
      )
      .toBe('fixture');
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
      // 新审批自动弹出队列，标题栏不再有常驻计数入口。
      const queue = page.getByRole('dialog', { name: '待处理审批', exact: true });
      await expect(queue).toBeVisible();
      // 阻塞等人工确认时，底栏状态行必须诚实显示「等待审批确认」而非「正在写入/正在运行」。
      await expect(page.getByText(/等待审批确认/)).toBeVisible();
      // 弹窗宽度基线 500px（设计 004 §6.3.4）；空队列已无从打开，宽度断言落在这里。
      await expect(queue).toHaveCSS('max-width', '500px');
      await queue.getByRole('button', { name: '批准一次', exact: true }).click();
      // 队列清空后自动收起，不再需要手动关闭浮层。
      await expect(queue).toBeHidden();
    };
    await send('write-proof-default');
    await approve();
    const defaultRoot = path.join(home, '.kapibala/workspaces/default');
    await expect.poll(() => fs.existsSync(path.join(defaultRoot, 'proof.txt'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'proof.txt'))).toBe(false);
    await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
    // 会话看板：成功写入后摘要 chip 常驻，点击进入四分区面板并可用同一关闭入口返回。
    await expect
      .poll(() => page.getByRole('button', { name: '会话证据摘要', exact: true }).count())
      .toBe(1);
    await page.getByRole('button', { name: '会话证据摘要', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '会话证据', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '摘要', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    const composer = page.getByRole('textbox', { name: '发送消息' });
    // CI runner 的显示器可能小于默认窗宽（如 macOS 1176×885），窗口会被钳制到工作区，
    // 不能假设一定拿到 ≥1200 的宽布局；两种布局分别验收真实行为。
    const wide = await page.evaluate(() => matchMedia('(min-width: 1200px)').matches);
    console.log(
      `[desktop.spec] layout=${wide ? 'wide' : 'narrow'} innerWidth=${await page.evaluate(() => innerWidth)}`,
    );
    if (!wide) await composer.fill('保留中文草稿');
    await page.getByRole('button', { name: '查看详情', exact: true }).first().click();
    await expect(page.getByRole('dialog', { name: '工具详情' })).toBeVisible();
    if (wide) {
      // 宽布局：抽屉非模态，正文可继续输入，IME 组合键 Enter 不发送。
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
    } else {
      // 窄布局：抽屉按设计模态化，背景内容对可达性树不可见；草稿先填后开，关闭后仍须保留。
      await expect(page.getByRole('dialog', { name: '工具详情' })).toHaveAttribute(
        'aria-modal',
        'true',
      );
      await expect(composer).toHaveCount(0);
      await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    }
    await expect(page.getByRole('button', { name: '查看详情', exact: true }).first()).toBeFocused();
    await page.getByRole('button', { name: '会话状态', exact: true }).click();
    await expect(page.getByRole('heading', { name: '运行事实', exact: true })).toBeVisible();
    await expect(
      page.getByText('观察不会收集结果或唤醒模型；投递未知时不补成已收集。'),
    ).toBeVisible();
    const setViewportWidth = async (targetWidth: number, height: number, bound: 'max' | 'min') => {
      let desiredOuter = await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize()[0],
      );
      for (let attempt = 0; attempt < 8; attempt++) {
        const currentInner = await page.evaluate(() => innerWidth);
        if (
          currentInner === targetWidth ||
          (bound === 'max' && currentInner <= targetWidth) ||
          (bound === 'min' && currentInner >= targetWidth && attempt > 0)
        ) {
          break;
        }
        const rawDelta = targetWidth - currentInner;
        const step =
          attempt === 0 && rawDelta !== 0
            ? rawDelta
            : bound === 'max'
              ? -Math.max(2, currentInner - targetWidth + 1)
              : Math.max(2, targetWidth - currentInner + 1);
        desiredOuter += step;
        await app.evaluate(
          ({ BrowserWindow }, { nextWidth, nextHeight }) => {
            BrowserWindow.getAllWindows()[0].setSize(nextWidth, nextHeight);
          },
          { nextWidth: desiredOuter, nextHeight: height },
        );
        await page.waitForTimeout(40);
      }
    };
    await page.screenshot({ path: path.join(artifacts, 'details-1280.png') });
    // Windows titleBarStyle:'hidden' 下 Electron setContentSize 会叠加标准边框余量导致视口偏宽，
    // 按实测 innerWidth 闭环收敛到 <1200 / ≥1200 断点，确保跨平台与分数缩放一致覆盖模态切换。
    await setViewportWidth(1199, 800, 'max');
    await expect(page.getByRole('dialog', { name: '会话状态', exact: true })).toHaveAttribute(
      'aria-modal',
      'true',
    );
    await page.screenshot({ path: path.join(artifacts, 'details-1199.png') });
    await page.mouse.click(400, 200);
    await expect(page.getByRole('dialog', { name: '会话状态', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: '会话状态', exact: true })).toBeFocused();
    await expect(composer).toHaveValue('保留中文草稿');
    if (wide) await setViewportWidth(1200, 800, 'min');
    await page.getByRole('button', { name: '会话状态', exact: true }).click();
    if (wide) {
      // 仅宽布局可断言「点击正文不关闭抽屉」；窄布局下背景在模态遮罩内不可点。
      await composer.click();
      await expect(page.getByRole('dialog', { name: '会话状态', exact: true })).toBeVisible();
    }
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
    // 项目创建入口统一在输入框旁的空间选择器：现有项目、最近项目与新建项目在同一菜单。
    await page.getByRole('button', { name: /会话空间：|选择空间/ }).click();
    await page.getByRole('menuitem', { name: '新建项目' }).click();
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
    // 项目行的「在该空间新建对话」默认完全透明，指针进入才显形：入口不挤占标题宽度，
    // 悬停时用自身底色盖住状态文本，离开后恢复隐藏。
    const rowNew = page.getByRole('button', { name: '在 API 项目 新建对话', exact: true });
    await expect(rowNew).toHaveCSS('opacity', '0');
    await page.getByRole('button', { name: 'API 项目', exact: true }).hover();
    await expect(rowNew).toHaveCSS('opacity', '1');
    await page.mouse.move(700, 200);
    await expect(rowNew).toHaveCSS('opacity', '0');
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
    // 待审批只由自动弹出的队列与侧栏状态触达，标题栏不再显示计数。
    const queue = page.getByRole('dialog', { name: '待处理审批', exact: true });
    await expect(queue).toBeVisible();
    await page.getByRole('button', { name: '关闭审批队列' }).click();
    await expect(queue).toBeHidden();
    await page.getByRole('button', { name: '默认空间', exact: true }).click();
    await expect(page.getByLabel('API 项目 待审批', { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'API 项目', exact: true }).click();
    expect(fs.existsSync(path.join(project, 'pending-proof.txt'))).toBe(false);
    await page.getByRole('button', { name: 'write-proof-project', exact: true }).click();
    await expect(page.getByText('本地链路验证完成。', { exact: true })).toBeVisible();
    // HTML 预览：write_file 写出 .html 才出现入口；点击后由独立协议来源在沙箱 iframe 里执行。
    await send('html-proof');
    await approve();
    const previewButton = page.getByRole('button', { name: '预览 HTML', exact: true });
    await expect(previewButton).toBeVisible();
    await previewButton.click();
    await expect(
      page.frameLocator('iframe[title="HTML 文件预览"]').getByText('preview-ran'),
    ).toBeVisible();
    // 图片产物：write_file 写出 .png 后右侧 dock 自动打开预览；不可读取时显示占位而不阻塞对话。
    await send('image-proof');
    await approve();
    const artifactDock = page.getByRole('dialog', { name: '产物预览', exact: true });
    await expect(artifactDock).toBeVisible();
    await expect(artifactDock.getByText('preview-demo.png', { exact: true })).toBeVisible();
    await expect(artifactDock.getByText(/无法读取该图片/)).toBeVisible();
    // 窄窗口下抽屉是模态的：先关闭，再断言 chip 常驻并可用于重开（宽窄布局同一口径）。
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await expect(artifactDock).toBeHidden();
    const artifactChip = page.getByRole('button', {
      name: '预览图片 preview-demo.png',
      exact: true,
    });
    await expect(artifactChip).toBeVisible();
    await artifactChip.click();
    await expect(artifactDock).toBeVisible();
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    // Markdown 效果：CJK 相邻的粗体可解析，data: 图片直接渲染。
    await send('markdown-proof');
    await expect(page.getByText('重点', { exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: '示意图' })).toBeVisible();
    expect(errors).toEqual([]);
    fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'chat-1280.png') });
    await page.getByRole('button', { name: '打开设置' }).click();
    // 设置页首屏选中当前默认模型（本地验收模型，自定义端点分组）；自定义端点走 custom 表单，
    // 自定义端点分组的密钥字段名是「API Key（必填）」，且不会回显已存凭证。
    await expect(page.getByRole('textbox', { name: 'API Key（必填）', exact: true })).toHaveValue(
      '',
    );
    const beforeCalls = requests.length;
    // 输出预算在默认折叠的高级设置里；保存即落盘，不再有预览令牌与二次确认。
    await page.getByText('高级设置', { exact: true }).click();
    // 容量刻度芯片：窗口与输出各一组，点击只写数值，手填仍可覆盖（下面继续填 256 验证）。
    await page.getByRole('button', { name: '128k', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: '上下文窗口', exact: true })).toHaveValue(
      '128000',
    );
    await page.getByRole('button', { name: '8k', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: '最大输出 Token', exact: true })).toHaveValue(
      '8000',
    );
    await page.getByRole('spinbutton', { name: '最大输出 Token', exact: true }).fill('256');
    await page.getByRole('button', { name: '保存到本地', exact: true }).click();
    await expect(page.getByText('已保存到本地配置。', { exact: true })).toBeVisible();
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
    // 权限审批：只提供常规三档，保存即写全局默认；完全访问不在配置层出现。
    await page.getByRole('tab', { name: '权限审批' }).click();
    const settingsDialog = page.getByRole('dialog');
    await expect(settingsDialog.getByRole('button', { name: /完全访问/ })).toHaveCount(0);
    await settingsDialog.getByRole('button', { name: /自主模式/ }).click();
    await page.screenshot({ path: path.join(artifacts, 'settings-permission.png') });
    await expect
      .poll(() =>
        page.evaluate(() => window.kapibala.settings.read().then((item) => item.permissionMode)),
      )
      .toBe('Auto');
    await page.getByRole('button', { name: '返回应用', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.screenshot({ path: path.join(artifacts, 'chat-dark.png') });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: '打开设置' }).click();
    await page.getByRole('tab', { name: '外观与应用' }).click();
    await page.getByRole('combobox', { name: '主题', exact: true }).click();
    await page.getByRole('option', { name: '浅色', exact: true }).click();
    await page.getByRole('button', { name: '返回应用', exact: true }).click();
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
    // 项目创建入口统一在输入框旁的空间选择器：现有项目、最近项目与新建项目在同一菜单。
    await page.getByRole('button', { name: /会话空间：|选择空间/ }).click();
    await page.getByRole('menuitem', { name: '新建项目' }).click();
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
    await expect(page.getByText('已打开的空间中没有匹配的对话。')).toBeVisible();
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
    const roleSection = page.getByRole('region', { name: '会话角色', exact: true });
    const fastRole = roleSection.getByRole('button', { name: '快速', exact: true });
    await expect(fastRole).toBeVisible();
    await fastRole.click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /当前会话模型/ })).toContainText('快速');
    await page.getByRole('button', { name: /会话模式/ }).click();
    await page.getByRole('menuitem', { name: /计划模式/ }).click();
    await expect(page.getByRole('button', { name: /会话模式/ })).toContainText('计划模式');
    await page.getByRole('button', { name: /会话模式/ }).click();
    await page.getByRole('menuitem', { name: /变更前确认/ }).click();
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
        // Windows 分数缩放（如 125% DPI）会将 2px CSS outline 吸附到整数物理像素再折回 CSS 像素（约 1.6px）。
        expect(Number.parseFloat(sample.outlineWidth)).toBeGreaterThanOrEqual(1.5);
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

test('项目工作区写入图片后自动预览并保留 chip 入口', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-electron-artifact-'));
  const userData = path.join(home, 'desktop-state');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-artifact-project-'));
  execFileSync('git', ['init', '--quiet', project]);
  const server = http.createServer(async (request, response) => {
    let data = '';
    for await (const chunk of request) data += chunk;
    const body = JSON.parse(data);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const input =
      [...body.messages].reverse().find((message: { role: string }) => message.role === 'user')
        ?.content ?? '';
    // 模型先写出一张 .png（内容不是真实位图），随后正常收尾；预览读取必然失败走占位分支。
    if (input.includes('image-proof') && body.messages.at(-1)?.role !== 'tool') {
      response.end(
        `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-image', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'preview-demo.png', content: 'not-a-real-png' }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    response.end(
      `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: '本地链路验证完成。' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
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
      defaultModel: 'fixture',
    }),
  );
  const app = await electron.launch({ args: [entry], env: environment(home, userData) });
  try {
    const page = await firstWindow(app);
    await expect(page.getByRole('textbox', { name: '发送消息' })).toBeEnabled();
    // 默认空间位于 ~/.kapibala 下（按设计整根排除），产物只能来自真实项目工作区。
    await app.evaluate(({ dialog }, selection) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selection] });
    }, project);
    await page.getByRole('button', { name: /会话空间：|选择空间/ }).click();
    await page.getByRole('menuitem', { name: '新建项目' }).click();
    const creation = page.getByRole('dialog', { name: '创建项目', exact: true });
    await creation.getByRole('textbox', { name: '项目名称', exact: true }).fill('产物项目');
    await creation.getByRole('button', { name: '选择文件夹', exact: true }).click();
    await creation.getByRole('button', { name: '创建项目', exact: true }).click();
    await page
      .getByRole('dialog', { name: '信任此文件夹吗？', exact: true })
      .getByRole('button', { name: '信任文件夹并创建', exact: true })
      .click();
    await expect(creation).toBeHidden();
    await page.getByRole('button', { name: /会话空间：|选择空间/ }).click();
    await page.getByRole('menuitem', { name: '产物项目', exact: true }).click();
    await page.getByRole('button', { name: '新建对话', exact: true }).last().click();
    await page.getByRole('textbox', { name: '发送消息' }).fill('image-proof');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const queue = page.getByRole('dialog', { name: '待处理审批', exact: true });
    await expect(queue).toBeVisible();
    await queue.getByRole('button', { name: '批准一次', exact: true }).click();
    await expect(queue).toBeHidden();
    const dock = page.getByRole('dialog', { name: '产物预览', exact: true });
    await expect(dock).toBeVisible();
    await expect(dock.getByText('preview-demo.png', { exact: true })).toBeVisible();
    await expect(dock.getByText(/无法读取该图片/)).toBeVisible();
    // 窄窗口下产物抽屉是模态的，背景消息列表按设计不可达；chip 是关闭后的常驻重开入口，
    // 因此先验证自动弹出，再关闭并断言 chip 仍存在、点击可重开（宽窄布局同一口径）。
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await expect(dock).toBeHidden();
    const chip = page.getByRole('button', { name: '预览图片 preview-demo.png', exact: true });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(dock).toBeVisible();
    // 顶栏常驻入口：有产物时不依赖工具行 chip，也能主动重开最新预览。
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await expect(dock).toBeHidden();
    await page.getByRole('button', { name: '打开产物预览', exact: true }).click();
    await expect(dock).toBeVisible();
    await expect(dock.getByText('preview-demo.png', { exact: true })).toBeVisible();
    await stop(app);
  } finally {
    await app.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
