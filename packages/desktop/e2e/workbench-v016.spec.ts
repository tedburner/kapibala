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

function initGitRepoWithCommit(repoDir: string, relFile: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(repoDir, relFile)), { recursive: true });
  execFileSync('git', ['init', '--quiet', repoDir]);
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'e2e@kapibala.local']);
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Kapibala E2E']);
  fs.writeFileSync(path.join(repoDir, relFile), content, 'utf8');
  execFileSync('git', ['-C', repoDir, 'add', relFile]);
  execFileSync('git', ['-C', repoDir, 'commit', '--quiet', '-m', 'chore: initial baseline']);
}

test('五标签工程工作台：真实 Shadow Git 检查点 Diff 与外科还原、文件检视引用、PTY 保活终端与回环预览守卫', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-e2e-wb016-'));
  const userData = path.join(home, 'desktop-state');
  const projectDir = path.join(home, 'wb-repo');
  initGitRepoWithCommit(projectDir, 'src/app.ts', 'export const version = 1;\n');

  const modelServer = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk.toString('utf8');
    const body = JSON.parse(raw);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const lastRole = body.messages.at(-1)?.role;
    if (lastRole !== 'tool') {
      const toolArgs = JSON.stringify({
        path: 'src/app.ts',
        content: 'export const version = 2;\n',
      });
      response.end(
        `data: ${JSON.stringify({
          id: 'wb-1',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_upgrade_1',
                    type: 'function',
                    function: { name: 'write_file', arguments: toolArgs },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\ndata: ${JSON.stringify({
          id: 'wb-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    response.end(
      `data: ${JSON.stringify({
        id: 'wb-2',
        choices: [{ index: 0, delta: { content: '已将版本号升级至 2。' }, finish_reason: null }],
      })}\n\ndata: ${JSON.stringify({
        id: 'wb-2',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\ndata: [DONE]\n\n`,
    );
  });

  const loopbackPreviewServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><h1>KPBL_LOOPBACK_PREVIEW_OK</h1></body></html>');
  });

  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => loopbackPreviewServer.listen(0, '127.0.0.1', resolve));
  const modelPort = (modelServer.address() as { port: number }).port;
  const previewPort = (loopbackPreviewServer.address() as { port: number }).port;

  fs.mkdirSync(path.join(home, '.kapibala'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.kapibala/settings.json'),
    JSON.stringify({
      profiles: [
        {
          id: 'wb-fixture',
          name: '工作台验收模型',
          provider: 'openai-compatible',
          modelName: 'wb-fixture',
          baseURL: `http://127.0.0.1:${modelPort}/v1`,
          apiKeyEnv: 'KPBL_WB_FIXTURE_KEY',
          apiKey: 'test-only-wb-credential',
          contextWindow: 32000,
        },
      ],
      defaultModel: 'wb-fixture',
    }),
  );

  const app = await electron.launch({ args: [entry], env: environment(home, userData) });
  try {
    const page = await firstWindow(app);
    await expect(page.getByRole('textbox', { name: '发送消息' })).toBeEnabled();

    // 1. 注册并授信真实 Git 项目工作区
    await app.evaluate(({ dialog }, selection) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selection] });
    }, projectDir);
    await page.getByRole('button', { name: /会话空间：|选择空间/ }).click();
    await page.getByRole('menuitem', { name: '新建项目' }).click();
    const creation = page.getByRole('dialog', { name: '创建项目', exact: true });
    await creation.getByRole('textbox', { name: '项目名称', exact: true }).fill('工作台项目');
    await creation.getByRole('button', { name: '选择文件夹', exact: true }).click();
    await creation.getByRole('button', { name: '创建项目', exact: true }).click();
    await page
      .getByRole('dialog', { name: '信任此文件夹吗？', exact: true })
      .getByRole('button', { name: '信任文件夹并创建', exact: true })
      .click();
    await expect(page.getByRole('button', { name: '会话空间：工作台项目' })).toBeVisible();

    // 2. 触发文件修改并批准，生成真实 Shadow Git 检查点
    const composer = page.getByRole('textbox', { name: '发送消息' });
    await composer.fill('请升级 src/app.ts 版本号');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const approvalDeck = page.getByRole('region', { name: '待处理审批', exact: true });
    await expect(approvalDeck).toBeVisible({ timeout: 15_000 });
    await approvalDeck.getByRole('button', { name: '批准一次', exact: true }).click();
    await expect(page.getByText('已将版本号升级至 2。')).toBeVisible({ timeout: 15_000 });
    expect(fs.readFileSync(path.join(projectDir, 'src/app.ts'), 'utf8')).toBe(
      'export const version = 2;\n',
    );

    // 3. 点击页头 Diff 胶囊直达「变更」标签，核验 Unified/Split 对比并执行外科检查点还原
    const diffPill = page.getByRole('button', { name: /查看变更/ });
    await expect(diffPill).toBeVisible({ timeout: 10_000 });
    await diffPill.click();
    const workbench = page.getByRole('complementary', { name: '工作台面板', exact: true });
    await expect(workbench).toBeVisible();
    await expect(workbench.getByRole('tab', { name: '变更', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      workbench.getByRole('region', { name: '变更文件列表' }).getByText(/src[/\\]app\.ts/),
    ).toBeVisible({ timeout: 10_000 });
    await expect(workbench.getByText('export const version = 2;')).toBeVisible();
    await workbench
      .getByRole('radiogroup', { name: '差异视图模式', exact: true })
      .getByRole('radio', { name: '并排对比', exact: true })
      .click();
    await expect(workbench.locator('.kpbl-diff-split-row').first()).toBeVisible();
    await workbench
      .getByRole('radiogroup', { name: '变更对比范围', exact: true })
      .getByRole('radio', { name: '按轮次检查点', exact: true })
      .click();
    await workbench.getByRole('button', { name: '还原选中检查点', exact: true }).click();
    await expect(workbench.getByText(/已还原至轮次 #/)).toBeVisible({ timeout: 10_000 });
    expect(fs.readFileSync(path.join(projectDir, 'src/app.ts'), 'utf8')).toBe(
      'export const version = 1;\n',
    );

    // 4. 切换至「文件」标签：只读检视还原后的源码并一键插入 @文件 引用到输入框
    await workbench.getByRole('tab', { name: '文件', exact: true }).click();
    await workbench
      .getByRole('region', { name: '工作区文件列表' })
      .getByRole('button', { name: /src[/\\]app\.ts/ })
      .click();
    await expect(workbench.locator('.kpbl-code-viewer')).toContainText('export const version = 1;');
    await workbench.getByRole('button', { name: '插入 @文件 引用', exact: true }).click();
    await expect(composer).toHaveValue(/@src[\\/]app\.ts $/);

    // 5. 切换至「终端」标签：验证真实 node-pty 收发回显，且切去其它标签时保持 DOM hidden 保活
    await workbench.getByRole('tab', { name: '终端', exact: true }).click();
    const keepalivePane = workbench.locator('[data-keepalive="terminal"]');
    await expect(keepalivePane).toBeVisible();
    const ptyRoundtrip = await page.evaluate(async () => {
      const prefs = await window.kapibala.preferences.read();
      const recent = prefs.recent.find((s) => s.name === '工作台项目');
      if (!recent) return { ok: false, reason: 'missing-project' };
      const proj = await window.kapibala.workspace.openRecent(recent.id);
      const hist = await window.kapibala.session.list(proj.id);
      const convId = hist.items[0]?.conversationId;
      if (!convId) return { ok: false, reason: 'missing-conv' };
      const sessionKey = `native:${proj.id}:${convId}`;
      let echoed = false;
      const off = window.kapibala.onEvent((ev) => {
        if (
          ev.type === 'terminal.data' &&
          ev.sessionKey === sessionKey &&
          ev.data.includes('KPBL_WB_PTY_ALIVE')
        ) {
          echoed = true;
        }
      });
      try {
        const snap = await window.kapibala.terminal.ensure({
          workspaceId: proj.id,
          sessionKey,
        });
        const termId = snap.terminals[0]?.id;
        if (!termId) return { ok: false, unavailable: snap.unavailableReason };
        await window.kapibala.terminal.write({
          workspaceId: proj.id,
          sessionKey,
          terminalId: termId,
          data: 'echo KPBL_WB_PTY_ALIVE\r',
        });
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline && !echoed) {
          await new Promise((r) => setTimeout(r, 50));
        }
        return { ok: echoed, termId };
      } finally {
        off();
      }
    });
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(ptyRoundtrip.ok).toBe(true);
    }
    if (ptyRoundtrip.ok) {
      await expect(keepalivePane.locator('.xterm')).toBeVisible({ timeout: 10_000 });
      const viewportBg = await keepalivePane
        .locator('.xterm-viewport')
        .first()
        .evaluate((el) => window.getComputedStyle(el).backgroundColor);
      expect(viewportBg).not.toBe('rgb(0, 0, 0)');
      expect(viewportBg).not.toBe('rgba(0, 0, 0, 0)');
    }
    await workbench.getByRole('tab', { name: '详情与证据', exact: true }).click();
    await expect(keepalivePane).toHaveCount(1);
    await expect(keepalivePane).toHaveAttribute('hidden', '');
    await workbench.getByRole('tab', { name: '终端', exact: true }).click();
    await expect(keepalivePane).toBeVisible();

    // 6. 切换至「预览」标签：允许本机回环开发端口预览，阻断 RFC1918 私网地址内嵌
    await workbench.getByRole('tab', { name: '预览', exact: true }).click();
    const urlInput = workbench.getByRole('textbox', { name: '本地服务或网页地址', exact: true });
    await urlInput.fill(`http://127.0.0.1:${previewPort}`);
    await workbench.getByRole('button', { name: '前往', exact: true }).click();
    await expect(
      page.frameLocator('iframe[title="本地服务预览"]').getByText('KPBL_LOOPBACK_PREVIEW_OK'),
    ).toBeVisible({ timeout: 10_000 });
    await urlInput.fill('http://192.168.1.1:8080');
    await workbench.getByRole('button', { name: '前往', exact: true }).click();
    await expect(workbench.getByRole('alert')).toBeVisible();
  } finally {
    await stop(app);
    modelServer.closeAllConnections();
    loopbackPreviewServer.closeAllConnections();
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    await new Promise<void>((resolve) => loopbackPreviewServer.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('@ 跨会话引用挂载快照胶囊注入上下文，且流中瞬时断流自动重置重试不残留半截脏文本', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-e2e-ref-retry-'));
  const userData = path.join(home, 'desktop-state');
  const defaultRoot = path.join(home, '.kapibala/workspaces/default');
  fs.mkdirSync(defaultRoot, { recursive: true });

  // 预置一条同空间历史会话供 @「会话与消息」检索与引用
  const seed = await new SessionManager({
    workspaceRoot: defaultRoot,
    projectRootMode: 'exact',
    homeDirectory: home,
  }).create();
  await seed.store.append({
    role: 'user',
    content: [{ type: 'text', text: '架构基线讨论：检查点怎么隔离' }],
  });
  await seed.store.append({
    role: 'assistant',
    content: [{ type: 'text', text: '采用外部侧挂 Shadow Git 仓库隔离检查点。' }],
  });
  await seed.release();

  let attempt = 0;
  let capturedReferenceXml = false;
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk.toString('utf8');
    if (raw.includes('<session-reference')) {
      capturedReferenceXml = true;
    }
    attempt += 1;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (attempt === 1) {
      // 第 1 次尝试：先吐出半截脏文本，随后直接销毁底层 TCP 套接字模拟流中瞬时网络断流
      response.write(
        `data: ${JSON.stringify({
          id: 'mid-1',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: '半截脏前缀_不应残留_' }, finish_reason: null }],
        })}\n\n`,
      );
      setTimeout(() => {
        response.socket?.destroy();
      }, 40);
      return;
    }
    response.end(
      `data: ${JSON.stringify({
        id: 'mid-2',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: { content: '流中自动重置恢复完成，Shadow Git 引用已核验。' },
            finish_reason: null,
          },
        ],
      })}\n\ndata: ${JSON.stringify({
        id: 'mid-2',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\ndata: [DONE]\n\n`,
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  fs.writeFileSync(
    path.join(home, '.kapibala/settings.json'),
    JSON.stringify({
      profiles: [
        {
          id: 'ref-retry-fixture',
          name: '引用与重试验收模型',
          provider: 'openai-compatible',
          modelName: 'ref-retry-fixture',
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKeyEnv: 'KPBL_REF_RETRY_KEY',
          apiKey: 'test-only-ref-retry-credential',
          contextWindow: 32000,
        },
      ],
      defaultModel: 'ref-retry-fixture',
    }),
  );

  const app = await electron.launch({ args: [entry], env: environment(home, userData) });
  try {
    const page = await firstWindow(app);
    const composer = page.getByRole('textbox', { name: '发送消息' });
    await expect(composer).toBeEnabled();

    // 1. 输入 @ 切至「会话与消息」标签，选中预置历史会话挂载快照胶囊
    await composer.fill('@');
    const refPopover = page.getByRole('region', { name: '引用补全', exact: true });
    await expect(refPopover).toBeVisible();
    await refPopover.getByRole('button', { name: '会话与消息' }).click();
    await refPopover.getByRole('button', { name: /架构基线讨论：检查点怎么隔离/ }).click();
    await expect(
      page.locator('[aria-label="已挂载引用"]').getByText(/@架构基线讨论/),
    ).toBeVisible();

    // 2. 发送提问：触发 <session-reference> 注入 + 第 1 次流中断流 -> stream_reset -> 第 2 次完整回复
    await composer.fill('请结合引用回答核心机制');
    await page.getByRole('button', { name: '发送', exact: true }).click();

    const reply = page.getByRole('article', { name: 'Kapibala 回复' });
    await expect(reply.getByText('流中自动重置恢复完成，Shadow Git 引用已核验。')).toBeVisible({
      timeout: 20_000,
    });
    await expect(reply.getByText(/半截脏前缀_不应残留_/)).toHaveCount(0);
    expect(attempt).toBeGreaterThanOrEqual(2);
    expect(capturedReferenceXml).toBe(true);

    // 3. 用户消息气泡剥离原始 XML 包络并展示结构化 @溯源徽章，右侧四维证据看板计入 2 条跨会话消息记录引用
    const userTurn = page.getByRole('article', { name: '你的消息' });
    await expect(userTurn.getByText(/@架构基线讨论/).first()).toBeVisible();
    await expect(userTurn.getByText('<session-reference')).toHaveCount(0);

    await page.getByRole('button', { name: '展开或收起工作台', exact: true }).click();
    const evidenceBoard = page.getByRole('region', { name: '会话证据看板' });
    await expect(evidenceBoard).toBeVisible();
    await expect(evidenceBoard.getByText('2 条')).toBeVisible({ timeout: 10_000 });
  } finally {
    await stop(app);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
