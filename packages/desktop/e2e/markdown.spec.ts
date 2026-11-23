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

test('Streamdown 正文排版、全语言高亮、折行开关、Mermaid、KaTeX 守卫与思考块紧凑渲染', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-electron-md-'));
  const userData = path.join(home, 'desktop-state');
  execFileSync('git', ['init', '--quiet', home]);

  const replyBody = [
    '# 架构概览',
    '## 核心要点',
    '- 第一项包含 `inline_token` 胶囊',
    '- 第二项区间 ~10ms 到 ~20ms 且含 ~~旧方案~~',
    '',
    '1. 步骤一',
    '2. 步骤二',
    '',
    '> 引用说明段落',
    '',
    '公式验证：$E = mc^2$，括号公式 \\( a + b = c \\)，以及块级公式：',
    '\\[x^2 + y^2 = z^2\\]',
    '',
    '跨行价格与环境变量守卫：从 $5',
    '涨到 $10，复杂度 \\(O(n)\\)；请配置 $OPENAI_API_KEY、$ANTHROPIC_API_KEY 环境变量。',
    '',
    '非公式守卫：报价 $5 元，含税 $6 元；区间 $5-$10。',
    '',
    '```rust',
    'fn main() {',
    '    let greeting = "hello kapibala";',
    '    println!("{greeting}");',
    '}',
    '```',
    '',
    '```mermaid',
    'graph LR',
    '  A["输入"] --> B["Streamdown"]',
    '  click A "#details"',
    '```',
    '',
    '| 指标 | 结果 |',
    '| --- | --- |',
    '| 延迟 | 12ms |',
    '| 方程 | \\[E = mc^2\\] |',
  ].join('\n');

  const thinkingBody = '思考步骤：\n- 检查 **Streamdown** 管线\n- 校验 `katex` 守卫';

  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // 消费请求体即可，本用例固定返回富格式验收负载。
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(
      `data: ${JSON.stringify({
        id: 'md-fixture',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { reasoning_content: thinkingBody }, finish_reason: null }],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        id: 'md-fixture',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: replyBody }, finish_reason: null }],
      })}\n\n`,
    );
    response.end(
      `data: ${JSON.stringify({
        id: 'md-fixture',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\ndata: [DONE]\n\n`,
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  fs.mkdirSync(path.join(home, '.kapibala'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.kapibala/settings.json'),
    JSON.stringify({
      profiles: [
        {
          id: 'md-fixture',
          name: 'Markdown 验收模型',
          provider: 'openai-compatible',
          modelName: 'md-fixture',
          baseURL: `http://127.0.0.1:${address.port}/v1`,
          apiKeyEnv: 'KPBL_MD_FIXTURE_KEY',
          apiKey: 'test-only-local-credential',
          contextWindow: 32000,
        },
      ],
      defaultModel: 'md-fixture',
    }),
  );

  const app = await electron.launch({ args: [entry], env: environment(home, userData) });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await page.getByRole('textbox', { name: '发送消息' }).fill('触发富文本验收');
    await page.getByRole('button', { name: '发送', exact: true }).click();

    const reply = page.getByRole('article', { name: 'Kapibala 回复' });
    await expect(reply.getByRole('heading', { name: '架构概览', level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    await expect(reply.getByRole('heading', { name: '核心要点', level: 2 })).toBeVisible();

    // 验证 Tailwind preflight 下列表的圆点/十进制编号与标题字阶均已恢复。
    const typography = await reply.evaluate((element) => {
      const h1 = element.querySelector('.kapibala-prose h1')!;
      const p = element.querySelector('.kapibala-prose p')!;
      const ul = element.querySelector('.kapibala-prose ul')!;
      const ol = element.querySelector('.kapibala-prose ol')!;
      const inlineCode = element.querySelector('[data-streamdown="inline-code"]')!;
      return {
        h1Size: Number.parseFloat(getComputedStyle(h1).fontSize),
        pSize: Number.parseFloat(getComputedStyle(p).fontSize),
        h1Weight: Number.parseInt(getComputedStyle(h1).fontWeight, 10),
        ulStyle: getComputedStyle(ul).listStyleType,
        olStyle: getComputedStyle(ol).listStyleType,
        inlineCodeBg: getComputedStyle(inlineCode).backgroundColor,
      };
    });
    expect(typography.h1Size).toBeGreaterThan(typography.pSize);
    expect(typography.h1Weight).toBeGreaterThanOrEqual(600);
    expect(typography.ulStyle).toBe('disc');
    expect(typography.olStyle).toBe('decimal');
    expect(typography.inlineCodeBg).not.toBe('rgba(0, 0, 0, 0)');

    // 单波浪线区间不被误加删除线，双波浪线正常保留 <del>。
    await expect(reply.locator('del')).toHaveText('旧方案');
    await expect(reply.getByText(/~10ms 到 ~20ms/)).toBeVisible();

    // KaTeX 渲染 5 处真实公式（$...$、带空格 \(...\)、块级 \[...\]、跨行价格后的 \(O(n)\)、表格内 \[...\]），
    // 环境变量下划线与中文货币保持纯文本，不产生 KaTeX 报错。
    await expect(reply.locator('.katex')).toHaveCount(5);
    await expect(reply.locator('.katex-error')).toHaveCount(0);
    await expect(
      reply.getByText('非公式守卫：报价 $5 元，含税 $6 元；区间 $5-$10。'),
    ).toBeVisible();
    await expect(
      reply.getByText(/请配置 \$OPENAI_API_KEY、\$ANTHROPIC_API_KEY 环境变量/),
    ).toBeVisible();

    // Rust 代码块（原 Kumo 18 语言之外）完成高亮且折行开关与复制按钮工作正常。
    const codeShell = reply.locator('.kapibala-code-shell');
    await expect(codeShell).toBeVisible();
    const wrapBtn = codeShell.getByRole('button', { name: '自动换行', exact: true });
    await wrapBtn.click();
    await expect(codeShell).toHaveAttribute('data-code-wrap', 'true');
    await expect(
      codeShell.getByRole('button', { name: '取消自动换行', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await codeShell.getByRole('button', { name: '复制代码', exact: true }).click();
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain('let greeting = "hello kapibala";');

    // Mermaid 代码块基于 IntersectionObserver 懒渲染出 SVG 流程图：先滚入视口，避免小屏 CI（macOS）落在折叠线外；
    // 点击带 `click A "#details"` 的节点后主进程不得误断控制通道。
    const mermaidBlock = reply.locator('[data-streamdown="mermaid-block"]');
    await mermaidBlock.scrollIntoViewIfNeeded();
    const mermaidImg = mermaidBlock.getByRole('img', { name: 'Mermaid 图表' });
    await expect(mermaidImg.locator('svg')).toBeVisible({
      timeout: 15_000,
    });
    const clickableNode = mermaidImg.locator('svg a').first();
    await expect(clickableNode).toBeVisible();
    await clickableNode.click();
    const infoAfterClick = await page.evaluate(() => window.kapibala.app.getInfo());
    expect(infoAfterClick.name).toBe('Kapibala');

    await expect(reply.getByRole('button', { name: '复制表格', exact: true })).toBeVisible();

    // 展开思考过程：使用 compact 排版渲染加粗与列表，不裸露原始 ** 星号。
    await reply.getByRole('button', { name: '思考过程', exact: true }).click();
    const compactProse = reply.locator('.kapibala-prose-compact');
    await expect(compactProse).toBeVisible();
    await expect(compactProse.locator('strong')).toHaveText('Streamdown');
    await expect(compactProse.locator('ul > li')).toHaveCount(2);

    const proofDir = path.resolve('test-results/visual-proof');
    fs.mkdirSync(proofDir, { recursive: true });
    await page.screenshot({
      path: path.join(proofDir, 'markdown-light.png'),
      animations: 'disabled',
    });
    await page.evaluate(() => window.kapibala.preferences.update('dark'));
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
    await page.screenshot({
      path: path.join(proofDir, 'markdown-dark.png'),
      animations: 'disabled',
    });
    await page.evaluate(() => window.kapibala.preferences.update('light'));

    expect(pageErrors).toEqual([]);
  } finally {
    await stop(app);
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
