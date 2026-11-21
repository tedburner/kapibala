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
// 冷启动窗口给主进程留足余量：要 spawn agent-host 子进程并完成工作区初始化才能回传握手。
// 本兜底只封顶「连接端口始终未投递也没有任何故障」的病态情形；真实失败由主进程随连接端口
// 投递 host.unavailable（见 main 的 connect()），到达后立即终止 ready 等待，不拖到这里。
// 注意：Windows CI 安装副本 smoke 的稳定失败并非启动慢，而是 8.3 短名里的 ~ 被 pathToFileURL
// 编码成 %7E、与 Chromium 帧 URL 的字面 ~ 不等，kpbl:ready 守卫静默拒绝、连接端口永不投递
// （见 main/url.ts 的 normalizeUrl）；放宽超时不是该失败的修复。
const timeout = setTimeout(() => rejectReady(new Error('Host connection timeout')), 90000);
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
        if (notification.type === 'host.unavailable') {
          initialFault = notification;
          // 连接前的故障必须终止 ready 等待，且不能因监听者在场而豁免：ViewClient 在模块
          // 顶层就订阅事件，故障到达时监听者恒在场，旧的「仅无监听者才 reject」分支实际
          // 从未生效，挂起的 RPC（如安装副本 smoke 的 getInfo）只能干等到兜底超时。
          // ready 已解析时 reject 是空操作；连接后的故障仍照常经 RPC 错误上报。
          rejectReady(new Error(notification.error.message));
        }
        if (!listeners.size) {
          // 尚无展示消费者：故障留待 onEvent 订阅时重放，其它事件无人消费即协议错误。
          if (notification.type === 'host.unavailable') return;
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
    checkUpdate: () => call('app.checkUpdate', {}),
    downloadUpdate: () => call('app.downloadUpdate', {}),
    cancelUpdateDownload: () => done('app.cancelUpdateDownload', {}),
    requestQuit: () => done('app.requestQuit', {}),
    reconnect: () => done('app.reconnect', {}),
    reload: () => done('app.reload', {}),
    openExternal: (url) => done('app.openExternal', { url }),
  },
  preview: {
    // 预览内容不进 RPC 协议：只走主进程的短期登记表，返回独立来源地址给沙箱 iframe。
    url: (html) => ipcRenderer.invoke('kpbl:preview', html) as Promise<string>,
    // 本地图片同理：主进程按白名单扩展整读后回 data URL，渲染层不接触文件系统。
    file: (params) => ipcRenderer.invoke('kpbl:preview-file', params) as Promise<string>,
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
    listFiles: (workspaceId) => call('workspace.listFiles', { workspaceId }),
  },
  settings: {
    read: (workspaceId) => call('settings.read', { workspaceId }),
    saveProfile: (params) => call('settings.saveProfile', params),
    listModels: (params) => call('settings.listModels', params),
    setDefault: (profileId) => done('settings.setDefault', { profileId }),
    setPermissionMode: (mode) => done('settings.setPermissionMode', { mode }),
    setEnabled: (params) => done('settings.setEnabled', params),
    deleteProfile: (profileId) => done('settings.deleteProfile', { profileId }),
    testProfile: (profileId) => call('settings.testProfile', { profileId }),
    setRouting: (params) => done('settings.setRouting', params),
  },
  resources: {
    readMcp: (workspaceId) => call('resources.readMcp', { workspaceId }),
    saveMcpServer: (params) => call('resources.saveMcpServer', params),
    deleteMcpServer: (params) => call('resources.deleteMcpServer', params),
    toggleMcpServer: (params) => call('resources.toggleMcpServer', params),
    approveMcpServer: (params) => call('resources.approveMcpServer', params),
    revokeMcpServer: (params) => call('resources.revokeMcpServer', params),
    inspectMcpImport: (params) => call('resources.inspectMcpImport', params),
    importMcp: (params) => call('resources.importMcp', params),
    readSkills: (workspaceId) => call('resources.readSkills', { workspaceId }),
    setSkillsEnabled: (params) => call('resources.setSkillsEnabled', params),
    setSkillDisabled: (params) => call('resources.setSkillDisabled', params),
    inspectSkills: (workspaceId) => call('resources.inspectSkills', { workspaceId }),
    importSkills: (params) => call('resources.importSkills', params),
  },
  session: {
    runtimeSubscribe: (subscriptionId) => call('session.runtimeSubscribe', { subscriptionId }),
    runtimeUnsubscribe: (subscriptionId) => done('session.runtimeUnsubscribe', { subscriptionId }),
    inspect: (params) => call('session.inspect', params),
    list: (workspaceId, page, query) =>
      call('session.list', { workspaceId, page: page ?? 1, query }),
    archived: (workspaceId, page) => call('session.archived', { workspaceId, page: page ?? 1 }),
    create: (workspaceId, profileId) => call('session.create', { workspaceId, profileId }),
    open: (params) => call('session.open', params),
    close: (params) => done('session.close', params),
    archive: (params) => done('session.archive', params),
    restore: (params) => done('session.restore', params),
    delete: (params) => done('session.delete', params),
    configure: (params) => call('session.configure', params),
    rename: (params) => done('session.rename', params),
    pin: (params) => done('session.pin', params),
  },
  run: {
    start: (params) => call('run.start', params),
    cancel: (params) => call('run.cancel', params),
    status: (params) => call('run.status', params),
    command: (params) => call('run.command', params),
    commandList: () => call('run.commandList', {}),
    skillCatalog: (params) => call('run.skillCatalog', params),
  },
  approval: { reply: (params) => done('approval.reply', params) },
  interaction: { reply: (params) => done('interaction.reply', params) },
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
