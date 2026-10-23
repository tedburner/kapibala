import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as pty from 'node-pty';

// 候选与驱动分开检出；报告身份只取候选 git，不取驱动工作流的 GITHUB_SHA。
const candidate = fs.realpathSync.native(path.resolve(process.argv[2]));
const output = path.resolve(process.argv[3]);
const development = process.argv.includes('--development');
const git = (...args) => {
  const result = spawnSync('git', ['-C', candidate, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, 'Cannot inspect candidate source');
  return result.stdout.trim();
};
const commit = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain').length > 0;
if (!development) {
  assert.equal(commit, process.env.CANDIDATE_SHA, 'Candidate SHA changed');
  assert.equal(dirty, false, 'Candidate worktree must be clean');
}
fs.mkdirSync(output, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-native-'));
// Windows 私有对象在实际用户 profile 内，不以修改 ACL 的方式制造通过。
const home =
  process.platform === 'win32'
    ? fs.mkdtempSync(path.join(process.env.USERPROFILE, 'kpbl-native-'))
    : path.join(scratch, 'home');
const workspace = path.join(scratch, 'workspace');
const runtime = path.join(home, 'runtime');
for (const dir of [home, workspace, path.join(home, '.kapibala')])
  fs.mkdirSync(dir, { recursive: true });
const hostEntry = path.join(candidate, 'packages/cli/dist/bin.js');
const cliEntry = path.join(candidate, 'packages/cli/dist/index.js');
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  KPBL_LOCAL_HOME: home,
  TERM: 'xterm-256color',
  NO_COLOR: '1',
};
// npm tarball 的 macOS spawn-helper 未保留可执行位，只修复验收依赖的安装产物。
if (process.platform !== 'win32') {
  const helper = fileURLToPath(
    new URL(
      `./node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`,
      import.meta.url,
    ),
  );
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
}
const observations = [];
const terminals = new Set();
const requests = [];
const held = new Set();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 所有等待有界；超时保留失败上下文，不能用无输出证明成功。 */
async function until(predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await pause(25);
  }
  throw new Error(`Timed out: ${label}`);
}

/** 异步 CLI 子进程不阻塞同一进程的确定性模型服务。 */
function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hostEntry, ...args], {
      cwd: workspace,
      env: environment,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('CLI timeout'));
    }, 25000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(stdout)
        : reject(new Error(`CLI exited ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

/** 只替代外部模型；请求、输入、工具调用和文件副作用仍走真实发布候选。 */
const model = http.createServer(async (request, response) => {
  try {
    let body = '';
    for await (const data of request) body += data;
    const messages = JSON.parse(body).messages;
    const content = [...messages].reverse().find((m) => m.role === 'user')?.content;
    const projected =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('')
          : '';
    // 候选在用户消息尾部追加运行时间；只剥离这个固定投影后缀，保留用户原始字节。
    const input = projected.replace(/\n\n\[Current environment data: [^\]]+\]$/, '');
    requests.push(input);
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    const send = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ id: 'native', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    const end = () => {
      send({}, 'stop');
      response.end('data: [DONE]\n\n');
    };
    if (messages.at(-1)?.role === 'tool') {
      send({ content: 'native-tool-done' });
      end();
      return;
    }
    if (input === 'native-cancel') {
      held.add(response);
      response.on('close', () => held.delete(response));
      send({ content: 'native-partial' });
      return;
    }
    if (input === 'native-approve' || input === 'native-deny') {
      send({
        tool_calls: [
          {
            index: 0,
            id: `call-${input}`,
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: `native/${input}.txt`, content: input }),
            },
          },
        ],
      });
      send({}, 'tool_calls');
      response.end('data: [DONE]\n\n');
      return;
    }
    // 每个 UTF-8 字节都可能跨网络分片，必须最终完整显示中文与 emoji。
    const payload = Buffer.from(
      `data: ${JSON.stringify({ id: 'native', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '原生终端响应🐾' }, finish_reason: null }] })}\n\n`,
    );
    for (let i = 0; i < payload.length; i += 3) {
      response.write(payload.subarray(i, i + 3));
      await pause(1);
    }
    end();
  } catch {
    response.destroy();
  }
});
await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
fs.writeFileSync(
  path.join(home, '.kapibala/settings.json'),
  JSON.stringify({
    defaultModel: 'native-fixture',
    permissionMode: 'Approval',
    profiles: [
      {
        id: 'native-fixture',
        name: 'Native fixture',
        provider: 'openai-compatible',
        modelName: 'native-fixture',
        baseURL: `http://127.0.0.1:${model.address().port}/v1`,
        apiKey: 'native-fixture-key',
        contextWindow: 128000,
      },
    ],
  }),
);

