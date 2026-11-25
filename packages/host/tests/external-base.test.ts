import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { buildExternalLaunchEnv } from '../src/host/external/env.js';
import { NdjsonChannel } from '../src/host/external/ndjson-channel.js';
import { ExternalProcessSupervisor, resolveExternalCommand } from '../src/host/external/process.js';
import { ExternalHarnessError } from '../src/host/external/types.js';

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('buildExternalLaunchEnv', () => {
  it('仅继承平台与代理白名单变量，剥离 NODE_OPTIONS、ELECTRON_RUN_AS_NODE 与未声明密钥', () => {
    const result = buildExternalLaunchEnv({
      hostEnv: {
        PATH: '/usr/local/bin:/usr/bin',
        HOME: '/Users/demo',
        HTTPS_PROXY: 'http://127.0.0.1:7890',
        NODE_OPTIONS: '--require=/malicious/hook.cjs',
        ELECTRON_RUN_AS_NODE: '1',
        OPENAI_API_KEY: 'sk-test-should-not-leak',
        DEEPSEEK_API_KEY: 'sk-test-forward-me',
      },
      env: {
        CLAUDE_AGENT_ACP_EXPERIMENTAL_V2: '0',
      },
      envFrom: ['DEEPSEEK_API_KEY', 'MISSING_OPTIONAL_KEY'],
      platform: 'darwin',
    });

    expect(result.env.PATH).toBe('/usr/local/bin:/usr/bin');
    expect(result.env.HOME).toBe('/Users/demo');
    expect(result.env.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(result.env.CLAUDE_AGENT_ACP_EXPERIMENTAL_V2).toBe('0');
    expect(result.env.DEEPSEEK_API_KEY).toBe('sk-test-forward-me');
    expect(result.env.NODE_OPTIONS).toBeUndefined();
    expect(result.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(result.env.OPENAI_API_KEY).toBeUndefined();
    expect(result.forwardedVars).toEqual(['DEEPSEEK_API_KEY']);
    expect(result.missingEnvFromVars).toEqual(['MISSING_OPTIONAL_KEY']);
  });

  it('Windows 下按不区分大小写匹配白名单与 envFrom 变量名，并把补充目录拼入 PATH', () => {
    const result = buildExternalLaunchEnv({
      hostEnv: {
        Path: 'C:\\Windows\\System32',
        SystemRoot: 'C:\\Windows',
        UserProfile: 'C:\\Users\\Demo',
        anthropic_api_key: 'sk-test-ant-key',
      },
      envFrom: ['ANTHROPIC_API_KEY'],
      extraPathDirs: ['C:\\Users\\Demo\\.local\\bin'],
      platform: 'win32',
    });

    expect(result.env.SystemRoot).toBe('C:\\Windows');
    expect(result.env.ANTHROPIC_API_KEY).toBe('sk-test-ant-key');
    expect(result.env.PATH).toContain('C:\\Windows\\System32');
    expect(result.env.PATH).toContain('C:\\Users\\Demo\\.local\\bin');
  });
});

describe('resolveExternalCommand', () => {
  const windowsIt = it.runIf(process.platform === 'win32');
  it('拒绝包含路径分隔符的相对路径与 Windows 保留设备名，防执行工作区脚本', () => {
    const root = makeTempDir('kpbl-ext-cmd-rel-');
    expect(() =>
      resolveExternalCommand({
        command: './evil-agent.exe',
        args: ['acp'],
        platform: 'win32',
        envPath: '',
        homeDir: root,
      }),
    ).toThrowError(ExternalHarnessError);

    try {
      resolveExternalCommand({
        command: '..\\evil.cmd',
        args: [],
        platform: 'win32',
        envPath: '',
        homeDir: root,
      });
      expect.unreachable('should reject relative path');
    } catch (error) {
      expect((error as ExternalHarnessError).code).toBe('EXTERNAL_INVALID_COMMAND');
    }

    try {
      resolveExternalCommand({
        command: 'CON.exe',
        args: [],
        platform: 'win32',
        envPath: '',
        homeDir: root,
      });
      expect.unreachable('should reject reserved device name');
    } catch (error) {
      expect((error as ExternalHarnessError).code).toBe('EXTERNAL_INVALID_COMMAND');
    }
  });

  windowsIt('Windows 同目录下优先命中原生 .exe，忽略同名 .cmd 垫片', () => {
    const binDir = makeTempDir('kpbl-ext-exe-prio-');
    const exePath = path.join(binDir, 'codex.exe');
    const cmdPath = path.join(binDir, 'codex.cmd');
    fs.writeFileSync(exePath, 'MZ-fake');
    fs.writeFileSync(cmdPath, '@ECHO off\r\necho should not use cmd\r\n');

    const resolved = resolveExternalCommand({
      command: 'codex',
      args: ['app-server'],
      platform: 'win32',
      envPath: binDir,
      homeDir: binDir,
    });

    expect(resolved.executable).toBe(fs.realpathSync.native(exePath));
    expect(resolved.args).toEqual(['app-server']);
    expect(resolved.unwrapKind).toBe('direct');
  });

  windowsIt(
    'Windows 解包形态 1：将指向 node_modules 内二进制 .exe 的 .cmd 垫片静态解包为直启 .exe',
    () => {
      const npmDir = makeTempDir('kpbl-ext-cmd-exe-');
      const targetExe = path.join(npmDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
      fs.mkdirSync(path.dirname(targetExe), { recursive: true });
      fs.writeFileSync(targetExe, 'MZ-opencode');
      const shimPath = path.join(npmDir, 'opencode.cmd');
      fs.writeFileSync(
        shimPath,
        [
          '@ECHO off',
          'SET dp0=%~dp0',
          'SET "_prog=node"',
          'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
        ].join('\r\n'),
      );

      const resolved = resolveExternalCommand({
        command: 'opencode',
        args: ['acp'],
        platform: 'win32',
        envPath: npmDir,
        homeDir: npmDir,
      });

      expect(resolved.executable).toBe(fs.realpathSync.native(targetExe));
      expect(resolved.args).toEqual(['acp']);
      expect(resolved.unwrapKind).toBe('cmd-exe');
    },
  );

  windowsIt(
    'Windows 解包形态 2 与 3：将指向 .js 与无后缀 node shebang 脚本的 .cmd 解包为 node 直启',
    () => {
      const npmDir = makeTempDir('kpbl-ext-cmd-js-');
      const fakeNode = path.join(npmDir, 'node.exe');
      fs.writeFileSync(fakeNode, 'MZ-node');

      const dshJs = path.join(npmDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      fs.mkdirSync(path.dirname(dshJs), { recursive: true });
      fs.writeFileSync(dshJs, 'console.log("dsh");\n');
      fs.writeFileSync(
        path.join(npmDir, 'dsh.cmd'),
        '@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n',
      );

      const resolvedJs = resolveExternalCommand({
        command: 'dsh',
        args: ['--profile', 'acp'],
        platform: 'win32',
        envPath: npmDir,
        homeDir: npmDir,
      });
      expect(resolvedJs.executable).toBe(fs.realpathSync.native(fakeNode));
      expect(resolvedJs.args).toEqual([fs.realpathSync.native(dshJs), '--profile', 'acp']);
      expect(resolvedJs.unwrapKind).toBe('cmd-node-script');

      const shebangScript = path.join(npmDir, 'node_modules', 'demo-cli', 'bin', 'demo');
      fs.mkdirSync(path.dirname(shebangScript), { recursive: true });
      fs.writeFileSync(shebangScript, '#!/usr/bin/env node\nconsole.log("ok");\n');
      fs.writeFileSync(
        path.join(npmDir, 'demo.cmd'),
        '@ECHO off\r\n"%~dp0\\node_modules\\demo-cli\\bin\\demo" %*\r\n',
      );

      const resolvedShebang = resolveExternalCommand({
        command: 'demo',
        args: ['--acp'],
        platform: 'win32',
        envPath: npmDir,
        homeDir: npmDir,
      });
      expect(resolvedShebang.executable).toBe(fs.realpathSync.native(fakeNode));
      expect(resolvedShebang.args).toEqual([fs.realpathSync.native(shebangScript), '--acp']);
      expect(resolvedShebang.unwrapKind).toBe('cmd-shebang-node');
    },
  );

  windowsIt('拦截目录穿越逃出 node_modules 的恶意 .cmd 以及任意自定义批处理脚本', () => {
    const root = makeTempDir('kpbl-ext-cmd-escape-');
    const npmDir = path.join(root, 'npm');
    fs.mkdirSync(path.join(npmDir, 'node_modules'), { recursive: true });
    const outsideExe = path.join(root, 'evil.exe');
    fs.writeFileSync(outsideExe, 'MZ-evil');
    fs.writeFileSync(
      path.join(npmDir, 'evil.cmd'),
      '@ECHO off\r\n"%~dp0\\node_modules\\..\\..\\evil.exe" %*\r\n',
    );

    expect(() =>
      resolveExternalCommand({
        command: 'evil',
        args: [],
        platform: 'win32',
        envPath: npmDir,
        homeDir: root,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'EXTERNAL_UNSUPPORTED_SHIM',
      }),
    );

    fs.writeFileSync(path.join(npmDir, 'custom.bat'), '@echo off\r\necho hi\r\n');
    expect(() =>
      resolveExternalCommand({
        command: path.join(npmDir, 'custom.bat'),
        args: [],
        platform: 'win32',
        envPath: npmDir,
        homeDir: root,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'EXTERNAL_UNSUPPORTED_SHIM',
      }),
    );
  });

  it('当受限 GUI PATH 未命中时，自动回退扫描用户标准安装目录（如 ~/.local/bin）', () => {
    const home = makeTempDir('kpbl-ext-gui-fallback-');
    const localBin = path.join(home, '.local', 'bin');
    fs.mkdirSync(localBin, { recursive: true });
    const target = path.join(localBin, process.platform === 'win32' ? 'claude.exe' : 'claude');
    fs.writeFileSync(target, 'MZ-claude');

    const resolved = resolveExternalCommand({
      command: 'claude',
      args: ['-p'],
      envPath: '',
      homeDir: home,
    });

    expect(resolved.executable).toBe(fs.realpathSync.native(target));
    expect(resolved.usedFallbackDir).toBe(true);
  });
});

describe('NdjsonChannel', () => {
  it('容忍启动非 JSON 横幅并按严格先后顺序调度大帧与后续响应，防结算超车', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const banners: string[] = [];
    const events: string[] = [];

    const channel = new NdjsonChannel(readable, writable, {
      onNonJsonLine: (line) => banners.push(line),
      onNotification: (method, params) => {
        const payload = params as { size?: number };
        events.push(`${method}:${payload.size ?? 0}`);
      },
    });

    const responsePromise = channel.request<{ done: boolean }>('session/prompt', { text: 'hi' });
    const sentRaw = writable.read()?.toString('utf8') ?? '';
    const sentReq = JSON.parse(sentRaw.trim()) as { id: number; jsonrpc: string };
    expect(sentReq.jsonrpc).toBe('2.0');

    // 先写一行非 JSON 横幅，再写一帧 > 64KiB 的大通知，紧跟小体积响应帧：
    // 响应绝不能在大通知让出事件循环时超车先 resolve。
    const largeText = 'x'.repeat(80 * 1024);
    readable.write('Welcome to Demo ACP CLI v1.0 (api_key=sk-secret123456789)\n');
    readable.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { size: largeText.length, blob: largeText } })}\n`,
    );
    readable.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: sentReq.id, result: { done: true } })}\n`,
    );

    const result = await responsePromise;
    expect(result).toEqual({ done: true });
    expect(events).toEqual([`session/update:${largeText.length}`]);
    expect(banners).toHaveLength(1);
    expect(banners[0]).toContain('[REDACTED]');

    channel.close();
  });

  it('握手完成前累计超过 100 行非 JSON 文本时立即熔断（防交互式 TUI 卡死）', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    let fatalError: unknown;

    const channel = new NdjsonChannel(readable, writable, {
      onFatalError: (err) => {
        fatalError = err;
      },
    });

    const pending = channel.request('initialize', { protocolVersion: 1 });
    for (let i = 0; i < 105; i++) {
      readable.write(`TUI spinner frame ${i}\n`);
    }

    await expect(pending).rejects.toMatchObject({
      code: 'EXTERNAL_NON_JSON_FLOOD',
    });
    expect((fatalError as ExternalHarnessError)?.code).toBe('EXTERNAL_NON_JSON_FLOOD');
    channel.close();
  });

  it('单帧超过限额时立即以 EXTERNAL_FRAME_LIMIT 断开通道', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const channel = new NdjsonChannel(readable, writable, {
      maxFrameBytes: 256,
    });

    const pending = channel.request('initialize', { protocolVersion: 1 });
    readable.write(`{"jsonrpc":"2.0","method":"huge","params":"${'a'.repeat(400)}"}\n`);

    await expect(pending).rejects.toMatchObject({
      code: 'EXTERNAL_FRAME_LIMIT',
    });
  });

  it('支持无 jsonrpc 字段的 JSON-RPC lite 与非 RPC 流式对象帧，并对未注册请求回 -32601', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const streamObjects: Record<string, unknown>[] = [];
    const lines = createInterface({ input: writable, crlfDelay: Number.POSITIVE_INFINITY });
    const outgoing = lines[Symbol.asyncIterator]();

    const channel = new NdjsonChannel(readable, writable, {
      onMessage: (msg) => streamObjects.push(msg),
    });

    const litePromise = channel.request<{ threadId: string }>(
      'thread/start',
      { cwd: '/tmp' },
      { omitJsonRpcVersion: true },
    );
    const firstOut = JSON.parse((await outgoing.next()).value) as Record<string, unknown>;
    expect(firstOut.jsonrpc).toBeUndefined();

    readable.write(`${JSON.stringify({ id: firstOut.id, result: { threadId: 'thr_1' } })}\n`);
    expect(await litePromise).toEqual({ threadId: 'thr_1' });

    // 未注册服务端请求必须自动回 -32601 Method not found
    readable.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', method: 'fs/read_text_file', params: { path: '/etc/passwd' } })}\n`,
    );
    // Claude stream-json 风格纯对象帧
    readable.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' })}\n`);

    await new Promise((resolve) => setImmediate(resolve));
    const errReply = JSON.parse((await outgoing.next()).value) as {
      id: string;
      error: { code: number };
    };
    expect(errReply.id).toBe('srv-1');
    expect(errReply.error.code).toBe(-32601);
    expect(streamObjects).toEqual([{ type: 'system', subtype: 'init', session_id: 's1' }]);

    // 乱序 JSON-RPC 响应：先返回第 2 个请求，再返回第 1 个请求，各自准确关联不串包
    const reqA = channel.request<string>('step/one');
    const reqB = channel.request<string>('step/two');
    const one = JSON.parse((await outgoing.next()).value) as { id: number; method: string };
    const two = JSON.parse((await outgoing.next()).value) as { id: number; method: string };
    expect([one.method, two.method]).toEqual(['step/one', 'step/two']);
    readable.write(`${JSON.stringify({ jsonrpc: '2.0', id: two.id, result: 'second' })}\n`);
    readable.write(`${JSON.stringify({ jsonrpc: '2.0', id: one.id, result: 'first' })}\n`);
    expect(await Promise.all([reqA, reqB])).toEqual(['first', 'second']);

    channel.close();
    lines.close();
  });
});

