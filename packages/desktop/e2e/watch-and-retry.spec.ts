/// <reference path="../src/renderer/global.d.ts" />
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
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

test('回答级重试（重新生成回答）替换旧回复、更新 Token 消耗并在新重试分支继续对话', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-electron-retry-'));
  const userData = path.join(home, 'desktop-state');
  execFileSync('git', ['init', '--quiet', home]);

  let callCount = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* drain */
    }
    callCount++;
    const current = callCount;
    const content =
      current === 1
        ? '第一版回答（待重新生成）'
        : current === 2
          ? '第二版回答（重试生成成功）'
          : '新分支后续追问回答';
    const promptTokens = current === 1 ? 100 : current === 2 ? 120 : 160;
    const completionTokens = current === 1 ? 50 : current === 2 ? 80 : 40;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(
      `data: ${JSON.stringify({
        id: `retry-${current}`,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`,
    );
    response.end(
      `data: ${JSON.stringify({
        id: `retry-${current}`,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      })}\n\ndata: [DONE]\n\n`,
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  fs.mkdirSync(path.join(home, '.kapibala'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.kapibala/settings.json'),
    JSON.stringify({
      profiles: [
        {
          id: 'retry-fixture',
          name: '重试验收模型',
          provider: 'openai-compatible',
          modelName: 'retry-fixture',
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKeyEnv: 'KPBL_RETRY_FIXTURE_KEY',
          apiKey: 'test-only-local-credential',
          contextWindow: 32000,
        },
      ],
      defaultModel: 'retry-fixture',
    }),
  );

  const app = await electron.launch({ args: [entry], env: environment(home, userData) });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });

  try {
    const input = page.getByRole('textbox', { name: '发送消息' });
    await input.fill('请给出架构建议');
    await page.getByRole('button', { name: '发送', exact: true }).click();

    const reply = page.getByRole('article', { name: 'Kapibala 回复' });
    await expect(reply.getByText('第一版回答（待重新生成）')).toBeVisible({ timeout: 15_000 });
    await reply.hover();
    await expect(reply.getByText(/消耗 150 token/)).toBeVisible();

    // 点击「重新生成回答」：截断上一轮并切到新重试分支，旧回答消失，新回答与新 Token 计数落位
    await reply.getByRole('button', { name: '重新生成回答', exact: true }).click();
    await expect(page.getByText('第二版回答（重试生成成功）')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('第一版回答（待重新生成）')).toHaveCount(0);
    await reply.hover();
    await expect(reply.getByText(/消耗 200 token/)).toBeVisible();

    // 在新重试分支上继续发问：验证 ViewClient 与 PresentationStore 的 branchId 保持完全同步，增量流式事件不被丢弃
    await input.fill('继续展开细节');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByText('新分支后续追问回答')).toBeVisible({ timeout: 15_000 });

    const proofDir = path.resolve('test-results/visual-proof');
    fs.mkdirSync(proofDir, { recursive: true });
    await page.screenshot({
      path: path.join(proofDir, 'retry-regenerated-reply.png'),
      animations: 'disabled',
    });
  } finally {
    await stop(app);
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('会话级文件监视（watch_start）命中后自动落盘通知并触发桌面自动续跑', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-electron-watch-'));
  const userData = path.join(home, 'desktop-state');
  execFileSync('git', ['init', '--quiet', home]);
  const workspaceRoot = path.join(home, '.kapibala/workspaces/default');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const watchedFile = path.join(workspaceRoot, 'watched.txt');
  fs.writeFileSync(watchedFile, 'v1');

  let requestIndex = 0;
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk.toString('utf8');
    requestIndex++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });

    if (requestIndex === 1) {
      // 第 1 次模型请求：调用 watch_start 监视 watched.txt
      const args = JSON.stringify({
        kind: 'file_change',
        target: 'watched.txt',
        intervalMs: 2000,
        deadlineAt: Date.now() + 60_000,
      });
      response.write(
        `data: ${JSON.stringify({
          id: 'watch-1',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_watch_1',
                    type: 'function',
                    function: { name: 'watch_start', arguments: args },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.end(
        `data: ${JSON.stringify({
          id: 'watch-1',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }

    if (requestIndex === 2) {
      // 工具执行成功后的同轮收尾回答
      response.write(
        `data: ${JSON.stringify({
          id: 'watch-2',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: { content: '已登记文件监视，等待 watched.txt 变更。' },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.end(
        `data: ${JSON.stringify({
          id: 'watch-2',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }

    // 第 3 次模型请求：WatchService 自动续跑，断言上下文已包含 <watch-event 通知块
    const hasWatchPayload = raw.includes('<watch-event');
    const resumeReply = hasWatchPayload
      ? '检测到 watched.txt 外部更新，已完成自动续跑处理！'
      : '错误：未在上下文中看到 watch-event 通知';
    response.write(
      `data: ${JSON.stringify({
        id: 'watch-3',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: resumeReply }, finish_reason: null }],
      })}\n\n`,
    );
    response.end(
      `data: ${JSON.stringify({
        id: 'watch-3',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\ndata: [DONE]\n\n`,
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  fs.mkdirSync(path.join(home, '.kapibala'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.kapibala/settings.json'),
    JSON.stringify({
      profiles: [
        {
          id: 'watch-fixture',
          name: '监视验收模型',
          provider: 'openai-compatible',
          modelName: 'watch-fixture',
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKeyEnv: 'KPBL_WATCH_FIXTURE_KEY',
          apiKey: 'test-only-local-credential',
          contextWindow: 32000,
        },
      ],
      defaultModel: 'watch-fixture',
    }),
  );

  const app = await electron.launch({ args: [entry], env: environment(home, userData) });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });

  try {
    const input = page.getByRole('textbox', { name: '发送消息' });
    await input.fill('请监视 watched.txt 文件变化');
    await page.getByRole('button', { name: '发送', exact: true }).click();

    // Approval 模式下 watch_start 自动弹出审批队列，点击「批准一次」放行
    const allowBtn = page.getByRole('button', { name: '批准一次', exact: true });
    await expect(allowBtn).toBeVisible({ timeout: 15_000 });
    await allowBtn.click();

    await expect(page.getByText('已登记文件监视，等待 watched.txt 变更。')).toBeVisible({
      timeout: 15_000,
    });
    await expect(input).toBeEnabled();

    // 会话内 /watches 命令验证活动监视条目可见
    await input.fill('/watches');
    await input.press('Enter');
    await expect(page.getByText(/watched\.txt · 监视中/)).toBeVisible();

    const proofDir = path.resolve('test-results/visual-proof');
    fs.mkdirSync(proofDir, { recursive: true });
    await page.screenshot({
      path: path.join(proofDir, 'watch-armed-feedback.png'),
      animations: 'disabled',
    });

    // 外部修改被监视文件：触发 2s 轮询 + 300ms 去抖 → WatchInbox 投递 → AgentSession 同步 → DesktopHost 自动续跑
    fs.writeFileSync(watchedFile, 'v2-external-change');
    await expect(page.getByText('检测到 watched.txt 外部更新，已完成自动续跑处理！')).toBeVisible({
      timeout: 20_000,
    });

    await page.screenshot({
      path: path.join(proofDir, 'watch-auto-resumed.png'),
      animations: 'disabled',
    });
  } finally {
    await stop(app);
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