// 与 bin.js 相同的公开 main 入口；finally 只观察真实终端状态，不替候选清理 raw 模式。
const launcher = path.join(scratch, 'launch.mjs');
fs.writeFileSync(
  launcher,
  `import { main } from ${JSON.stringify(pathToFileURL(cliEntry).href)};\nconsole.log('NATIVE_TTY:'+JSON.stringify({input:process.stdin.isTTY,output:process.stdout.isTTY}));\ntry { await main(${JSON.stringify(['connect', '--runtime-dir', runtime, '--workspace', workspace])}); } catch(error) { console.log('NATIVE_ERROR:'+error.message); process.exitCode=1; } finally { console.log('NATIVE_CLEANUP:'+JSON.stringify({raw:process.stdin.isRaw??false})); }\n`,
);

/** 驱动真正的 PTY/ConPTY；输出游标保证每一步都观察到了新的提示或结果。 */
function terminal(label) {
  let raw = '';
  let clean = '';
  let cursor = 0;
  let exit;
  const child = pty.spawn(process.execPath, [launcher], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: workspace,
    env: environment,
    useConpty: true,
  });
  terminals.add(child);
  if (process.platform === 'win32')
    assert.equal(child._agent?._useConpty, true, 'The real ConPTY backend is required');
  child.onData((data) => {
    raw += data;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 匹配真实终端 ANSI 转义序列以检查可见输出。
    clean = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
  });
  child.onExit((value) => {
    exit = value;
    terminals.delete(child);
  });
  return {
    child,
    write: (data) => child.write(data),
    async see(text) {
      try {
        const index = await until(() => {
          const index = clean.indexOf(text, cursor);
          return index >= 0 ? { index } : undefined;
        }, `${label}: ${text}`);
        cursor = index.index + text.length;
      } catch (error) {
        throw new Error(`${error.message}; terminal tail: ${clean.slice(-1800)}`);
      }
    },
    async finish(expected) {
      await until(() => exit, `${label}: terminal exit`);
      fs.writeFileSync(path.join(output, `${label}.txt`), raw);
      assert.equal(exit.exitCode, expected, `${label}: exit code`);
      assert.match(clean, /NATIVE_TTY:\{"input":true,"output":true\}/);
      assert.match(clean, /NATIVE_CLEANUP:\{"raw":false\}/);
      return { label, exitCode: exit.exitCode, rawModeRestored: true };
    },
    save() {
      fs.writeFileSync(path.join(output, `${label}.txt`), raw);
    },
  };
}

/** 强制选择实际解释器，观察父/子进程 PID 与取消后的退出，不由外层 workflow shell 推断覆盖。 */
async function processTrees() {
  const core = await import(
    pathToFileURL(path.join(candidate, 'packages/core/dist/index.js')).href
  );
  const results = [];
  const kinds = process.platform === 'win32' ? ['bash', 'powershell'] : ['bash'];
  for (const kind of kinds) {
    const shell = core.detectShell({ cwd: workspace, preference: kind });
    assert.equal(shell.kind, kind);
    const file = `tree-${kind}.cjs`;
    const parentFile = path.join(workspace, `tree-${kind}-parent.pid`);
    const childFile = path.join(workspace, `tree-${kind}-child.pid`);
    fs.writeFileSync(
      path.join(workspace, file),
      `const fs=require('node:fs');const {spawn}=require('node:child_process');fs.writeFileSync(${JSON.stringify(parentFile)},String(process.pid));const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(childFile)},String(child.pid));setInterval(()=>{},1000);`,
    );
    const quote = (value) =>
      kind === 'powershell'
        ? `'${value.replaceAll("'", "''")}'`
        : `'${value.replaceAll("'", "'\\''")}'`;
    const command = `${kind === 'powershell' ? '& ' : ''}${quote(process.execPath)} ${quote(file)}`;
    const controller = new AbortController();
    const running = core
      .createRunCommandTool(shell)
      .execute({ command, timeout_ms: 30000 }, { rootDir: workspace, signal: controller.signal });
    // 立刻安装拒绝处理，等待启动文件时不得触发未处理 Promise rejection。
    const outcome = running.then(
      () => ({ code: 'unexpected-success' }),
      (error) => ({ code: error.code }),
    );
    try {
      await until(
        () => fs.existsSync(parentFile) && fs.existsSync(childFile),
        `${kind}: process tree started`,
      );
      const pids = [Number(fs.readFileSync(parentFile)), Number(fs.readFileSync(childFile))];
      const alive = (pid) => {
        try {
          process.kill(pid, 0);
        } catch {
          return false;
        }
        if (process.platform !== 'win32') {
          const status = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], {
            encoding: 'utf8',
          }).stdout?.trim();
          if (!status || status.startsWith('Z')) return false;
        }
        return true;
      };
      assert(pids.every(alive), `${kind}: both managed processes must really start`);
      controller.abort();
      assert.equal((await outcome).code, 'ABORTED');
      await until(() => pids.every((pid) => !alive(pid)), `${kind}: process tree stopped`);
      results.push({
        kind,
        executable: shell.executable,
        pids,
        aliveBefore: [true, true],
        aliveAfter: [false, false],
        outcome: 'ABORTED',
      });
    } finally {
      controller.abort();
      await outcome;
    }
  }
  return results;
}

