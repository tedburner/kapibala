import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { LocalClient, type LocalClientOptions } from '../client/index.js';
import { type LocalEndpoint, connectLocal, listenLocalHost } from '../transport/socket.js';
import { createResourceFactory } from './resources.js';
import { LocalHostServer } from './server.js';

/** 凭证文件只供本机宿主读取，任何面向用户的 status 都不得包含 token。 */
export interface DaemonMetadata {
  token: string;
  nonce: string;
  pid: number;
  serverInstanceId: string;
  endpoint: LocalEndpoint;
}

/** 公共状态不携带凭证，PID 只展示，不用于确认身份或杀进程。 */
export type DaemonState = 'running' | 'absent' | 'stale_lock' | 'invalid_metadata' | 'unreachable';

export interface DaemonStatus {
  running: boolean;
  /** 可操作状态；stale_lock/invalid_metadata/unreachable 需要人工确认后清理。 */
  state: DaemonState;
  serverInstanceId?: string;
  pid?: number;
  /** 子进程 stderr 日志位置；只含路径，不读取或回显内容。 */
  logPath?: string;
}

/** 可注入隔离目录/构建入口以做真实进程验收；不修改进程 HOME 或 cwd。 */
export interface DaemonOptions {
  runtimeDir?: string;
  homeDir?: string;
  entryPath?: string;
}

function runtimeFiles(root: string): { metadata: string; lock: string; log: string } {
  return {
    metadata: path.join(root, 'daemon.json'),
    lock: path.join(root, 'daemon.lock'),
    log: path.join(root, 'daemon.log'),
  };
}

/** 只删除 nonce 仍属于本次启动的元数据与锁，防止误删并行实例。 */
function removeDaemonRuntime(root: string, nonce: string): void {
  const files = runtimeFiles(root);
  let owned = false;
  try {
    owned = readDaemonMetadata(root).nonce === nonce;
  } catch {
    owned = false;
  }
  if (!owned) return;
  try {
    fs.unlinkSync(files.metadata);
  } catch {
    return;
  }
  try {
    fs.rmdirSync(files.lock);
  } catch {
    /* 锁可能已被其它实例接管；元数据已删，残留交由 status 诊断。 */
  }
}

/** 私有短目录避免 Unix socket 长度限制；拒绝替换符号链接或其他用户的目录。 */
export function getLocalRuntimeDirectory(override?: string): string {
  const digest = createHash('sha256').update(os.homedir()).digest('hex').slice(0, 16);
  const root =
    override ??
    path.join(
      process.platform === 'win32' ? os.tmpdir() : '/tmp',
      `kpbl-${process.getuid?.() ?? 'user'}-${digest}`,
    );
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Unsafe local runtime directory');
  if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
  return fs.realpathSync.native(root);
}

/** 校验所有凭证元数据后才允许建立连接，不回显文件内容或原始解析错误。 */
export function readDaemonMetadata(runtimeDir: string): DaemonMetadata {
  try {
    const file = path.join(runtimeDir, 'daemon.json');
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 8192 ||
      (process.platform !== 'win32' &&
        ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))
    )
      throw new Error();
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      !value ||
      typeof value.token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.token) ||
      typeof value.nonce !== 'string' ||
      !/^[a-f0-9]{32}$/.test(value.nonce) ||
      !Number.isSafeInteger(value.pid) ||
      value.pid < 0 ||
      typeof value.serverInstanceId !== 'string' ||
      !value.endpoint ||
      !['unix', 'pipe'].includes(value.endpoint.type) ||
      typeof value.endpoint.path !== 'string'
    )
      throw new Error();
    return value;
  } catch {
    throw new Error('Invalid local daemon metadata');
  }
}

