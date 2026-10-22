import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 兼容脚本的宿主生命周期：stdio 每次新起一个子进程，socket 复用同一 daemon。
 * 连接失败、连接关闭和宿主退出分开处理；shutdown 只负责回收本模块启动的进程。
 */
export async function startCompatHost({
  hostEntry,
  root,
  home,
  transport,
  runtimeDir,
  clientModule,
}) {
  if (transport !== 'stdio' && transport !== 'socket')
    throw new Error(`Unsupported transport: ${transport}`);
  if (transport === 'socket' && !runtimeDir)
    throw new Error('Socket transport requires runtimeDir');
  const environment = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' };
  const children = new Set();
  const exits = [];
  let stderr = '';
  let daemonMetadata;
  let daemonStarted = false;

  const collect = (child) => {
    children.add(child);
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8_000);
    });
    const exit = new Promise((resolve) => {
      child.on('exit', (code, signal) => {
        children.delete(child);
        const record = { code, signal };
        exits.push(record);
        resolve(record);
      });
    });
    return { child, exit };
  };

  if (transport === 'socket') {
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(runtimeDir, 0o700);
    const started = spawnSync(
      process.execPath,
      [hostEntry, 'daemon', 'start', '--runtime-dir', runtimeDir],
      { cwd: root, env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    if (started.status !== 0)
      throw new Error(
        `Daemon start failed (${started.status ?? started.signal}): ${started.stderr || started.stdout}`,
      );
    daemonMetadata = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'daemon.json'), 'utf8'));
    daemonStarted = true;
  }

  return {
    get stderr() {
      return stderr;
    },
    /** 每个 stdio 连接对应独立宿主；socket 连接共享已启动的 daemon，token 随连接返回。 */
    async connect() {
      if (transport === 'stdio') {
        const { child, exit } = collect(
          spawn(process.execPath, [hostEntry, 'serve', '--stdio'], {
            cwd: root,
            env: environment,
            stdio: ['pipe', 'pipe', 'pipe'],
          }),
        );
        return {
          transport: clientModule.createStdioTransport(child.stdout, child.stdin),
          token: undefined,
          exit,
        };
      }
      if (!daemonMetadata) throw new Error('Daemon is not running');
      return {
        transport: await clientModule.connectLocal(daemonMetadata.endpoint),
        token: daemonMetadata.token,
        exit: null,
      };
    },
    /** 正常路径已由 host/shutdown 收口；失败路径在这里终止残留子进程或 daemon。 */
    async shutdown() {
      const graceful = Date.now() + 3_000;
      while (children.size && Date.now() < graceful) await delay(20);
      for (const child of children) child.kill('SIGTERM');
      const deadline = Date.now() + 10_000;
      while (children.size && Date.now() < deadline) await delay(20);
      for (const child of children) child.kill('SIGKILL');
      let daemonStopped = true;
      if (transport === 'socket') {
        const metadataPath = path.join(runtimeDir, 'daemon.json');
        const natural = Date.now() + 5_000;
        while (fs.existsSync(metadataPath) && Date.now() < natural) await delay(50);
        if (fs.existsSync(metadataPath)) {
          spawnSync(process.execPath, [hostEntry, 'daemon', 'stop', '--runtime-dir', runtimeDir], {
            cwd: root,
            env: environment,
            encoding: 'utf8',
            timeout: 15_000,
          });
          const stopped = Date.now() + 5_000;
          while (fs.existsSync(metadataPath) && Date.now() < stopped) await delay(50);
        }
        if (fs.existsSync(metadataPath)) {
          try {
            process.kill(daemonMetadata.pid, 'SIGKILL');
          } catch {
            // 进程已退出时只剩余元数据。
          }
          await delay(200);
          try {
            fs.rmSync(metadataPath, { force: true });
            fs.rmdirSync(path.join(runtimeDir, 'daemon.lock'));
          } catch {
            // 清理失败保留现场供失败结果定位。
          }
        }
        daemonStopped = !fs.existsSync(metadataPath);
      }
      return { exits, stderr, daemonStopped };
    },
  };
}
