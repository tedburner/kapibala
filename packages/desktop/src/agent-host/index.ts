import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RpcEndpoint, safeError } from '../shared/rpc.js';
import type { ControlIdentity } from '../shared/transport.js';
import { DesktopHost } from './desktop-host.js';

// TEMP-DIAG: 间歇性 INTERNAL_ERROR 排查用，把被 safeError 折叠前的真实错误落盘；定位后删除。
function diagRpcError(method: string, error: unknown): void {
  if (!process.env.KPBL_DESKTOP_E2E) return;
  try {
    const e = error as { name?: string; code?: string; message?: string; stack?: string };
    const file = process.env.KPBL_DIAG_FILE ?? path.join(os.tmpdir(), 'kpbl-rpc-diag.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        t: Date.now(),
        layer: 'host',
        method,
        name: e?.name,
        code: e?.code,
        message: String(e?.message),
        stack: String(e?.stack).slice(0, 3000),
      })}\n`,
    );
  } catch {
    /* 诊断失败不影响业务错误回传。 */
  }
}

const parent = process.parentPort;
if (!parent) throw new Error('Utility Host requires Electron parent port');
let current:
  | { epoch: number; service: DesktopHost; rpc: RpcEndpoint; cleanup?: Promise<void> }
  | undefined;
let cleaned = false;

async function cleanup(epoch = current?.epoch): Promise<void> {
  const control = current;
  if (control?.epoch !== epoch) return;
  if (!control) return;
  control.cleanup ??= control.service.disconnect().catch((error) => {
    // 失败保留资源所有者，显式退出可重试尚未完成的清理步骤。
    control.cleanup = undefined;
    throw error;
  });
  await control.cleanup;
  control.rpc.peer.close();
  if (current === control) current = undefined;
}
parent.on('message', (event) => {
  const data = event.data as {
    kind?: string;
    hostInstanceId?: string;
    controlEpoch?: number;
    homeDirectory?: string;
  };
  if (
    data?.kind === 'attach' &&
    typeof data.hostInstanceId === 'string' &&
    Number.isSafeInteger(data.controlEpoch) &&
    typeof data.homeDirectory === 'string' &&
    event.ports.length === 1
  ) {
    if (current || cleaned) {
      parent.postMessage({ kind: 'host.attachFailed', controlEpoch: data.controlEpoch });
      return;
    }
    const port = event.ports[0];
    const identity: ControlIdentity = {
      hostInstanceId: data.hostInstanceId,
      controlEpoch: data.controlEpoch!,
    };
    try {
      const service = new DesktopHost(data.homeDirectory, (notification, lane) =>
        rpc.sendEvent(notification, lane),
      );
      const rpc: RpcEndpoint = new RpcEndpoint(
        identity,
        (frame) => port.postMessage(frame),
        () => {},
        (method, params, selection) => {
          // TEMP-DIAG: 记录真实错误后原样重抛，不改变 safeError 的对外折叠行为；定位后删除。
          try {
            const result = service.dispatch(method, params, selection);
            return result.catch((error: unknown) => {
              diagRpcError(method, error);
              throw error;
            });
          } catch (error) {
            diagRpcError(method, error);
            throw error;
          }
        },
        () => {
          port.close();
          void cleanup(identity.controlEpoch).then(
            () =>
              parent.postMessage({
                kind: 'host.detached',
                controlEpoch: identity.controlEpoch,
                ok: true,
              }),
            () =>
              parent.postMessage({
                kind: 'host.detached',
                controlEpoch: identity.controlEpoch,
                ok: false,
              }),
          );
        },
        true,
      );
      current = { epoch: identity.controlEpoch, service, rpc };
      port.on('message', (message) => {
        void rpc.peer.receive(message.data);
      });
      port.on('close', () => rpc.peer.close());
      port.start();
      parent.postMessage({ kind: 'host.connected', controlEpoch: identity.controlEpoch });
    } catch {
      port.close();
      parent.postMessage({ kind: 'host.attachFailed', controlEpoch: identity.controlEpoch });
    }
  } else if (data?.kind === 'detach') {
    void cleanup(data.controlEpoch).then(
      () =>
        parent.postMessage({ kind: 'host.detached', controlEpoch: data.controlEpoch, ok: true }),
      () =>
        parent.postMessage({ kind: 'host.detached', controlEpoch: data.controlEpoch, ok: false }),
    );
  } else if (data?.kind === 'shutdown') {
    void cleanup().then(
      () => {
        cleaned = true;
        parent.postMessage({ kind: 'host.cleaned' });
      },
      (error) => parent.postMessage({ kind: 'host.cleanupFailed', error: safeError(error) }),
    );
  } else if (data?.kind === 'exit' && cleaned) process.exit(0);
});
parent.postMessage({ kind: 'host.ready' });
