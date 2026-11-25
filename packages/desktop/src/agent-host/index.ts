import { RpcEndpoint, safeError } from '../shared/rpc.js';
import type { ControlIdentity } from '../shared/transport.js';
import { DesktopHost } from './desktop-host.js';

const parent = process.parentPort;
if (!parent) throw new Error('Utility Host requires Electron parent port');
const forwarded = process.env.KPBL_EXTERNAL_FORWARDED_ENV;
// biome-ignore lint/performance/noDelete: process.env 赋值 undefined 会写入字面字符串。
delete process.env.KPBL_EXTERNAL_FORWARDED_ENV;
const externalHostEnv: NodeJS.ProcessEnv = { ...process.env };
if (forwarded) {
  try {
    const entries: unknown = JSON.parse(forwarded);
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
          Object.defineProperty(externalHostEnv, entry[0], {
            value: entry[1],
            enumerable: true,
            configurable: true,
          });
        }
      }
    }
  } catch {
    // 损坏载荷忽略，代理探测仍会报告缺失的凭据。
  }
}
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
      const service = new DesktopHost(
        data.homeDirectory,
        (notification, lane) => rpc.sendEvent(notification, lane),
        undefined,
        externalHostEnv,
      );
      const rpc: RpcEndpoint = new RpcEndpoint(
        identity,
        (frame) => port.postMessage(frame),
        () => {},
        (method, params, selection) => service.dispatch(method, params, selection),
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
