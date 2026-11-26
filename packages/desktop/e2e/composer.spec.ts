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

async function firstWindow(app: ElectronApplication) {
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return page;
}

test.describe
  .serial('composer 输入增强', () => {
    let home: string;
    let userData: string;
    let server: http.Server;
    let app: ElectronApplication;
    let page: ReturnType<typeof firstWindow> extends Promise<infer T> ? T : never;

    test.beforeEach(async () => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-electron-composer-'));
      userData = path.join(home, 'desktop-state');
      execFileSync('git', ['init', '--quiet', home]);
      // 本地零重试快速失败端点：HTTP 401 属于不可重试错误（避免 5xx 触发指数退避重试，也避免关闭端口的 Windows SYN 超时）。
      server = http.createServer(async (req, res) => {
        for await (const _chunk of req) {
          /* drain */
        }
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: 'offline fixture',
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as { port: number };
      // 文件清单在应用挂载时缓存：补全候选文件必须先于启动创建
      const workspaceRoot = path.join(home, '.kapibala/workspaces/default');
      fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, 'src/demo.ts'), 'demo');
      fs.writeFileSync(path.join(workspaceRoot, 'README.md'), 'demo readme');
      fs.writeFileSync(
        path.join(home, '.kapibala/settings.json'),
        JSON.stringify({
          profiles: [
            {
              id: 'offline-fixture',
              name: '离线验收模型',
              provider: 'openai-compatible',
              modelName: 'offline',
              baseURL: `http://127.0.0.1:${port}/v1`,
              apiKeyEnv: 'KPBL_COMPOSER_FIXTURE_KEY',
              apiKey: 'test-only-local-credential',
              contextWindow: 32000,
            },
          ],
          defaultModel: 'offline-fixture',
        }),
      );
      // 全局技能目录（~/.kapibala/skills）：会话打开时由运行时 registry 扫描装载
      const skillDir = path.join(home, '.kapibala/skills/demo-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: demo-skill\ndescription: 演示技能：用于 e2e 验证补全面板的技能分组。\n---\n演示正文。',
      );
      app = await electron.launch({ args: [entry], env: environment(home, userData) });
      page = await firstWindow(app);
      await expect(page.getByLabel('发送消息')).toBeVisible();
      await expect(page.getByLabel('发送消息')).toBeEnabled({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: '新建对话', exact: true }).first()).toBeEnabled(
        {
          timeout: 15_000,
        },
      );
    });

    test.afterEach(async () => {
      await stop(app);
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    });

    test('@ 触发沙箱内文件补全且确认后以轻量语义进入草稿', async () => {
      await page.getByLabel('发送消息').fill('@de');
      await expect(page.getByRole('button', { name: /src[/\\]demo\.ts/ })).toBeVisible();
      // Tab 确认：草稿变为 @src/demo.ts（带尾随空格），模型未收到任何请求
      await page.getByLabel('发送消息').press('Tab');
      // 文件清单来自宿主的原生相对路径：Windows 是反斜杠，断言不能写死 POSIX 分隔符。
      await expect(page.getByLabel('发送消息')).toHaveValue(/@src[\\/]demo\.ts $/);
    });

    test('切换到非默认项目空间的新建对话首页时，@ 搜索命中当前项目文件且支持鼠标点选非首项', async () => {
      const projectDir = path.join(home, 'aigc-fixture');
      fs.mkdirSync(path.join(projectDir, 'sub'), { recursive: true });
      execFileSync('git', ['init', '--quiet', projectDir]);
      fs.writeFileSync(path.join(projectDir, 'update-all.ps1'), 'echo 1');
      fs.writeFileSync(path.join(projectDir, 'sub/update.sh'), 'echo 2');

      await app.evaluate(({ dialog }, selection) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selection] });
      }, projectDir);
      await page.getByRole('button', { name: /会话空间：|选择空间/ }).click();
      await page.getByRole('menuitem', { name: '新建项目' }).click();
      const creation = page.getByRole('dialog', { name: '创建项目', exact: true });
      await creation.getByRole('textbox', { name: '项目名称', exact: true }).fill('aigc');
      await creation.getByRole('button', { name: '选择文件夹', exact: true }).click();
      await creation.getByRole('button', { name: '创建项目', exact: true }).click();
      await page
        .getByRole('dialog', { name: '信任此文件夹吗？', exact: true })
        .getByRole('button', { name: '信任文件夹并创建', exact: true })
        .click();
      await expect(page.getByRole('button', { name: '会话空间：aigc' })).toBeVisible();

      // 回归守卫 1：非默认项目 aigc 的「新建对话」首页（opened === undefined）输入 @update 必须命中 aigc 内的文件。
      await page.getByLabel('发送消息').fill('@update');
      await expect(page.getByRole('button', { name: 'update-all.ps1', exact: true })).toBeVisible({
        timeout: 5_000,
      });
      const secondOption = page.getByRole('button', { name: /sub[/\\]update\.sh/ });
      await expect(secondOption).toBeVisible();

      // 回归守卫 2：鼠标直接按下第 2 项，必须插入被点击项而非停留在 index=0 的首项。
      await secondOption.dispatchEvent('mousedown');
      await expect(page.getByLabel('发送消息')).toHaveValue(/@sub[\\/]update\.sh $/);

      // 回归守卫 3：侧栏左下角不再展示常驻版本号。
      await expect(page.locator('.kapibala-sidebar-version')).toHaveCount(0);

      // 回归守卫 4：Windows 主进程生成有效的多分辨率 kapibala-brand-*.ico 供任务栏 setAppDetails 使用。
      if (process.platform === 'win32') {
        const icoFiles = fs
          .readdirSync(userData)
          .filter((name) => /^kapibala-brand-[a-f0-9]+\.ico$/.test(name));
        expect(icoFiles).toHaveLength(1);
        const icoPath = path.join(userData, icoFiles[0]!);
        const validIco = await app.evaluate(
          ({ nativeImage }, file) => !nativeImage.createFromPath(file).isEmpty(),
          icoPath,
        );
        expect(validIco).toBe(true);
      }
    });

    test('/ 输入被命令系统拦截，不作为普通消息发给模型', async () => {
      // 无会话场景：斜杠命令被守卫拦截并明示原因；草稿不进入模型发送通道
      await page.getByLabel('发送消息').fill('/nosuchcmd');
      await page.getByLabel('发送消息').press('Enter');
      await expect(page.getByText(/斜杠命令需要在已打开的会话中使用/).first()).toBeVisible();
      // @ 引用同样轻量：确认后的草稿与文本消息路径一致
      await page.getByLabel('发送消息').fill('看看 @README.md');
      // 补全面板由 effect 异步挂载：先等候选出现再按 Tab，否则按键可能落在面板之前。
      await expect(page.getByRole('button', { name: 'README.md', exact: true })).toBeVisible();
      await page.getByLabel('发送消息').press('Tab');
      await expect(page.getByLabel('发送消息')).toHaveValue(/@README\.md /);
    });

    test('home 态技能预览与无匹配提示', async () => {
      // 未打开会话：技能组来自配置层快照预览（新会话将可用），`/` 搜索照常工作。
      // 前缀避开 /delegate、/delegations：命令组排在技能组之前，/de 会先命中命令。
      await page.getByLabel('发送消息').fill('/demo');
      const skillItem = page.getByRole('button', { name: /\/skill demo-skill/ });
      await expect(skillItem).toBeVisible();
      await page.getByLabel('发送消息').press('Tab');
      await expect(page.getByLabel('发送消息')).toHaveValue('/skill demo-skill ');
      // 零匹配也要有面板：无匹配提示而不是凭空消失
      await page.getByLabel('发送消息').fill('/zzz');
      await expect(page.getByText('无匹配的命令或技能')).toBeVisible();
    });

    test('技能分组：/ 面板列出可调用技能，/skill 名字段可补全', async () => {
      // 默认空间默认信任：发送即创建会话（默认模型无密钥，首轮运行会失败，
      // 但会话已打开，技能目录数据源随之可用）。
      await page.getByLabel('发送消息').fill('hi');
      await page.getByLabel('发送消息').press('Enter');
      await expect(page.getByRole('article', { name: '你的消息' }).first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByLabel('发送消息')).toBeEnabled({ timeout: 15_000 });
      // `/` 分组面板：技能组出现 demo-skill（可访问名含描述文本，用正则匹配），
      // Tab 接受后草稿进入 /skill 名字段
      await page.getByLabel('发送消息').fill('/demo');
      const skillItem = page.getByRole('button', { name: /\/skill demo-skill/ });
      await expect(skillItem).toBeVisible();
      await page.getByLabel('发送消息').press('Tab');
      await expect(page.getByLabel('发送消息')).toHaveValue('/skill demo-skill ');
      // `/skill <前缀>` 子形态（CLI 同款）：名字段补全，出现任务段后不再弹出
      await page.getByLabel('发送消息').fill('/skill de');
      await expect(skillItem).toBeVisible();
      await page.getByLabel('发送消息').press('Enter');
      await expect(page.getByLabel('发送消息')).toHaveValue('/skill demo-skill ');
    });

    test('技能无任务直发：新对话与已打开会话均发送即执行', async () => {
      // 1. 新对话草稿态直接发送 /skill demo-skill：自动创建会话并执行，不再报「需在已打开会话中使用」
      await page.getByLabel('发送消息').fill('/skill demo-skill');
      await page.getByLabel('发送消息').press('Enter');
      await expect(page.getByText(/斜杠命令需要在已打开的会话中使用/)).toHaveCount(0);
      await expect(page.getByText(/请输入合法技能名和非空任务/)).toHaveCount(0);
      await expect(page.getByLabel('发送消息')).toHaveValue('', { timeout: 10_000 });
      await expect(page.getByLabel('发送消息')).toBeEnabled({ timeout: 15_000 });

      // 2. 已打开会话内再次无任务直发 /skill demo-skill 同样走通收据管线
      await page.getByLabel('发送消息').fill('/skill demo-skill');
      await page.getByLabel('发送消息').press('Enter');
      await expect(page.getByText(/请输入合法技能名和非空任务/)).toHaveCount(0);
      await expect(page.getByLabel('发送消息')).toHaveValue('', { timeout: 10_000 });
    });

    test('↑/↓ 召回本会话已发送问句并保留未提交草稿', async () => {
      const input = page.getByLabel('发送消息');
      await input.fill('第一个问题');
      await input.press('Enter');
      await expect(page.getByRole('article', { name: '你的消息' }).first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(input).toBeEnabled({ timeout: 15_000 });
      await input.fill('第二个问题');
      await input.press('Enter');
      await expect(page.getByRole('article', { name: '你的消息' })).toHaveCount(2, {
        timeout: 15_000,
      });
      await expect(input).toBeEnabled({ timeout: 15_000 });
      // 空输入框光标在开头：↑ 依次召回最近与更早的问句，到顶后停住。
      await input.press('ArrowUp');
      await expect(input).toHaveValue('第二个问题');
      await input.press('ArrowUp');
      await expect(input).toHaveValue('第一个问题');
      // 到顶后上翻被吞掉但仍停在最早项，光标不会跳回开头。
      await input.press('ArrowUp');
      await expect(input).toHaveValue('第一个问题');
      // 下翻回到最新项，再下翻恢复未提交草稿（此处为空）并停住。
      await input.press('ArrowDown');
      await expect(input).toHaveValue('第二个问题');
      await input.press('ArrowDown');
      await expect(input).toHaveValue('');
      await input.press('ArrowDown');
      await expect(input).toHaveValue('');
      // 未提交草稿在首次上翻时保存，回到最新项必须原样恢复。
      // 光标需在草稿开头才接管 ↑，避免抢占多行编辑的正常行移动。
      await input.fill('还没发的草稿');
      await input.press('Home');
      await input.press('ArrowUp');
      await expect(input).toHaveValue('第二个问题');
      await input.press('ArrowDown');
      await expect(input).toHaveValue('还没发的草稿');

      // 上翻召回历史后一旦手动编辑，必须退出历史浏览态，后续按 ↓ 不得抹掉用户刚修改的文本。
      await input.press('Home');
      await input.press('ArrowUp');
      await expect(input).toHaveValue('第二个问题');
      await input.fill('第二个问题（已手动修改）');
      await input.press('ArrowDown');
      await expect(input).toHaveValue('第二个问题（已手动修改）');

      // 会话内执行 /watches 斜杠命令并采集补全面板与命令反馈卡真图。
      const proofDir = path.resolve('test-results/visual-proof');
      fs.mkdirSync(proofDir, { recursive: true });
      await input.fill('/');
      await expect(page.getByText('命令（')).toBeVisible();
      await page.screenshot({
        path: path.join(proofDir, 'composer-skill-completion.png'),
        animations: 'disabled',
      });

      await input.fill('/watches');
      await input.press('Enter');
      await expect(page.getByText('当前会话没有登记任何监视。')).toBeVisible();
      await page.screenshot({
        path: path.join(proofDir, 'composer-command-feedback.png'),
        animations: 'disabled',
      });
    });
  });
