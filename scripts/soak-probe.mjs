import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startCompatModelServer } from './compat-model.mjs';

/**
 * v0.0.10 soak 场景驱动器：同一脚本覆盖 PR/nightly/release 三档，只改变轮数与节奏。
 * 每轮真实建立会话并交替使用 stdio/socket，按 open/run/cancel/close 混合执行；
 * 子进程轮次验证取消后进程树回收。只记录原始事实与失败原因，断言由 verify-soak.ts 负责。
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
const protocolEntry = path.resolve(option('protocol'));
const hostEntry = path.resolve(option('host'));
const root = path.resolve(option('root'));
const home = path.resolve(option('home'));
const runtime = path.resolve(option('runtime'));
const resultPath = path.resolve(option('result'));
const tier = option('tier', 'pr');
const rounds = Number(option('rounds', '10'));
const warmupRounds = Number(option('warmup', '0'));
const paceMs = Number(option('pace-ms', '0'));
const recycleEvery = Number(option('recycle-every', '10'));
const treeEvery = Number(option('tree-every', '10'));
const sampleEvery = Number(option('sample-every', '1'));

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  KPBL_LOCAL_HOME: home,
  NO_COLOR: '1',
};

const clientModule = await import(pathToFileURL(clientEntry).href);
const protocolModule = await import(pathToFileURL(protocolEntry).href);
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
  clientName: `soak-${tier}`,
  capabilities: [],
});
const approval = async () => 'allow_once';
const startTime = Date.now();
const events = new Map();
const recycles = [];
const treeRounds = [];
const samples = [];
const roundCounts = { session: 0, run: 0, cancel: 0, tree: 0 };
const outcomes = { completed: 0, cancelled: 0 };
let maxOpenSessions = 0;
let stdioClient;
let stdioHost;
let socketClient;
let metadata;
let stdioUses = 0;
let socketUses = 0;
const hostPids = new Set();

const result = {
  ok: false,
  tier,
  rounds,
  warmupRounds,
  paceMs,
  recycleEvery,
  treeEvery,
  sampleEvery,
  platform: process.platform,
  node: process.version,
  arch: process.arch,
  limits: protocolModule.DEFAULT_LIMITS,
};

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`Timed out: ${label}`);
}

function recordEvent(event) {
  if (!event || typeof event.runId !== 'string') return;
  const list = events.get(event.runId) ?? [];
  list.push(event);
  events.set(event.runId, list);
}

function waitForEvent(runId, type, timeoutMs = 20_000) {
  return waitFor(
    () => events.get(runId)?.find((event) => event.type === type),
    `${type} for ${runId}`,
    timeoutMs,
  );
}

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
  hostPids.add(child.pid);
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8_000);
  });
  const exit = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, exit, stderr: () => stderr };
}

async function connectStdio() {
  stdioHost = startStdioHost();
  const transport = clientModule.createStdioTransport(
    stdioHost.child.stdout,
    stdioHost.child.stdin,
  );
  stdioClient = await clientModule.LocalClient.connect(transport, OFFER, { approval });
  stdioClient.subscribe(recordEvent);
  return stdioClient;
}

async function closeStdio(host, client) {
  try {
    await client.call('host/shutdown', {});
  } catch {
    /* 关停请求失败由进程退出结果裁决。 */
  }
  try {
    await client.close();
  } catch {
    /* 连接已关闭时 close 幂等失败可忽略。 */
  }
  host.child.stdin.end();
  return Promise.race([
    host.exit,
    delay(5_000).then(() => {
      host.child.kill('SIGTERM');
      return { code: null, signal: 'SIGTERM', timedOut: true };
    }),
  ]);
}

async function shutdownStdio() {
  if (stdioClient) {
    await stdioClient.close().catch(() => {});
    stdioClient = undefined;
  }
  if (!stdioHost) return null;
  const host = stdioHost;
  stdioHost = undefined;
  host.child.stdin.end();
  return Promise.race([
    host.exit,
    delay(3_000).then(() => {
      host.child.kill('SIGTERM');
      return { code: null, signal: 'SIGTERM', timedOut: true };
    }),
  ]);
}

function readMetadata() {
  return JSON.parse(fs.readFileSync(path.join(runtime, 'daemon.json'), 'utf8'));
}

async function connectSocket() {
  const transport = await clientModule.connectLocal(metadata.endpoint);
  socketClient = await clientModule.LocalClient.connect(
    transport,
    { ...OFFER, token: metadata.token },
    { approval },
  );
  socketClient.subscribe(recordEvent);
  return socketClient;
}

async function recycleStdio(round) {
  const exit = await closeStdio(stdioHost, stdioClient);
  stdioClient = undefined;
  stdioHost = undefined;
  stdioUses = 0;
  recycles.push({ transport: 'stdio', round, exit });
  if (exit.code !== 0 || exit.timedOut) {
    throw new Error(`stdio host exited uncleanly at round ${round}: ${JSON.stringify(exit)}`);
  }
  await connectStdio();
}

