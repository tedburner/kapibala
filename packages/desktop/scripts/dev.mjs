import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { build, resolveConfig } from 'electron-vite';
import { createServer } from 'vite';
import { toolchainEnv } from '../../../scripts/process-env.mjs';
import { developmentExecutable } from './dev-runtime.mjs';
import { desktopLaunchEnv } from './launch-env.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(desktop, '../..');
// dev 专用 userData：guard（host-guard.json）与 Chromium 状态全部落在 gitignore 的
// .workbuddy/ 里，与生产目录彻底隔离；watch 模式反复重启异常退出也不再污染生产栅栏，
// 正式版不会被 dev 残留的 guard 顶成「上次执行未确认完成清理」。HOME 不隔离，
// agent host 继续使用真实 ~/.kapibala 的模型密钥与会话。
const devUserData = path.join(repository, '.workbuddy/desktop-dev/userData');
// 防重入锁：两个 dev 实例并存会共享同一份 dev 状态并互相触发 guard 冲突
// （Electron 单实例锁拦不住两个 dev.mjs 各自拉起的进程）。锁文件记录持有者 PID 与随机 token，
// 并靠心跳续命。新实例只在「持有者仍在跑且心跳新鲜」时拒绝启动；Ctrl+Z 挂起的实例会被立即
// 结束并接管（挂起进程仍占着 5173 端口与 Electron），崩溃/断电留下的锁则按心跳超时清理。
// 被接管的旧实例在下一次心跳发现 token 变化后自行清理退出。
const devLockFile = path.join(repository, '.workbuddy/desktop-dev/dev.lock');
const devLockToken = randomUUID();
const DEV_LOCK_HEARTBEAT_MS = 10_000;
const DEV_LOCK_STALE_MS = 30_000;
function readDevLock() {
  try {
    return {
      owner: JSON.parse(fs.readFileSync(devLockFile, 'utf8')),
      ageMs: Date.now() - fs.statSync(devLockFile).mtimeMs,
    };
  } catch {
    return undefined;
  }
}
function lockOwnerAlive(pid) {
  if (typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
/** 读取 `ps` 状态列：T/t 为挂起、Z 为僵尸；没有 ps 的平台（Windows）返回 undefined。 */
function processState(pid) {
  if (process.platform === 'win32' || typeof pid !== 'number') return undefined;
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}
/** 把持有者分成 running / stopped / dead：挂起与僵尸都不能再算「正在运行」。 */
function lockOwnerHealth(pid) {
  if (!lockOwnerAlive(pid)) return 'dead';
  const state = processState(pid);
  if (state && /^Z/.test(state)) return 'dead';
  if (state && /^[Tt]/.test(state)) return 'stopped';
  return 'running';
}
function processGroupId(pid) {
  if (process.platform === 'win32' || typeof pid !== 'number') return undefined;
  try {
    const pgid = Number(
      execFileSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8' }).trim(),
    );
    return Number.isSafeInteger(pgid) && pgid > 1 ? pgid : undefined;
  } catch {
    return undefined;
  }
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/**
 * 结束挂起或心跳超时的旧 dev 实例：先恢复整个作业组（Ctrl+Z 会连 Electron 一起停住），
 * 再向 dev.mjs 发 SIGTERM 走它的 finish()（停 Electron、关端口、删锁）；5s 未退则强杀组。
 * 只有锁仍指向同一个 PID 与 token 时才动手，避免 PID 复用误杀无关进程。
 */
function terminateStaleOwner(pid, ownerToken) {
  const current = readDevLock();
  if (current?.owner?.pid !== pid || current?.owner?.token !== ownerToken) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
    sleepSync(300);
    return;
  }
  const group = processGroupId(pid);
  const ownGroup = processGroupId(process.pid);
  const signal = (name) => {
    try {
      if (group && group !== ownGroup) process.kill(-group, name);
      else process.kill(pid, name);
    } catch {}
  };
  signal('SIGCONT');
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!lockOwnerAlive(pid) || /^Z/.test(processState(pid) ?? '')) return;
    const snapshot = readDevLock();
    if (!snapshot || snapshot.owner?.token !== ownerToken) return;
    sleepSync(150);
  }
  console.warn(`旧 dev 实例（PID ${pid}）未在 5s 内退出，强制终止。`);
  signal('SIGKILL');
  sleepSync(300);
}
function acquireDevLock() {
  fs.mkdirSync(path.dirname(devLockFile), { recursive: true });
  for (;;) {
    try {
      fs.writeFileSync(
        devLockFile,
        JSON.stringify({ pid: process.pid, token: devLockToken, startedAt: Date.now() }),
        { flag: 'wx', mode: 0o600 },
      );
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const snapshot = readDevLock();
      const health = snapshot ? lockOwnerHealth(snapshot.owner?.pid) : 'dead';
      const fresh = Boolean(snapshot && snapshot.ageMs <= DEV_LOCK_STALE_MS);
      // 持有者确实在跑且心跳新鲜：唯一应该拒绝启动的情况。
      if (snapshot && health === 'running' && fresh) {
        throw new Error(
          `另一个 pnpm dev:desktop（PID ${snapshot.owner.pid}）正在运行，已退出。` +
            `若确认它已停止，可执行 kill ${snapshot.owner.pid} 或删除 ${path.relative(repository, devLockFile)} 后重试。`,
        );
      }
      if (snapshot && health !== 'dead') {
        // 挂起（Ctrl+Z）或心跳超时的实例仍占着 5173 与 Electron：先结束再接管，
        // 否则新实例会在端口上撞车；用户主动启动第二个实例时清理旧实例是预期行为。
        console.warn(
          `上一个 dev 实例（PID ${snapshot.owner.pid}，${health === 'stopped' ? '已挂起' : '心跳超时'}）仍在占用端口，正在结束它并接管…`,
        );
        terminateStaleOwner(snapshot.owner.pid, snapshot.owner.token);
      } else {
        console.warn(`检测到陈旧 dev 锁（PID ${snapshot?.owner?.pid ?? '未知'}），已接管。`);
      }
      const current = readDevLock();
      if ((!snapshot && current) || current?.owner?.token === snapshot?.owner?.token) {
        try {
          fs.unlinkSync(devLockFile);
        } catch {}
      }
    }
  }
}
/** 定期续锁；一旦发现锁已被新实例接管，立即停掉自身，绝不与新实例共享 dev 状态。 */
function startDevLockHeartbeat() {
  const timer = setInterval(() => {
    if (readDevLock()?.owner?.token !== devLockToken) {
      console.error('dev 锁已被另一个实例接管，当前实例退出。');
      clearInterval(timer);
      void finish();
      return;
    }
    try {
      const now = new Date();
      fs.utimesSync(devLockFile, now, now);
    } catch {}
  }, DEV_LOCK_HEARTBEAT_MS);
  timer.unref();
  return timer;
}
const token = randomUUID();
const executable = developmentExecutable(
  electron,
  path.join(repository, '.workbuddy/desktop-dev-runtime'),
);
let child;
let restarting = false;
let stopping = false;
let dirty = false;
let rebuilding;
let debounce;
const watchers = [];
const watched = [
  'packages/core/src',
  'packages/mcp/src',
  'packages/host/src',
  'packages/cli/src',
  'packages/desktop/src/main',
  'packages/desktop/src/preload',
  'packages/desktop/src/agent-host',
  'packages/desktop/src/shared',
  'packages/desktop/electron.vite.config.ts',
];
function inputDigest() {
  const hash = createHash('sha256');
  function read(file) {
    if (fs.statSync(file).isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) read(path.join(file, name));
    } else if (/\.(?:[cm]?[jt]sx?|json)$/.test(file)) {
      hash.update(file);
      hash.update(fs.readFileSync(file));
    }
  }
  for (const relative of watched) read(path.join(repository, relative));
  return hash.digest('hex');
}
let lastDigest = inputDigest();
function changed() {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    const next = inputDigest();
    if (next === lastDigest) return;
    lastDigest = next;
    void rebuild();
  }, 300);
}