const report = {
  schemaVersion: 1,
  commit,
  worktreeDirty: dirty,
  debugOverride: development,
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    terminal: process.platform === 'win32' ? 'conpty' : 'posix-pty',
  },
  observations,
  status: 'failed',
};
let active;
try {
  const first = JSON.parse(await cli(['daemon', 'start', '--runtime-dir', runtime]));
  assert.equal(first.running, true);
  active = terminal('interactive');
  await active.see('kpbl> ');
  active.write('native-');
  await pause(50);
  active.write('hello 分片🐾\r');
  await active.see('原生终端响应🐾');
  await active.see('kpbl> ');
  assert(requests.includes('native-hello 分片🐾'));
  observations.push({ check: 'fragmented-input-and-utf8-output', passed: true });
  active.write('\x1b[200~native-paste 中文🐾\x1b[201~\r');
  await active.see('原生终端响应🐾');
  await active.see('kpbl> ');
  assert(requests.includes('native-paste 中文🐾'));
  observations.push({ check: 'bracketed-paste', passed: true });
  for (const [task, choice, exists] of [
    ['native-approve', '1', true],
    ['native-deny', '3', false],
  ]) {
    active.write(`${task}\r`);
    await active.see('审批 ');
    assert.equal(fs.existsSync(path.join(workspace, `native/${task}.txt`)), false);
    active.write(`${choice}\r`);
    if (exists) await active.see('native-tool-done');
    await active.see('kpbl> ');
    assert.equal(fs.existsSync(path.join(workspace, `native/${task}.txt`)), exists);
    if (exists)
      assert.equal(fs.readFileSync(path.join(workspace, `native/${task}.txt`), 'utf8'), task);
    observations.push({ check: task, passed: true });
  }
  active.write('native-cancel\r');
  await active.see('native-partial');
  active.write('\x03');
  await active.see('kpbl> ');
  active.write('/status\r');
  await active.see('运行: 空闲');
  await active.see('kpbl> ');
  observations.push({ check: 'cancel-and-idle-recovery', passed: true });
  await cli(['daemon', 'stop', '--runtime-dir', runtime]);
  active.write('after-disconnect\r');
  observations.push(await active.finish(1));
  active = undefined;
  await cli(['daemon', 'start', '--runtime-dir', runtime]);
  active = terminal('reconnected');
  await active.see('kpbl> ');
  active.write('native-reconnected\r');
  await active.see('原生终端响应🐾');
  await active.see('kpbl> ');
  assert(requests.includes('native-reconnected'));
  active.write('/close\r');
  await active.see('已关闭当前会话');
  observations.push(await active.finish(0));
  active = undefined;
  if (process.platform === 'win32') {
    const metadata = JSON.parse(fs.readFileSync(path.join(runtime, 'daemon.json'), 'utf8'));
    const config = path.join(scratch, 'cross-user-input.json');
    const result = path.join(output, 'cross-user.json');
    fs.writeFileSync(
      config,
      JSON.stringify({
        node: process.execPath,
        files: [path.join(runtime, 'daemon.json'), path.join(home, '.kapibala/settings.json')],
        pipe: metadata.endpoint.path,
      }),
    );
    const ps = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        fileURLToPath(new URL('./windows-cross-user.ps1', import.meta.url)),
        '-Config',
        config,
        '-Output',
        result,
      ],
      { encoding: 'utf8', timeout: 90000 },
    );
    assert.equal(ps.status, 0, `Cross-user check failed: ${ps.stderr?.slice(-1200)}`);
    const crossUser = JSON.parse(fs.readFileSync(result, 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(crossUser.status, 'passed');
    report.crossUser = crossUser;
  }
  report.tree = await processTrees();
  report.status = 'passed';
} catch (error) {
  active?.save();
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  for (const child of terminals) {
    try {
      child.kill();
    } catch {}
  }
  for (const response of held) response.destroy();
  await cli(['daemon', 'stop', '--runtime-dir', runtime]).catch(() => {});
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  report.generatedAt = new Date().toISOString();
  report.modelInputs = requests;
  fs.writeFileSync(path.join(output, 'native-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (process.platform === 'win32')
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
