import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, Method, Notification, Output, Params } from '../shared/contracts.js';
import { RpcEndpoint } from '../shared/rpc.js';

const bootstrapTheme: unknown = ipcRenderer.sendSync('kpbl:bootstrap-theme');
const initialMode = bootstrapTheme === 'dark' ? 'dark' : 'light';
let rpc: RpcEndpoint | undefined;
const listeners = new Set<(event: Notification) => void | Promise<void>>();
let initialFault: Notification | undefined;
let resolveReady!: () => void;
let rejectReady!: (error: Error) => void;
const ready = new Promise<void>((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});
void ready.catch(() => {});
const timeout = setTimeout(() => rejectReady(new Error('Host connection timeout')), 5000);
ipcRenderer.once(
  'kpbl:connected',
  (event, identity: { hostInstanceId: string; controlEpoch: number }) => {
    if (
      !event.ports[0] ||
      typeof identity.hostInstanceId !== 'string' ||
      !Number.isSafeInteger(identity.controlEpoch)
    ) {
      rejectReady(new Error('Invalid host connection'));
      return;
    }
    const port = event.ports[0];
    rpc = new RpcEndpoint(
      identity,
      (frame) => port.postMessage(frame),
      async (notification) => {
        if (!listeners.size) {
          if (notification.type === 'host.unavailable') {
            initialFault = notification;
            return;
          }
          throw new Error('No presentation consumer');
        }
        for (const listener of [...listeners]) await listener(notification);
      },
      undefined,
      () => {
        port.close();
        for (const listener of [...listeners])
          void Promise.resolve(
            listener({
              type: 'host.unavailable',
              error: {
                code: 'HOST_UNAVAILABLE',
                message: '控制连接已断开，正在清理；请核对历史后重新连接。',
              },
            }),
          ).catch(() => {});
      },
    );
    port.onmessage = (message) => {
      void rpc?.peer.receive(message.data);
    };
    port.onmessageerror = () => rpc?.peer.close('INVALID_FRAME');
    window.addEventListener(
      'unload',
      () => {
        rpc?.peer.close();
        port.close();
      },
      { once: true },
    );
    port.start();
    clearTimeout(timeout);
    resolveReady();
  },
);
async function call<M extends Method>(method: M, params: Params<M>): Promise<Output<M>> {
  await ready;
  if (!rpc) throw new Error('Host unavailable');
  return rpc.call(method, params);
}
async function done<M extends Method>(method: M, params: Params<M>): Promise<void> {
  await call(method, params);
}
const api: DesktopAPI = {
  initialTheme: () => initialMode,
  ready: () => ready,
  app: {
    getInfo: () => call('app.getInfo', {}),
    requestQuit: () => done('app.requestQuit', {}),
    reconnect: () => done('app.reconnect', {}),
    reload: () => done('app.reload', {}),
    openExternal: (url) => done('app.openExternal', { url }),
  },
  preferences: {
    read: () => call('preferences.read', {}),
    update: (theme) => done('preferences.update', { theme }),
  },
  workspace: {
    openDefault: () => call('workspace.openDefault', {}),
    pick: () => call('workspace.pick', {}),
    addProject: (params) => call('workspace.addProject', params),
    openRecent: (recentId) => call('workspace.openRecent', { recentId }),
    confirmTrust: (params) => call('workspace.confirmTrust', params),
  },
  settings: {
    read: (workspaceId) => call('settings.read', { workspaceId }),
    previewProfile: (params) => call('settings.previewProfile', params),
    saveProfile: (previewToken, credentialMode) =>
      done('settings.saveProfile', { previewToken, credentialMode }),
    setCredential: (previewToken, key) => done('settings.setCredential', { previewToken, key }),
    setDefault: (profileId) => done('settings.setDefault', { profileId }),
    setRouting: (params) => done('settings.setRouting', params),
  },
  session: {
    runtimeSubscribe: (subscriptionId) => call('session.runtimeSubscribe', { subscriptionId }),
    runtimeUnsubscribe: (subscriptionId) => done('session.runtimeUnsubscribe', { subscriptionId }),
    inspect: (params) => call('session.inspect', params),
    list: (workspaceId, page, query) =>
      call('session.list', { workspaceId, page: page ?? 1, query }),
    create: (workspaceId, profileId) => call('session.create', { workspaceId, profileId }),
    open: (params) => call('session.open', params),
    close: (params) => done('session.close', params),
    configure: (params) => call('session.configure', params),
  },
  run: {
    start: (params) => call('run.start', params),
    cancel: (params) => call('run.cancel', params),
    status: (params) => call('run.status', params),
  },
  approval: { reply: (params) => done('approval.reply', params) },
  presentation: {
    subscribe: (params) => done('presentation.subscribe', params),
    unsubscribe: (params) => done('presentation.unsubscribe', params),
    resync: (params) => done('presentation.resync', params),
    installed: (params) => done('presentation.installed', params),
  },
  onEvent(listener) {
    if (listeners.size >= 16) throw new Error('Subscriber limit');
    listeners.add(listener);
    if (initialFault) void Promise.resolve(listener(initialFault)).catch(() => {});
    return () => {
      listeners.delete(listener);
    };
  },
};
contextBridge.exposeInMainWorld('kapibala', api);
ipcRenderer.send('kpbl:ready');