function sharedBuild() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['build'], {
      cwd: repository,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      // 构建子进程只剥离外部预加载钩子，保留 HOME / CI 变量与堆参数。
      env: toolchainEnv(process.env, repository),
    });
    proc.once('error', reject);
    proc.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('共享依赖构建失败，未启动旧产物。')),
    );
  });
}
async function stopChild() {
  const running = child;
  if (!running || running.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('桌面清理未确认，停止自动重启；请检查应用与 guard。')),
      30_000,
    );
    running.once('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error('桌面异常退出，保留 guard，不自动重启。'));
    });
    running.send({ kind: 'kpbl:dev-stop', token }, (error) => {
      if (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}
function launch() {
  child = spawn(executable, [desktop, `--user-data-dir=${devUserData}`], {
    cwd: desktop,
    // 白名单构造：宿主的 NODE_OPTIONS / ELECTRON_RUN_AS_NODE 绝不能进主进程（会让应用启动即退出）。
    env: desktopLaunchEnv(process.env, {
      ELECTRON_RENDERER_URL: server.resolvedUrls.local[0].replace(/\/$/, ''),
      KPBL_DESKTOP_DEV_TOKEN: token,
    }),
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  child.once('error', (error) => {
    console.error(error.message);
    void finish();
  });
  child.once('exit', () => {
    if (!restarting && !stopping) void finish();
  });
}
async function rebuild() {
  dirty = true;
  if (rebuilding) return rebuilding;
  rebuilding = (async () => {
    restarting = true;
    try {
      while (dirty && !stopping) {
        dirty = false;
        await stopChild();
        await sharedBuild();
        await build({ root: desktop });
        if (!dirty && !stopping) launch();
      }
    } catch (error) {
      console.error(error.message);
      await finish();
      process.exitCode = 1;
    } finally {
      restarting = false;
      rebuilding = undefined;
    }
  })();
  return rebuilding;
}
async function finish() {
  if (stopping) return;
  stopping = true;
  clearTimeout(debounce);
  clearInterval(heartbeat);
  for (const watcher of watchers) watcher.close();
  try {
    await stopChild();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
  await server?.close();
  // 只删自己的锁：被新实例接管后这里若盲删，会把新持有者的锁一起清掉。
  try {
    if (readDevLock()?.owner?.token === devLockToken) fs.unlinkSync(devLockFile);
  } catch {}
}

acquireDevLock();
const heartbeat = startDevLockHeartbeat();
await sharedBuild();
await build({ root: desktop });
const config = await resolveConfig({ root: desktop }, 'serve', 'development');
const server = await createServer({
  ...config.config.renderer,
  server: { ...config.config.renderer.server, host: '127.0.0.1', port: 5173, strictPort: false },
});
await server.listen();
server.printUrls();
launch();
for (const relative of watched) {
  const target = path.join(repository, relative);
  watchers.push(fs.watch(target, { recursive: fs.statSync(target).isDirectory() }, changed));
}
// SIGHUP 对应终端窗口被关闭：接住信号走同一套清理，避免留下锁与孤儿 Electron 进程。
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => void finish());