/** 连接与 ping 只使用同一元数据快照；被更新的启动占位值或旧实例不得被新连接证实为健康。 */
async function connectDaemonSnapshot(
  metadata: DaemonMetadata,
  clientOptions: LocalClientOptions = {},
): Promise<LocalClient> {
  const transport = await connectLocal(metadata.endpoint);
  const client = await LocalClient.connect(
    transport,
    {
      major: 1,
      minMinor: 0,
      maxMinor: 0,
      clientName: 'kpbl',
      capabilities: [],
      token: metadata.token,
    },
    clientOptions,
  );
  try {
    const status = await client.call('ping', {});
    if (
      !status ||
      typeof status !== 'object' ||
      Array.isArray(status) ||
      status.serverInstanceId !== metadata.serverInstanceId
    )
      throw new Error('Daemon instance mismatch');
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

/** 仅从受控私有文件取得凭证；握手与 ping 的实例身份必须和单次文件快照一致。 */
export async function connectDaemon(
  options: DaemonOptions = {},
  clientOptions: LocalClientOptions = {},
): Promise<LocalClient> {
  const metadata = readDaemonMetadata(getLocalRuntimeDirectory(options.runtimeDir));
  return connectDaemonSnapshot(metadata, clientOptions);
}

/** 报告可操作状态；无法连接时不通过 PID 猜测健康或自动清除陈旧记录。 */
export async function getDaemonStatus(options: DaemonOptions = {}): Promise<DaemonStatus> {
  const root = getLocalRuntimeDirectory(options.runtimeDir);
  const files = runtimeFiles(root);
  let metadata: DaemonMetadata;
  try {
    metadata = readDaemonMetadata(root);
  } catch {
    if (fs.existsSync(files.lock))
      return { running: false, state: 'stale_lock', logPath: files.log };
    if (fs.existsSync(files.metadata))
      return { running: false, state: 'invalid_metadata', logPath: files.log };
    return { running: false, state: 'absent', logPath: files.log };
  }
  let client: LocalClient | undefined;
  try {
    client = await connectDaemonSnapshot(metadata);
    return {
      running: true,
      state: 'running',
      serverInstanceId: metadata.serverInstanceId,
      pid: metadata.pid,
      logPath: files.log,
    };
  } catch {
    return {
      running: false,
      state: 'unreachable',
      serverInstanceId: metadata.serverInstanceId,
      pid: metadata.pid,
      logPath: files.log,
    };
  } finally {
    await client?.close();
  }
}

/** 原子启动锁不自动按 PID 回收；无法确认旧实例时安全失败，避免误删活跃 socket。 */
export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonStatus> {
  const root = getLocalRuntimeDirectory(options.runtimeDir);
  const files = runtimeFiles(root);
  const current = await getDaemonStatus({ ...options, runtimeDir: root });
  if (current.running) return current;
  if (current.state === 'unreachable') {
    // 上一实例可能仍在清理 listener/元数据；短暂等待，超时后要求人工确认。
    for (let attempt = 0; attempt < 20; attempt++) {
      await delay(100);
      const status = await getDaemonStatus({ ...options, runtimeDir: root });
      if (status.running) return status;
      if (status.state === 'absent') break;
    }
    const latest = await getDaemonStatus({ ...options, runtimeDir: root });
    if (!latest.running && latest.state !== 'absent')
      throw new Error(
        `Daemon runtime is unreachable at ${root}; inspect status and log before removing stale files`,
      );
  } else if (current.state === 'stale_lock') {
    throw new Error(`Daemon lock exists without valid metadata at ${files.lock}`);
  } else if (current.state === 'invalid_metadata') {
    throw new Error(
      `Daemon metadata is invalid at ${files.metadata}; confirm no daemon is running`,
    );
  }
  try {
    fs.mkdirSync(files.lock, { mode: 0o700 });
  } catch {
    throw new Error(
      `Daemon lock exists at ${files.lock}; inspect status before removing stale files`,
    );
  }
  const endpoint: LocalEndpoint =
    process.platform === 'win32'
      ? {
          type: 'pipe',
          path: `\\\\.\\pipe\\kpbl-${createHash('sha256').update(root).digest('hex').slice(0, 24)}`,
        }
      : { type: 'unix', path: path.join(root, 'host.sock') };
  const metadata: DaemonMetadata = {
    endpoint,
    token: randomBytes(32).toString('hex'),
    nonce: randomBytes(16).toString('hex'),
    pid: 0,
    serverInstanceId: '',
  };
  // wx 避免覆盖不属于本次实例的文件；存在陈旧文件时不猜测其所有权。
  try {
    fs.writeFileSync(files.metadata, JSON.stringify(metadata), {
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    try {
      fs.rmdirSync(files.lock);
    } catch {
      /* 已被并行实例接管。 */
    }
    throw error;
  }
  const entryPath = options.entryPath ?? fileURLToPath(new URL('./bin.js', import.meta.url));
  // stderr 落到私有日志，启动失败时可诊断；凭证仍然只存在于 0600 元数据文件。
  const logFd = fs.openSync(files.log, 'a', 0o600);
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(files.log, 0o600);
    } catch {
      /* 权限收紧失败不阻断启动，元数据仍受 0600 保护。 */
    }
  }
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      process.execPath,
      [entryPath, 'serve', '--local-daemon-child', '--runtime-dir', root],
      {
        stdio: ['ignore', 'ignore', logFd],
        detached: true,
        windowsHide: true,
        env: { ...process.env, ...(options.homeDir ? { KPBL_LOCAL_HOME: options.homeDir } : {}) },
      },
    );
  } catch (error) {
    fs.closeSync(logFd);
    removeDaemonRuntime(root, metadata.nonce);
    throw error;
  }
  fs.closeSync(logFd);
  let exited = false;
  let failed = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  child.once('error', () => {
    failed = true;
  });
  child.once('exit', (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
  });
  child.unref();
  for (let attempt = 0; attempt < 50; attempt++) {
    if (failed || exited) break;
    await delay(100);
    const status = await getDaemonStatus({ ...options, runtimeDir: root });
    if (status.running) return status;
  }
  // 只请求终止本次创建且尚未退出的 ChildProcess，不按元数据 PID 发送信号。
  if (!exited && !failed) child.kill('SIGTERM');
  for (let attempt = 0; attempt < 20 && !exited && !failed; attempt++) await delay(50);
  const retained = !exited && !failed;
  const reason = failed
    ? 'spawn failed'
    : exited
      ? `exited (code=${exitCode ?? 'null'}${exitSignal ? `, signal=${exitSignal}` : ''})`
      : 'did not become healthy';
  if (!retained) removeDaemonRuntime(root, metadata.nonce);
  throw new Error(
    `Daemon ${reason}; see ${files.log}${retained ? `; runtime retained at ${root}` : ''}`,
  );
}