async function recycleSocket(round) {
  await socketClient.close();
  socketClient = undefined;
  socketUses = 0;
  await connectSocket();
  recycles.push({ transport: 'socket', round });
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
  // compat-model.mjs 的 compat-tree 分支固定执行 compat-tree.cjs，文件名必须与共享 fixture 一致。
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

const SHELL_PID_FILE = path.join(root, 'compat-tree-shell.pid');
const CHILD_PID_FILE = path.join(root, 'compat-tree-child.pid');

async function openSession(client, round) {
  const created = await client.call('session/create', { workspaceRoot: root });
  const attached = await client.call('session/attach', {
    sessionId: created.sessionId,
    mode: 'control',
  });
  maxOpenSessions = Math.max(maxOpenSessions, attached.openSessions);
  if (attached.openSessions !== 1)
    throw new Error(`round ${round}: ${String(attached.openSessions)} sessions remain open`);
  return {
    sessionId: created.sessionId,
    streamEpoch: attached.streamEpoch,
    controlEpoch: attached.controlEpoch,
  };
}

async function executeRound(round, kind, counted) {
  const transport = round % 2 === 1 ? 'stdio' : 'socket';
  if (transport === 'stdio') {
    if (stdioUses >= recycleEvery) await recycleStdio(round);
    stdioUses++;
  } else {
    if (socketUses >= recycleEvery) await recycleSocket(round);
    socketUses++;
  }
  const client = transport === 'stdio' ? stdioClient : socketClient;
  if (!client) throw new Error(`round ${round}: ${transport} client is not connected`);
  if (counted) roundCounts[kind]++;

  if (kind === 'session') {
    const control = await openSession(client, round);
    const snapshot = await client.call('session/snapshot', { sessionId: control.sessionId });
    if (snapshot.openSessions !== 1)
      throw new Error(
        `round ${round}: snapshot reports ${String(snapshot.openSessions)} open sessions`,
      );
    await client.call('session/close', control);
    return;
  }

  if (kind === 'run' || kind === 'cancel') {
    const control = await openSession(client, round);
    const started = await client.call('run/start', {
      ...control,
      clientOperationId: `soak-${round}`,
      input:
        kind === 'run' ? `compat-smoke soak run ${round}` : `compat-cancel soak cancel ${round}`,
    });
    try {
      if (kind === 'cancel') {
        await waitForEvent(started.runId, 'text_delta', 20_000);
        await client.call('run/cancel', { ...control, runId: started.runId });
      }
      const settled = await waitForEvent(started.runId, 'run_settled', 20_000);
      const expected = kind === 'run' ? 'completed' : 'cancelled';
      if (settled.payload?.outcome !== expected)
        throw new Error(
          `round ${round}: expected ${expected}, settled as ${String(settled.payload?.outcome)}`,
        );
      if (counted) outcomes[expected]++;
    } finally {
      events.delete(started.runId);
      await client.call('session/close', control);
    }
    return;
  }

  if (kind === 'tree') {
    fs.rmSync(SHELL_PID_FILE, { force: true });
    fs.rmSync(CHILD_PID_FILE, { force: true });
    const control = await openSession(client, round);
    const started = await client.call('run/start', {
      ...control,
      clientOperationId: `soak-tree-${round}`,
      input: `compat-tree soak tree ${round}`,
    });
    try {
      await waitFor(
        () => fs.existsSync(SHELL_PID_FILE) && fs.existsSync(CHILD_PID_FILE),
        `tree pid files for round ${round}`,
        20_000,
      );
      const shellPid = Number(fs.readFileSync(SHELL_PID_FILE, 'utf8'));
      const childPid = Number(fs.readFileSync(CHILD_PID_FILE, 'utf8'));
      hostPids.add(shellPid);
      hostPids.add(childPid);
      const aliveBefore = { shell: processAlive(shellPid), child: processAlive(childPid) };
      await client.call('run/cancel', { ...control, runId: started.runId });
      const settled = await waitForEvent(started.runId, 'run_settled', 20_000);
      if (settled.payload?.outcome !== 'cancelled')
        throw new Error(`round ${round}: tree run settled as ${String(settled.payload?.outcome)}`);
      await waitFor(
        () => !processAlive(shellPid) && !processAlive(childPid),
        `tree exit for round ${round}`,
        15_000,
      );
      if (counted) outcomes.cancelled++;
      treeRounds.push({
        round,
        shellPid,
        childPid,
        aliveBefore,
        aliveAfter: { shell: processAlive(shellPid), child: processAlive(childPid) },
      });
    } finally {
      events.delete(started.runId);
      await client.call('session/close', control);
    }
    return;
  }

  throw new Error(`Unknown soak round kind: ${kind}`);
}

async function readProcessRss(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const output = await new Promise((resolve, reject) => {
        const child = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`,
          ],
          { stdio: ['ignore', 'pipe', 'ignore'] },
        );
        let text = '';
        child.stdout.on('data', (chunk) => {
          text += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(text) : reject(new Error('ps failed'))));
      });
      const bytes = Number(output.trim());
      return Number.isFinite(bytes) ? bytes : null;
    }
    const output = await new Promise((resolve, reject) => {
      const child = spawn('ps', ['-o', 'rss=', '-p', String(pid)], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let text = '';
      child.stdout.on('data', (chunk) => {
        text += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(text) : reject(new Error('ps failed'))));
    });
    const kilobytes = Number(output.trim());
    return Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
  } catch {
    return null;
  }
}

function activeResourceTypes() {
  const counts = {};
  for (const name of process.getActiveResourcesInfo()) counts[name] = (counts[name] ?? 0) + 1;
  return counts;
}

async function appendSample(round) {
  const memory = process.memoryUsage();
  samples.push({
    round,
    elapsedMs: Date.now() - startTime,
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
    activeResources: process.getActiveResourcesInfo().length,
    activeResourceTypes: activeResourceTypes(),
    daemonRss: await readProcessRss(metadata?.pid),
    stdioRss: stdioHost ? await readProcessRss(stdioHost.child.pid) : null,
  });
}

async function main() {
  writeTreeScript();
  await runCli(['daemon', 'start', '--runtime-dir', runtime]);
  metadata = readMetadata();
  await connectSocket();
  await connectStdio();
  result.daemon = { pid: metadata.pid, endpointType: metadata.endpoint.type };
  result.startedAt = new Date(startTime).toISOString();

  const kinds = ['session', 'run', 'cancel'];
  for (let warmup = 1; warmup <= warmupRounds; warmup++) await executeRound(warmup, 'run', false);

  for (let round = 1; round <= rounds; round++) {
    const kind = round % treeEvery === 0 ? 'tree' : kinds[(round - 1) % kinds.length];
    await executeRound(round, kind, true);
    if (round % sampleEvery === 0) await appendSample(round);
    if (paceMs > 0) await delay(paceMs);
  }

  const finalProbeRound = rounds + 1;
  const finalClient = finalProbeRound % 2 === 1 ? stdioClient : socketClient;
  const finalControl = await openSession(finalClient, finalProbeRound);
  const finalSnapshot = await finalClient.call('session/snapshot', {
    sessionId: finalControl.sessionId,
  });
  await finalClient.call('session/close', finalControl);

  const stdioExit = await closeStdio(stdioHost, stdioClient);
  stdioClient = undefined;
  stdioHost = undefined;
  await socketClient.close();
  socketClient = undefined;
  await runCli(['daemon', 'stop', '--runtime-dir', runtime]);
  await waitFor(
    () => !fs.existsSync(path.join(runtime, 'daemon.lock')),
    'daemon lock removal',
    10_000,
  );
  await waitFor(() => !processAlive(metadata.pid), 'daemon process exit', 10_000).catch(() => {});

  const alivePids = [...hostPids].filter(processAlive);
  Object.assign(result, {
    ok: true,
    roundCounts,
    outcomes,
    maxOpenSessions,
    recycles,
    treeRounds,
    samples,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    final: {
      snapshotOpenSessions: finalSnapshot.openSessions,
      stdioExit,
      daemonStopped: !processAlive(metadata.pid),
      lockRemoved: !fs.existsSync(path.join(runtime, 'daemon.lock')),
      alivePids,
    },
  });
}

try {
  await main();
} catch (error) {
  result.ok = false;
  result.error = error instanceof Error ? error.message : String(error);
  result.stack = error instanceof Error ? error.stack : undefined;
  result.roundCounts = roundCounts;
  result.finishedAt = new Date().toISOString();
  result.durationMs = Date.now() - startTime;
  try {
    const stdioExit = await shutdownStdio();
    if (socketClient) await socketClient.close().catch(() => {});
    socketClient = undefined;
    if (metadata?.pid) {
      await runCli(['daemon', 'stop', '--runtime-dir', runtime], 15_000).catch(() => {});
      await waitFor(() => !processAlive(metadata.pid), 'failure daemon exit', 10_000).catch(
        () => {},
      );
    }
    result.failureCleanup = {
      stdioExit,
      daemonAlive: metadata?.pid ? processAlive(metadata.pid) : null,
    };
  } catch (cleanupError) {
    result.failureCleanup = {
      ...(result.failureCleanup ?? {}),
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    };
  }
} finally {
  model.close();
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
}
