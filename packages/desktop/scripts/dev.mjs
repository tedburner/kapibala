import { spawn } from 'node:child_process';
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
  child = spawn(executable, [desktop], {
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
  for (const watcher of watchers) watcher.close();
  try {
    await stopChild();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
  await server?.close();
}

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
process.on('SIGINT', () => void finish());
process.on('SIGTERM', () => void finish());
