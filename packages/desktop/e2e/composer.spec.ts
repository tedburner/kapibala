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

async function firstWindow(app: ElectronApplication) {
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return page;
}

test.describe
  .serial('composer 输入增强', () => {
    let home: string;
    let userData: string;
    let app: ElectronApplication;
    let page: ReturnType<typeof firstWindow> extends Promise<infer T> ? T : never;

    test.beforeEach(async () => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-electron-composer-'));
      userData = path.join(home, 'desktop-state');
      execFileSync('git', ['init', '--quiet', home]);
      // 文件清单在应用挂载时缓存：补全候选文件必须先于启动创建
      const workspaceRoot = path.join(home, '.kapibala/workspaces/default');
      fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, 'src/demo.ts'), 'demo');
      fs.writeFileSync(path.join(workspaceRoot, 'README.md'), 'demo readme');
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
    });

    test.afterEach(async () => {
      await stop(app);
      fs.rmSync(home, { recursive: true, force: true });
    });

    test('@ 触发沙箱内文件补全且确认后以轻量语义进入草稿', async () => {
      await page.getByLabel('发送消息').fill('@de');
      await expect(page.getByRole('button', { name: /src[/\\]demo\.ts/ })).toBeVisible();
      // Tab 确认：草稿变为 @src/demo.ts（带尾随空格），模型未收到任何请求
      await page.getByLabel('发送消息').press('Tab');
      await expect(page.getByLabel('发送消息')).toHaveValue('@src/demo.ts ');
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
      // 未打开会话：技能组来自配置层快照预览（新会话将可用），`/` 搜索照常工作
      await page.getByLabel('发送消息').fill('/de');
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
      await expect(page.getByRole('article', { name: '你的消息' }).first()).toBeVisible();
      await expect(page.getByLabel('发送消息')).toBeEnabled();
      // `/` 分组面板：技能组出现 demo-skill（可访问名含描述文本，用正则匹配），
      // Tab 接受后草稿进入 /skill 名字段
      await page.getByLabel('发送消息').fill('/de');
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

    test('技能无任务直发：发送即执行', async () => {
      await page.getByLabel('发送消息').fill('hi');
      await page.getByLabel('发送消息').press('Enter');
      await expect(page.getByRole('article', { name: '你的消息' }).first()).toBeVisible();
      await expect(page.getByLabel('发送消息')).toBeEnabled();
      // `/skill <名称>` 无任务 = 选了就跑：宿主合成启动任务走收据管线（沙箱无模型，
      // 运行会快速失败——收据链路由单测覆盖）；此处断言分发走通了拦截而不是
      // 命中 CLI 的「非空任务」校验（校验报错会在反馈卡可见）。
      await page.getByLabel('发送消息').fill('/skill demo-skill');
      await page.getByLabel('发送消息').press('Enter');
      await expect(page.getByText(/请输入合法技能名和非空任务/)).toHaveCount(0);
      await expect(page.getByLabel('发送消息')).toHaveValue('', { timeout: 10_000 });
    });
  });
