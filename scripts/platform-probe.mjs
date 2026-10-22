import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startCompatModelServer } from './compat-model.mjs';

/**
 * 当前 OS 的真实进程探针：daemon/stdio/socket 生命周期、token 拒绝与进程树取消。
 * 只记录可观察事实，断言与证据归档由 verify-platform.ts 负责。
 */

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing --${name}`);
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
  return value;
};

const clientEntry = path.resolve(option('client'));
const hostEntry = path.resolve(option('host'));
const root = path.resolve(option('root'));
const home = path.resolve(option('home'));
const runtime = path.resolve(option('runtime'));
const resultPath = path.resolve(option('result'));

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  KPBL_LOCAL_HOME: home,
  NO_COLOR: '1',
};

const clientModule = await import(pathToFileURL(clientEntry).href);
const model = await startCompatModelServer();
fs.mkdirSync(path.join(home, '.kapibala'), { recursive: true });
fs.writeFileSync(
  path.join(home, '.kapibala/settings.json'),
  JSON.stringify({
    defaultModel: 'compat-fixture',
    profiles: [
      {
        id: 'compat-fixture',
        name: 'Compat Fixture',
        provider: 'openai-compatible',
        baseURL: model.baseURL,
        apiKey: 'fixture-compat-key',
        modelName: 'compat-fixture',
        contextWindow: 128000,
      },
    ],
    permissionMode: 'Approval',
  }),
);

const OFFER = Object.freeze({
  major: 1,
  minMinor: 0,
  maxMinor: 0,
  clientName: 'platform-probe',
  capabilities: [],
});

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`Timed out: ${label}`);
}

/** 异步等待 CLI 退出，保持模型 fixture 的事件循环可用；同步等待会把自己托管的 HTTP 服务阻塞死。 */
function runCli(cliArgs, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hostEntry, ...cliArgs], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-16_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-16_000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`kpbl ${cliArgs.join(' ')} timed out`));
    }, timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(`kpbl ${cliArgs.join(' ')} failed (${code ?? signal}): ${stderr || stdout}`),
        );
    });
  });
}

function startStdioHost() {
  const child = spawn(process.execPath, [hostEntry, 'serve', '--stdio'], {
    cwd: root,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8_000);
  });
  const exit = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, exit, stderr: () => stderr };
}

async function connectStdio(options = {}) {
  const host = startStdioHost();
  const transport = clientModule.createStdioTransport(host.child.stdout, host.child.stdin);
  const client = await clientModule.LocalClient.connect(transport, OFFER, options);
  return { host, client };
}

async function closeStdio(host, client) {
  await client.close();
  host.child.stdin.end();
  return Promise.race([
    host.exit,
    delay(5_000).then(() => {
      host.child.kill('SIGTERM');
      return { code: null, signal: 'SIGTERM', timedOut: true };
    }),
  ]);
}

async function stdioSection() {
  const { host, client } = await connectStdio();
  try {
    const ping = await client.call('ping', {});
    return { ping, host: await closeStdio(host, client), stderr: host.stderr() };
  } catch (error) {
    await closeStdio(host, client).catch(() => {});
    throw error;
  }
}

function readMetadata() {
  return JSON.parse(fs.readFileSync(path.join(runtime, 'daemon.json'), 'utf8'));
}

function metadataMode() {
  try {
    return fs.lstatSync(path.join(runtime, 'daemon.json')).mode & 0o777;
  } catch {
    return null;
  }
}

function runtimeMode() {
  try {
    return fs.lstatSync(runtime).mode & 0o777;
  } catch {
    return null;
  }
}

async function initializeWithToken(endpoint, token) {
  const transport = await clientModule.connectLocal(endpoint);
  try {
    const client = await clientModule.LocalClient.connect(transport, {
      ...OFFER,
      ...(token === undefined ? {} : { token }),
    });
    try {
      return { ok: true, ping: await client.call('ping', {}) };
    } finally {
      await client.close();
    }
  } catch (error) {
    await transport.close().catch(() => {});
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function daemonSection() {
  const first = JSON.parse(await runCli(['daemon', 'start', '--runtime-dir', runtime]));
  const second = JSON.parse(await runCli(['daemon', 'start', '--runtime-dir', runtime]));
  const metadata = readMetadata();
  // 停止会删除元数据；权限快照必须在 daemon 仍运行时读取。
  const metadataFileMode = metadataMode();
  const runtimeDirectoryMode = runtimeMode();
  const statusRunning = JSON.parse(await runCli(['daemon', 'status', '--runtime-dir', runtime]));
  const connected = await runCli([
    'connect',
    '--runtime-dir',
    runtime,
    '--workspace',
    root,
    '-p',
    'compat-smoke deterministic platform smoke',
  ]);
  const auth = {
    missing: await initializeWithToken(metadata.endpoint, undefined),
    wrong: await initializeWithToken(metadata.endpoint, '0'.repeat(64)),
    correct: await initializeWithToken(metadata.endpoint, metadata.token),
  };
  // 认证失败不能连坐已运行实例；停止操作继续走已认证实例。
  await runCli(['daemon', 'stop', '--runtime-dir', runtime]);
  await waitFor(
    () => !fs.existsSync(path.join(runtime, 'daemon.lock')),
    'daemon lock removal',
    5_000,
  );
  const statusStopped = JSON.parse(await runCli(['daemon', 'status', '--runtime-dir', runtime]));
  return {
    first,
    second,
    metadata: {
      serverInstanceId: metadata.serverInstanceId,
      endpointType: metadata.endpoint.type,
      tokenShape: /^[a-f0-9]{64}$/.test(metadata.token),
      mode: metadataFileMode,
      runtimeMode: runtimeDirectoryMode,
    },
    statusRunning,
    connected: connected.includes('local-smoke-ok'),
    auth,
    statusStopped,
    lockRemoved: !fs.existsSync(path.join(runtime, 'daemon.lock')),
  };
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function writeTreeScript() {
  fs.writeFileSync(
    path.join(root, 'compat-tree.cjs'),
    [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "fs.writeFileSync('compat-tree-shell.pid', String(process.pid));",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {",
      "  stdio: 'ignore',",
      '});',
      "fs.writeFileSync('compat-tree-child.pid', String(child.pid));",
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
  );
}

async function treeSection() {
  writeTreeScript();
  const { host, client } = await connectStdio({
    approval: async () => 'allow_once',
  });
  const events = [];
  client.subscribe((event) => events.push(event));
  try {
    const created = await client.call('session/create', { workspaceRoot: root });
    const attached = await client.call('session/attach', {
      sessionId: created.sessionId,
      mode: 'control',
    });
    const control = {
      sessionId: created.sessionId,
      streamEpoch: attached.streamEpoch,
      controlEpoch: attached.controlEpoch,
    };
    const started = await client.call('run/start', {
      ...control,
      clientOperationId: 'platform-tree',
      input: 'compat-tree process group',
    });
    const shellFile = path.join(root, 'compat-tree-shell.pid');
    const childFile = path.join(root, 'compat-tree-child.pid');
    await waitFor(
      () => fs.existsSync(shellFile) && fs.existsSync(childFile),
      'tree pid files',
      20_000,
    );
    const shellPid = Number(fs.readFileSync(shellFile, 'utf8'));
    const childPid = Number(fs.readFileSync(childFile, 'utf8'));
    const aliveBefore = { shell: processAlive(shellPid), child: processAlive(childPid) };
    await client.call('run/cancel', { ...control, runId: started.runId });
    const settled = await waitFor(
      () => events.find((event) => event.type === 'run_settled' && event.runId === started.runId),
      'tree run settled',
      15_000,
    );
    await waitFor(
      () => !processAlive(shellPid) && !processAlive(childPid),
      'tree process group exit',
      10_000,
    );
    const aliveAfter = { shell: processAlive(shellPid), child: processAlive(childPid) };
    await client.call('session/close', control);
    await client.call('host/shutdown', {});
    return {
      shellPid,
      childPid,
      aliveBefore,
      aliveAfter,
      outcome: settled.payload?.outcome,
      host: await closeStdio(host, client),
      stderr: host.stderr(),
    };
  } catch (error) {
    await closeStdio(host, client).catch(() => {});
    throw error;
  }
}

let started = false;
try {
  const section = option('section', 'all');
  const result = { ok: true, platform: process.platform, node: process.version, section };
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  if (section === 'stdio' || section === 'all') result.stdio = await stdioSection();
  if (section === 'daemon' || section === 'all') {
    started = true;
    result.daemon = await daemonSection();
    started = false;
  }
  if (section === 'tree' || section === 'all') result.tree = await treeSection();
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
} catch (error) {
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        ok: false,
        platform: process.platform,
        node: process.version,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      null,
      2,
    ),
  );
} finally {
  if (started) {
    try {
      await runCli(['daemon', 'stop', '--runtime-dir', runtime]);
    } catch {
      /* 失败状态已写入结果，清理失败不覆盖原始错误。 */
    }
  }
  model.close();
}
process.exit(0);