/** 停止通过已认证实例发出，不使用 PID kill；等待元数据清理后才返回。 */
export async function stopDaemon(options: DaemonOptions = {}): Promise<void> {
  const root = getLocalRuntimeDirectory(options.runtimeDir);
  const files = runtimeFiles(root);
  const metadata = readDaemonMetadata(root);
  const client = await connectDaemonSnapshot(metadata);
  try {
    await client.call('host/shutdown', {});
  } finally {
    await client.close();
  }
  // 响应只表示资源清理完成；继续等待 listener/元数据/锁收尾，避免紧随其后的 start 撞残留锁。
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    let current: DaemonMetadata | undefined;
    try {
      current = readDaemonMetadata(root);
    } catch {
      current = undefined;
    }
    // 新实例已接管：旧实例的停止目标已经达成，不再等待它清理。
    if (current && current.nonce !== metadata.nonce) return;
    if (!current && !fs.existsSync(files.lock)) return;
    await delay(50);
  }
  throw new Error(`Daemon stopped but runtime files remain at ${root}`);
}

/** 子进程生命周期入口；凭证从私有文件读取，未作为 argv 或日志传递。 */
export async function runDaemon(runtimeDir: string): Promise<void> {
  const root = getLocalRuntimeDirectory(runtimeDir);
  const bootstrap = readDaemonMetadata(root);
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const host = new LocalHostServer({
    ...createResourceFactory({ homeDir: process.env.KPBL_LOCAL_HOME }),
    homeDir: process.env.KPBL_LOCAL_HOME,
    token: bootstrap.token,
    onShutdown: stop,
  });
  const listener = await listenLocalHost(bootstrap.endpoint, (transport) => host.accept(transport));
  const files = runtimeFiles(root);
  const metadata = {
    ...bootstrap,
    pid: process.pid,
    serverInstanceId: host.registry.serverInstanceId,
  };
  fs.writeFileSync(files.metadata, JSON.stringify(metadata), { mode: 0o600 });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let failure: unknown;
  try {
    await stopped;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    // 无论资源清理是否成功都释放监听端点；失败时保留元数据供诊断。
    try {
      await host.shutdown();
    } catch (error) {
      failure ??= error;
    }
    try {
      await listener.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure === undefined) removeDaemonRuntime(root, bootstrap.nonce);
  }
  if (failure !== undefined) throw failure;
}
