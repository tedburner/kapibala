import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DEFAULT_LIMITS } from '../protocol/index.js';
import { createStdioTransport } from './stdio.js';
import type { LocalTransport } from './types.js';

/** 仅允许本机 OS 端点，禁止 TCP/URL；pipe 名也必须位于项目命名空间。 */
export type LocalEndpoint = { type: 'unix' | 'pipe'; path: string };

function endpointPath(endpoint: LocalEndpoint): string {
  if (!endpoint || typeof endpoint.path !== 'string') throw new Error('Invalid local endpoint');
  if (
    endpoint.type === 'pipe' &&
    process.platform === 'win32' &&
    /^\\\\\.\\pipe\\kpbl-[a-zA-Z0-9-]+$/.test(endpoint.path)
  )
    return endpoint.path;
  if (
    endpoint.type === 'unix' &&
    process.platform !== 'win32' &&
    path.isAbsolute(endpoint.path) &&
    Buffer.byteLength(endpoint.path) < 100 &&
    !endpoint.path.includes('\0')
  )
    return endpoint.path;
  throw new Error('Invalid local endpoint');
}

/** 监听句柄由 daemon 持有；关闭等待所有连接，不能删除其他实例的端点。 */
export interface LocalListener {
  close(): Promise<void>;
}

/** 不替换现有 socket 或文件；目录权限由宿主在绑定前建立并校验。 */
export async function listenLocalHost(
  endpoint: LocalEndpoint,
  accept: (transport: LocalTransport) => Promise<void>,
): Promise<LocalListener> {
  const address = endpointPath(endpoint);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    if (sockets.size >= DEFAULT_LIMITS.maxConnections) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const transport = createStdioTransport(socket, socket);
    void accept(transport)
      .catch(() => {})
      .finally(() => {
        void transport.close();
        socket.destroy();
      });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onReady);
      reject(error);
    };
    const onReady = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onReady);
    server.listen(address);
  });
  server.on('error', () => {
    /* 启动后的连接错误由各自 transport 管理，不抛入全局。 */
  });
  if (endpoint.type === 'unix') fs.chmodSync(address, 0o600);
  let closing: Promise<void> | undefined;
  return {
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return closing;
    },
  };
}

/** 超时、取消和连接失败均释放 socket；调用者关闭时同时释放底层网络句柄。 */
export async function connectLocal(
  endpoint: LocalEndpoint,
  signal?: AbortSignal,
): Promise<LocalTransport> {
  const address = endpointPath(endpoint);
  if (signal?.aborted) throw new Error('Local connection cancelled');
  const socket = net.createConnection(address);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.off('error', failed);
      socket.off('connect', ready);
    };
    const failed = () => {
      cleanup();
      socket.destroy();
      reject(new Error('Local endpoint unavailable'));
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const abort = () => failed();
    const timer = setTimeout(failed, DEFAULT_LIMITS.initializationTimeoutMs);
    socket.once('connect', ready);
    socket.once('error', failed);
    signal?.addEventListener('abort', abort, { once: true });
  });
  const transport = createStdioTransport(socket, socket);
  return {
    messages: transport.messages,
    send: (message) => transport.send(message),
    async close() {
      await transport.close();
      socket.destroy();
    },
  };
}
