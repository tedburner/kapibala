import { RpcEndpoint, safeError } from '../shared/rpc.js';
import type { ControlIdentity } from '../shared/transport.js';
import { DesktopHost } from './desktop-host.js';

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
