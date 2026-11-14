/// <reference path="../src/renderer/global.d.ts" />
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('复制安装后的应用使用自身依赖、隔离历史和受限 GUI PATH，移除应用保留数据', async () => {
  const source = process.env.KPBL_PACKAGED_SOURCE;
  const candidate = process.env.KPBL_PACKAGED_KIND === 'candidate';
  const executableName = candidate ? 'Kapibala' : 'Kapibala Test';
  if (!source || !path.isAbsolute(source)) throw new Error('PACKAGED_SOURCE_REQUIRED');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-installed-'));
  const home = path.join(root, 'home');
  const userData = path.join(root, 'state');
  const installed = path.join(root, 'installed');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(installed);
  const target = path.join(installed, path.basename(source));
  fs.cpSync(source, target, { recursive: true, dereference: false, verbatimSymlinks: true });
  // macOS framework 的相对链接必须保持相对；复制测试不能悄悄回读原应用目录。
  const copiedRoot = fs.realpathSync.native(target);
  const directories = [target];
  for (let i = 0; i < directories.length; i++)
    for (const entry of fs.readdirSync(directories[i], { withFileTypes: true })) {
      const file = path.join(directories[i], entry.name);
      if (entry.isSymbolicLink())
        expect(fs.realpathSync.native(file).startsWith(copiedRoot + path.sep)).toBe(true);
      else if (entry.isDirectory()) directories.push(file);
    }
  const executable =
    process.platform === 'darwin'
      ? path.join(target, `Contents/MacOS/${executableName}`)
      : process.platform === 'win32'
        ? path.join(target, `${executableName}.exe`)
        : path.join(target, candidate ? 'kapibala' : 'kapibala-test');
  const server = http.createServer(async (request, response) => {
    let text = '';
    for await (const part of request) text += part;
    const input = JSON.parse(text);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta =
      input.messages.at(-1)?.role === 'tool'
        ? { content: '安装后链路通过。' }
        : {
            tool_calls: [
              {
                index: 0,
                id: 'installed-write',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({
                    path: 'installed-proof.txt',
                    content: 'packaged-tool-proof',
                  }),
                },
              },
            ],
          };
    response.end(
      `data: ${JSON.stringify({ id: 'installed', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'installed', choices: [{ index: 0, delta: {}, finish_reason: input.messages.at(-1)?.role === 'tool' ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  fs.mkdirSync(path.join(home, '.kapibala'));
  const settings = path.join(home, '.kapibala/settings.json');
  fs.writeFileSync(
    settings,
    JSON.stringify({
      profiles: [
        {
          id: 'fixture',
          name: '安装包验收模型',
          provider: 'openai-compatible',
          modelName: 'fixture',
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKeyEnv: 'FIXTURE_KEY',
          apiKey: 'test-only-installed-credential',
          contextWindow: 32000,
        },
      ],
      defaultModel: 'fixture',
    }),
  );
  const env: Record<string, string> = {
    PATH: process.platform === 'win32' ? `${process.env.SystemRoot}\\System32` : '/usr/bin:/bin',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    ...(candidate
      ? {}
      : { KPBL_DESKTOP_E2E: '1', KPBL_DESKTOP_HOME: home, KPBL_DESKTOP_USER_DATA: userData }),
  };
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'TMPDIR',
    'TEMP',
    'TMP',
    'DISPLAY',
    'XAUTHORITY',
    'LANG',
  ])
    if (process.env[key]) env[key] = process.env[key]!;
  const app = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${userData}`],
    cwd: root,
    env,
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const identity = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      application: app.getAppPath(),
      resources: process.resourcesPath,
      execPath: process.execPath,
      nodeOptions: process.env.NODE_OPTIONS,
      userData: app.getPath('userData'),
    }));
    expect(identity.packaged).toBe(true);
    expect(fs.realpathSync.native(identity.userData)).toBe(fs.realpathSync.native(userData));
    expect(
      fs.realpathSync
        .native(identity.application)
        .startsWith(fs.realpathSync.native(installed) + path.sep),
    ).toBe(true);
    expect(
      fs.realpathSync
        .native(identity.resources)
        .startsWith(fs.realpathSync.native(installed) + path.sep),
    ).toBe(true);
    expect(identity.nodeOptions).toBeUndefined();
    expect(
      await page.evaluate(() => window.kapibala.app.getInfo().then((info) => info.testBuild)),
    ).toBe(!candidate);
    // 默认空间默认信任：直接新建对话并发送，验证安装副本的完整链路。
    await page.getByRole('button', { name: '新建对话', exact: true }).last().click();
    await page.getByRole('textbox', { name: '发送消息' }).fill('验证安装包');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    // 新审批自动弹出居中队列，标题栏不再有常驻「审批 N」计数入口；批准一次后队列清空自动收起。
    const queue = page.getByRole('dialog', { name: '待处理审批', exact: true });
    await expect(queue).toBeVisible();
    await queue.getByRole('button', { name: '批准一次', exact: true }).click();
    await expect(queue).toBeHidden();
    await expect(page.getByText('安装后链路通过。', { exact: true })).toBeVisible();
    const proof = path.join(home, '.kapibala/workspaces/default/installed-proof.txt');
    expect(fs.readFileSync(proof, 'utf8')).toBe('packaged-tool-proof');
    expect(errors).toEqual([]);
    const closed = app.waitForEvent('close');
    await app.evaluate(({ app }) => app.quit());
    await closed;
    expect(fs.existsSync(path.join(userData, 'host-guard.json'))).toBe(false);
    fs.rmSync(installed, { recursive: true, force: true });
    expect(fs.existsSync(settings)).toBe(true);
    expect(fs.existsSync(proof)).toBe(true);
    expect(fs.existsSync(path.join(home, '.kapibala/sessions'))).toBe(true);
    const evidence = process.env.KPBL_PACKAGED_SMOKE_RESULT;
    if (evidence)
      fs.writeFileSync(
        evidence,
        JSON.stringify(
          {
            status: 'passed',
            platform: process.platform,
            arch: process.arch,
            isPackaged: identity.packaged,
            copiedInstall: true,
            restrictedPath: true,
            actualTool: true,
            dataRetainedAfterRemovingCopy: true,
            signingVerified: false,
            systemInstallerVerified: false,
          },
          null,
          2,
        ),
      );
  } finally {
    await app.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