describe('ExternalProcessSupervisor', () => {
  it('优先通过 stdin.end() 优雅退出；对忽略 EOF 的顽固子进程树自动升级强杀回收', async () => {
    const cwd = makeTempDir('kpbl-ext-proc-');

    // 1. 监听 stdin EOF 即退出的良性子进程
    const politeScript = path.join(cwd, 'polite.mjs');
    fs.writeFileSync(
      politeScript,
      'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));\n',
    );
    const polite = ExternalProcessSupervisor.spawn({
      executable: process.execPath,
      args: [politeScript],
      cwd,
      env: buildExternalLaunchEnv({ platform: process.platform }).env,
    });
    const politeResult = await polite.close(1_500);
    expect(politeResult.forcedKill).toBe(false);
    expect(politeResult.code).toBe(0);

    // 2. 忽略 stdin EOF 且派生孙进程的顽固子进程
    const stubbornChild = path.join(cwd, 'grandchild.mjs');
    fs.writeFileSync(stubbornChild, 'setInterval(() => {}, 10_000);\n');
    const stubbornScript = path.join(cwd, 'stubborn.mjs');
    fs.writeFileSync(
      stubbornScript,
      `import { spawn } from 'node:child_process';
       const sub = spawn(process.execPath, [${JSON.stringify(stubbornChild)}], { stdio: 'ignore' });
       process.stdout.write(String(sub.pid) + '\\n');
       setInterval(() => {}, 10_000);
      `,
    );
    const stubborn = ExternalProcessSupervisor.spawn({
      executable: process.execPath,
      args: [stubbornScript],
      cwd,
      env: buildExternalLaunchEnv({ platform: process.platform }).env,
    });

    const grandchildPid = await new Promise<number>((resolve) => {
      stubborn.stdout.once('data', (chunk: Buffer) => {
        resolve(Number.parseInt(chunk.toString('utf8').trim(), 10));
      });
    });
    expect(grandchildPid).toBeGreaterThan(0);

    const stubbornResult = await stubborn.close(200);
    expect(stubbornResult.forcedKill).toBe(true);

    // 等待内核回收孙进程句柄，确认无孤儿残留
    await new Promise((resolve) => setTimeout(resolve, 150));
    let grandchildAlive = true;
    try {
      process.kill(grandchildPid, 0);
    } catch (err) {
      grandchildAlive = (err as NodeJS.ErrnoException).code !== 'ESRCH';
    }
    expect(grandchildAlive).toBe(false);
  });
});
