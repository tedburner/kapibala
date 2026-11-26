import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  net,
  BrowserWindow,
  Notification as ElectronNotification,
  Menu,
  MessageChannelMain,
  Tray,
  app,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
} from 'electron';
import {
  type Method,
  type Notification,
  PARAMS,
  ProjectNameSchema,
  type Workspace,
  notificationLane,
} from '../shared/contracts.js';
import { HTML_PREVIEW_LIMIT, PREVIEW_SCHEME } from '../shared/preview.js';
import { RpcEndpoint, safeError } from '../shared/rpc.js';
import { readBuildInfo, testPaths } from './build-info.js';
import { ControlLifetime } from './control-lifetime.js';
import { HostGuard } from './guard.js';
import { NativeNotices } from './native-notices.js';
import { Preferences } from './preferences.js';
import { PreviewDocuments } from './preview-documents.js';
import {
  isAllowedLocalPreviewPath,
  readImageDataUrl,
  resolveLocalImagePath,
} from './preview-file.js';
import { installPreviewProtocol, previewUrl, registerPreviewScheme } from './preview-protocol.js';
import { HostSupervisor } from './supervisor.js';
import { checkForDesktopUpdate } from './update-check.js';
import { downloadUpdate, isTrustedReleaseUrl } from './update-download.js';
import { normalizeMainFrameUrl, normalizeUrl } from './url.js';
import { ensureWindowsBrandIco, resolveWindowsAppId } from './win-icon.js';
import {
  WINDOW_SURFACES,
  resolveWindowChromeOptions,
  titleBarOverlayOptions,
} from './window-chrome.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
app.setName('Kapibala');
// 预览协议必须在 ready 前声明特权，否则拿不到独立来源，沙箱 iframe 会被页面 CSP 拦住。
registerPreviewScheme();
const previews = new PreviewDocuments();
// 品牌图标由构建期从 assets/icon.png 拷到 main 产物同目录（唯一真源仍在 assets/）；
// 开发态 Electron 默认用自身图标，必须在 ready 后显式覆盖 Dock，否则窗口和托盘一眼是「原生 Electron」。
const brandIconFile = path.join(directory, 'icon.png');
function applyBrandIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  const image = nativeImage.createFromPath(brandIconFile);
  if (!image.isEmpty()) app.dock.setIcon(image);
}
app.whenReady().then(applyBrandIcon, () => {});
const buildInfo = readBuildInfo(app.getAppPath(), app.isPackaged);
const isolated = testPaths(buildInfo, {
  enabled: process.env.KPBL_DESKTOP_E2E,
  home: process.env.KPBL_DESKTOP_HOME,
  userData: process.env.KPBL_DESKTOP_USER_DATA,
});
const requestedUserData = app.commandLine.getSwitchValue('user-data-dir');
if (requestedUserData && !path.isAbsolute(requestedUserData))
  throw new Error('USER_DATA_PATH_REQUIRED');
// 同时支持正式构建的标准 Chromium 数据目录参数，安装验收不需要启用专用测试覆盖。
if (isolated || requestedUserData) app.setPath('userData', isolated?.userData ?? requestedUserData);
const windowsAppId = resolveWindowsAppId({
  isPackaged: app.isPackaged,
  isTestIsolation: Boolean(isolated),
});
if (process.platform === 'win32') app.setAppUserModelId(windowsAppId);
const homeDirectory = isolated?.home ?? os.homedir();
const rendererFile = path.resolve(directory, '../renderer/index.html');
const developmentURL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
if (developmentURL && !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/?$/.test(developmentURL))
  throw new Error('Untrusted development URL');
let expectedURL = '';
let startup: Promise<void> = Promise.resolve();
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
const notices = new NativeNotices(
  () => Boolean(window && (!window.isVisible() || !window.isFocused())),
  (title, body, click) => {
    if (!ElectronNotification.isSupported()) return () => {};
    const notification = new ElectronNotification({ title, body, silent: false });
    notification.on('click', click);
    notification.show();
    return () => {
      notification.removeAllListeners();
      notification.close();
    };
  },
  () => {
    window?.show();
    window?.focus();
  },
);
let preferences: Preferences;
let guard: HostGuard;
let supervisor: HostSupervisor | undefined;
let backend: RpcEndpoint | undefined;
let renderer: RpcEndpoint | undefined;
let hostInstanceId = randomUUID();
let controlEpoch = 0;
let quitting = false;
let quitTask: Promise<void> | undefined;
let cleanup = Promise.resolve();
let blocked = false;
/**
 * 最近一次检查到的可下载资产：只保存在主进程，页面无法注入 URL。
 * 每次检查都会整体替换（不再有新版本时清空），下载入口以它为准。
 */
let updateCandidate:
  | {
      installer: { name: string; url: string; size: number };
      checksum: { name: string; url: string };
    }
  | undefined;
/** 在途下载的取消句柄；同一时刻只允许一个下载，避免并发写同一临时文件。 */
let updateDownload: AbortController | undefined;
/** 更新检查结果的进程内短缓存（60s），避免用户连点消耗未认证 GitHub API 的 60 次/小时配额。 */
let cachedUpdateCheck:
  | {
      expiresAt: number;
      result: Awaited<ReturnType<typeof checkForDesktopUpdate>>;
    }
  | undefined;
const registry = new Map<string, Workspace>();
const surfaces = WINDOW_SURFACES;
const displayMode = () =>
  nativeTheme.shouldUseDarkColors ? ('dark' as const) : ('light' as const);

function syncWindowTheme(target: BrowserWindow | undefined): void {
  if (!target || target.isDestroyed()) return;
  const mode = displayMode();
  target.setBackgroundColor(surfaces[mode]);
  if (process.platform === 'win32') {
    target.setTitleBarOverlay(titleBarOverlayOptions(mode));
  }
}

function unavailable(): void {
  notices.reset();
  blocked = true;
  backend = undefined;
  if (renderer)
    void renderer
      .sendEvent(
        { type: 'host.unavailable', error: safeError(new Error('HOST_UNAVAILABLE')) },
        'control',
      )
      .catch(() => {});
}
async function startHost(): Promise<void> {
  hostInstanceId = randomUUID();
  supervisor = new HostSupervisor(
    guard,
    hostInstanceId,
    path.join(directory, 'agent-host.js'),
    homeDirectory,
    unavailable,
  );
  await supervisor.start();
  blocked = false;
}
async function recover(): Promise<void> {
  if (!blocked && supervisor && !supervisor.hasExited()) {
    window?.reload();
    return;
  }
  if (supervisor && !supervisor.hasExited()) throw new Error('RECOVERY_REQUIRED');
  const answer = await dialog.showMessageBox({
    type: 'warning',
    title: '核查上次执行',
    message: '上次执行未确认完成清理',
    detail:
      '请先检查并结束可能残留的工具进程与旧 Agent Host，再确认重新连接。人工确认不代表应用已经自动验证所有后代退出；不会重发上次任务。',
    buttons: ['保持阻断', '已检查，重新连接'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (answer.response !== 1) throw new Error('RECOVERY_REQUIRED');
  guard.recover({ confirmed: true, oldHostExited: !supervisor || supervisor.hasExited() });
  registry.clear();
  await startHost();
  window?.reload();
}
async function requestQuit(): Promise<void> {
  if (quitTask) return quitTask;
  quitTask = (async () => {
    // 退出时中止在途下载，避免进程结束留下未完成的临时文件。
    updateDownload?.abort();
    // blocked 且 Host 已退出 = 既有清理未知场景；shutdown 超时或失败会另行置位。
    let unconfirmed = supervisor ? blocked && supervisor.hasExited() : false;
    if (supervisor && !supervisor.hasExited()) {
      try {
        await supervisor.shutdown();
      } catch {
        // 有界等待超时或清理上报失败都只是「清理结果未知」：不能当成功直接退出，
        // 保留异常栅栏并要求显式确认；迟到的真实退出仍会自行收口 guard。
        unconfirmed = true;
      }
    }
    if (unconfirmed) {
      const answer = await dialog.showMessageBox({
        type: 'warning',
        message: '执行结果未知，退出后仍保留异常记录',
        detail: '无法确认旧工具进程已经退出。再次启动仍需人工核查；本次退出不会清除异常栅栏。',
        buttons: ['返回应用', '保留记录并退出'],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response !== 1) {
        quitTask = undefined;
        return;
      }
    }
    quitting = true;
    notices.reset();
    tray?.destroy();
    tray = undefined;
    renderer?.peer.close();
    window?.destroy();
    app.quit();
  })().catch((error) => {
    quitTask = undefined;
    unavailable();
    void dialog.showMessageBox({
      type: 'error',
      title: '清理未完成',
      message: '无法确认全部工具已经清理，应用仍保留异常退出记录。请核查进程后重试退出。',
      buttons: ['返回应用'],
    });
    throw error;
  });
  return quitTask;
}
async function handle(
  method: Method,
  params: unknown,
  source: RpcEndpoint,
  lifetime: ControlLifetime,
): Promise<unknown> {
  switch (method) {
    // 更新检查只由用户动作触发：不做启动时自动联网，也不进入宿主子进程。
    // 任何网络 / 响应异常都在 update-check 内降级为 unknown，不抛出到这里。
    case 'app.checkUpdate': {
      const now = Date.now();
      const result =
        cachedUpdateCheck && cachedUpdateCheck.expiresAt > now
          ? cachedUpdateCheck.result
          : await checkForDesktopUpdate({
              currentVersion: app.getVersion(),
              platform: process.platform,
              arch: process.arch,
              fetch: (url, init) => net.fetch(url, init),
            });
      if (
        result.status !== 'unknown' &&
        (!cachedUpdateCheck || cachedUpdateCheck.expiresAt <= now)
      ) {
        cachedUpdateCheck = { expiresAt: now + 60_000, result };
      }
      // 只有安装包与摘要清单齐全时才登记下载候选；其余状态清空旧候选，
      // 避免页面拿着过期的「有新版本」结果去下载已被撤下的资产。
      updateCandidate =
        result.status === 'update-available' && result.installer && result.checksum
          ? { installer: result.installer, checksum: result.checksum }
          : undefined;
      return result;
    }
    // 下载入口不带参数：URL 只来自主进程登记的检查结果，渲染层无法指定下载地址。
    case 'app.downloadUpdate': {
      if (!updateCandidate) return { status: 'failed', reason: 'NO_UPDATE_STATE' };
      if (updateDownload) return { status: 'failed', reason: 'DOWNLOAD_IN_PROGRESS' };
      const candidate = updateCandidate;
      if (
        !isTrustedReleaseUrl(candidate.installer.url) ||
        !isTrustedReleaseUrl(candidate.checksum.url)
      )
        return { status: 'failed', reason: 'UNTRUSTED_SOURCE' };
      const controller = new AbortController();
      updateDownload = controller;
      let lastProgress = 0;
      try {
        const result = await downloadUpdate({
          installer: candidate.installer,
          checksum: candidate.checksum,
          directory: app.getPath('downloads'),
          fetch: (url, init) => net.fetch(url, init),
          signal: controller.signal,
          onProgress: (downloaded, total, final) => {
            // 进度只是展示反馈：节流到 5 次/秒；末帧（final 或已知 total 满额）必定发送，total=0 时也不截断末帧。
            const now = Date.now();
            const isComplete = Boolean(final) || (total > 0 && downloaded === total);
            if (!isComplete && now - lastProgress < 200) return;
            lastProgress = now;
            void source
              .sendEvent({ type: 'update.downloadProgress', downloaded, total }, 'control')
              .catch(() => {});
          },
        });
        if (result.status !== 'downloaded') return result;
        if (controller.signal.aborted || quitting) return { status: 'cancelled' };
        // 只有摘要严格一致且未取消/未退出时才打开安装包，由安装程序提示手动安装。
        const openError = await shell.openPath(result.filePath);
        return { status: 'downloaded', filePath: result.filePath, opened: openError === '' };
      } finally {
        if (updateDownload === controller) updateDownload = undefined;
      }
    }
    case 'app.cancelUpdateDownload':
      updateDownload?.abort();
      return {};
    case 'app.getInfo':
      return {
        name: 'Kapibala',
        version: app.getVersion(),
        testBuild: ['development', 'test'].includes(buildInfo.kind),
        hostInstanceId,
        controlEpoch,
        platform: process.platform,
        runtimes: {
          electron: process.versions.electron,
          node: process.versions.node,
          chrome: process.versions.chrome,
        },
        notifications: ElectronNotification.isSupported(),
        tray: Boolean(tray),
      };
    case 'app.requestQuit':
      setImmediate(() => {
        void requestQuit().catch(() => {});
      });
      return {};
    case 'app.reconnect':
      setImmediate(() => {
        void recover().catch(() => {});
      });
      return {};
    case 'app.reload':
      // 恢复界面专用：webContents.reload() 是程序化导航，不受 will-navigate 拦截影响；
      // 只重载当前已校验的页面，不打开新窗口或其它 URL。
      window?.webContents.reload();
      return {};
    case 'app.openExternal': {
      const { url } = PARAMS[method].parse(params);
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        throw new Error('FORBIDDEN');
      await shell.openExternal(parsed.href);
      return {};
    }
    case 'preferences.read': {
      const state = preferences.read();
      return {
        theme: state.theme,
        mode: displayMode(),
        recent: state.recent.map(({ id, name, root }) => ({
          id,
          name,
          parent: path.dirname(root),
        })),
      };
    }
    case 'preferences.update': {
      const { theme } = PARAMS[method].parse(params);
      preferences.theme(theme);
      nativeTheme.themeSource = theme;
      syncWindowTheme(window);
      return {};
    }
  }
  if (!backend || blocked)
    throw new Error(blocked && !supervisor ? 'RECOVERY_REQUIRED' : 'HOST_UNAVAILABLE');
  const targetBackend = backend;
  let selection: string | undefined;
  if (method === 'workspace.pick') {
    const picked = await dialog.showOpenDialog(window!, {
      title: '选择项目目录',
      properties: ['openDirectory'],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    selection = picked.filePaths[0];
  } else if (method === 'workspace.openRecent') {
    const { recentId } = PARAMS[method].parse(params);
    selection = preferences.read().recent.find((item) => item.id === recentId)?.root;
    if (!selection) throw new Error('WORKSPACE_NOT_FOUND');
  }
  const scope = params as { workspaceId?: string };
  if (scope.workspaceId && !registry.has(scope.workspaceId)) throw new Error('FORBIDDEN');
  if (renderer !== source || backend !== targetBackend || blocked)
    throw new Error('HOST_UNAVAILABLE');
  const resourceCurrent = () => backend === targetBackend && !blocked;
  const result = await lifetime.wait(
    () => targetBackend.call(method, params as never, selection),
    resourceCurrent,
  );
  if (
    [
      'workspace.openDefault',
      'workspace.addProject',
      'workspace.pick',
      'workspace.openRecent',
      'workspace.confirmTrust',
    ].includes(method) &&
    result
  ) {
    let workspace = result as Workspace;
    if (workspace.kind === 'project') {
      const previous = preferences.read().recent.find((item) => item.root === workspace.root);
      const alias = ProjectNameSchema.safeParse(previous?.name);
      if (method !== 'workspace.addProject' && alias.success) {
        if (workspace.trusted && method !== 'workspace.pick')
          workspace = (await lifetime.wait(
            () =>
              targetBackend.call('workspace.addProject', {
                workspaceId: workspace.id,
                name: alias.data,
                trustToken: workspace.trustToken,
                acceptTrust: false,
              }),
            resourceCurrent,
          )) as Workspace;
        else workspace.name = alias.data;
      }
      if (method !== 'workspace.pick' && workspace.trusted)
        preferences.recent(workspace.root, workspace.name);
      workspace.recentId = preferences
        .read()
        .recent.find((item) => item.root === workspace.root)?.id;
    }
    guard.register({ id: workspace.id, root: workspace.root });
    registry.set(workspace.id, workspace);
    return workspace;
  }
  if (method === 'session.create' || method === 'session.open')
    notices.open((result as { sessionId: string }).sessionId);
  if (method === 'session.close') notices.close((params as { sessionId: string }).sessionId);
  if (
    method === 'external.subscribe' ||
    method === 'external.prompt' ||
    method === 'external.setConfig' ||
    method === 'external.approve' ||
    method === 'external.cancel' ||
    method === 'external.close' ||
    method === 'external.delete'
  ) {
    notices.dismissExternal((params as { sessionId: string }).sessionId);
  }
  return result;
}
async function connect(): Promise<void> {
  await startup;
  await cleanup;
  if (!window || window.isDestroyed()) return;
  registry.clear();
  notices.reset();
  const epoch = ++controlEpoch;
  const { port1, port2 } = new MessageChannelMain();
  const targetWindow = window;
  const lifetime = new ControlLifetime(
    () => renderer === rpc && !blocked,
    () => notices.reset(),
  );
  const rpc: RpcEndpoint = new RpcEndpoint(
    { hostInstanceId, controlEpoch: epoch },
    (frame) => port1.postMessage(frame),
    () => {},
    (method, params) => {
      if (renderer !== rpc) throw new Error('HOST_UNAVAILABLE');
      return handle(method, params, rpc, lifetime);
    },
    () => {
      port1.close();
      if (renderer === rpc) {
        lifetime.detach();
        renderer = undefined;
        cleanup =
          supervisor?.detach().catch(() => {
            unavailable();
            throw new Error('SESSION_CLEANUP_FAILED');
          }) ?? Promise.resolve();
        void cleanup.catch(() => {});
      }
    },
  );
  renderer = rpc;
  if (supervisor && !blocked)
    try {
      backend = await supervisor.attach(epoch, async (notification) => {
        notices.observe(notification);
        if (renderer !== rpc) return;
        try {
          await rpc.sendEvent(notification, notificationLane(notification.type));
        } catch {
          // 渲染层通道断开或接收拥塞只关闭当前页面连接，不得冒泡给 supervisor 误触发 Host INVALID_PAYLOAD 熔断。
          rpc.peer.close('OUTPUT_CONGESTED');
        }
      });
    } catch {
      // attach 失败（握手超时、Host 退出）不能吞掉连接投递：不发 kpbl:connected，renderer 的
      // ready 会永远等待，故障又被 post 到从未转移的端口直接丢失——安装副本 smoke 曾因此
      // 静默挂起到自身超时。这里置位 blocked 后继续交付端口与故障，让 renderer 立即失败
      // 并显示原因；后续业务 RPC 按 HOST_UNAVAILABLE 拒绝，恢复走既有 blocked 流程。
      unavailable();
    }
  else if (blocked)
    // 启动失败通常发生在 renderer 建链之前，当时的 unavailable 通知没有投递对象；
    // 这里补发给新附加的控制连接，让 renderer 立即失败并显示原因，而不是干等到自身兜底超时。
    void rpc
      .sendEvent(
        { type: 'host.unavailable', error: safeError(new Error('HOST_UNAVAILABLE')) },
        'control',
      )
      .catch(() => {});
  port1.on('message', (event) => {
    if (renderer === rpc && window === targetWindow && !targetWindow.isDestroyed())
      void rpc.peer.receive(event.data);
  });
  port1.on('close', () => rpc.peer.close());
  port1.start();
  targetWindow.webContents.postMessage('kpbl:connected', { hostInstanceId, controlEpoch: epoch }, [
    port2,
  ]);
  if (blocked)
    void rpc
      .sendEvent(
        { type: 'host.unavailable', error: safeError(new Error('RECOVERY_REQUIRED')) },
        'control',
      )
      .catch(() => {});
}
function createWindow(): void {
  const state = preferences.read();
  nativeTheme.themeSource = state.theme;
  const windowsIconFile =
    process.platform === 'win32'
      ? ensureWindowsBrandIco(brandIconFile, app.getPath('userData'), (file) =>
          nativeImage.createFromPath(file),
        )
      : undefined;
  const mode = displayMode();
  const chrome = resolveWindowChromeOptions(process.platform, mode);
  const win = new BrowserWindow({
    title: 'Kapibala',
    icon: windowsIconFile ?? brandIconFile,
    width: state.width,
    height: state.height,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: surfaces[mode],
    ...chrome.browserWindow,
    webPreferences: {
      preload: path.join(directory, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      additionalArguments: [`--kpbl-mode=${mode}`],
    },
  });
  if (chrome.hideMenuBar) win.setMenuBarVisibility(false);
  window = win;
  if (process.platform === 'win32' && windowsIconFile) {
    // 显式为 HWND 写入独立 AppUserModelID 与多分辨率 .ico RelaunchIconResource，
    // 否则 Windows 10/11 任务栏在开发态会沿用 electron.exe 内嵌的黑色原子图标。
    win.setAppDetails({
      appId: windowsAppId,
      appIconPath: windowsIconFile,
      appIconIndex: 0,
      relaunchDisplayName: 'Kapibala',
    });
    win.setIcon(windowsIconFile);
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  // 复制使用标准剪贴板写接口；只放行当前主页面，拒绝读取与所有其它浏览器权限。
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(
      contents === win.webContents &&
        permission === 'clipboard-sanitized-write' &&
        details.isMainFrame &&
        normalizeMainFrameUrl(details.requestingUrl) === expectedURL &&
        normalizeMainFrameUrl(contents.mainFrame.url) === expectedURL,
    ),
  );
  win.webContents.session.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      contents === win.webContents &&
      permission === 'clipboard-sanitized-write' &&
      details.isMainFrame &&
      normalizeMainFrameUrl(details.requestingUrl ?? '') === expectedURL &&
      normalizeMainFrameUrl(contents.mainFrame.url) === expectedURL,
  );
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const url = normalizeUrl(details.url);
    const allowedFile = url.startsWith(
      normalizeUrl(pathToFileURL(path.resolve(directory, '../renderer') + path.sep).href),
    );
    const allowedDevelopment =
      developmentURL &&
      [
        new URL(developmentURL).origin,
        new URL(developmentURL.replace('http:', 'ws:')).origin,
      ].includes(new URL(url).origin);
    // 预览文档走独立协议；不在白名单里会被这里统一取消，表现为 iframe 空白。
    const allowedPreview = url.startsWith(`${PREVIEW_SCHEME}:`);
    // 消息正文里的远程图片是唯一放行的外部子资源：只认 image 类型与 http(s)，
    // 脚本、样式、字体等请求继续被取消，避免把页面网络的缺口一起打开。
    const allowedRemoteImage = details.resourceType === 'image' && /^https?:\/\//i.test(url);
    callback({
      cancel:
        !allowedFile &&
        !allowedDevelopment &&
        !allowedPreview &&
        !allowedRemoteImage &&
        !url.startsWith('devtools://') &&
        !url.startsWith('data:'),
    });
  });
  win.webContents.on('render-process-gone', () => {
    renderer?.peer.close('RENDERER_GONE');
  });
  win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    // 页内锚点跳转（inPlace = true）不改变物理文档与安全上下文，只有真实跨页导航才关闭控制通道。
    if (mainFrame && !inPlace) renderer?.peer.close('RENDERER_NAVIGATED');
  });
  win.on('ready-to-show', () => win.show());
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    // Linux 无法仅凭 Tray 对象确认桌面确实展示入口，关窗保留原生退出确认。
    if (process.platform === 'darwin' || (process.platform === 'win32' && tray)) win.hide();
    else
      void dialog
        .showMessageBox(win, {
          type: 'question',
          message: '退出前将停止任务并等待清理',
          buttons: ['取消', '停止并退出'],
          defaultId: 0,
          cancelId: 0,
        })
        .then((answer) => {
          if (answer.response === 1) void requestQuit().catch(() => {});
        });
  });
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  win.on('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const [width, height] = win.getSize();
      preferences.bounds(width, height);
    }, 150);
  });
  win.on('closed', () => {
    clearTimeout(resizeTimer);
    if (window === win) window = undefined;
  });
  const initial = new URL(developmentURL ?? pathToFileURL(rendererFile).href);
  initial.searchParams.set('mode', displayMode());
  // 与 Chromium 回读的帧 URL 对齐：pathToFileURL 会把 8.3 短名里的 ~ 编码成 %7E，
  // 帧 URL 却保留字面 ~；两侧统一规范化后再做字面比较（见 url.ts）。
  expectedURL = normalizeUrl(initial.href);
  if (developmentURL) void win.loadURL(expectedURL);
  else void win.loadFile(rendererFile, { query: { mode: displayMode() } });
}

if (!app.isPackaged && process.send && process.env.KPBL_DESKTOP_DEV_TOKEN) {
  process.on('message', (message: unknown) => {
    const command = message as { kind?: string; token?: string };
    if (command?.kind === 'kpbl:dev-stop' && command.token === process.env.KPBL_DESKTOP_DEV_TOKEN)
      void requestQuit().catch(() => {});
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  app.on('before-quit', (event) => {
    if (!quitting) {
      event.preventDefault();
      void requestQuit().catch(() => {});
    }
  });
  app.on('activate', () => {
    if (window) window.show();
    else createWindow();
  });
  void app.whenReady().then(async () => {
    preferences = new Preferences(app.getPath('userData'));
    guard = new HostGuard(app.getPath('userData'));
    blocked = guard.inspect().blocked;
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Kapibala',
          submenu: [
            {
              label: '重新连接',
              click: () => {
                void recover().catch(() => {});
              },
            },
            {
              label: '退出 Kapibala',
              accelerator: 'CmdOrCtrl+Q',
              click: () => {
                void requestQuit().catch(() => {});
              },
            },
          ],
        },
        { role: 'editMenu', label: '编辑' },
        { role: 'viewMenu', label: '视图' },
      ]),
    );
    // 首帧同步读取已在内存中的主题枚举；不读取配置，不开放通用同步 RPC。
    ipcMain.on('kpbl:bootstrap-theme', (event) => {
      event.returnValue =
        window &&
        event.sender === window.webContents &&
        event.senderFrame === window.webContents.mainFrame &&
        normalizeMainFrameUrl(event.senderFrame.url) === expectedURL
          ? displayMode()
          : 'light';
    });
    ipcMain.on('kpbl:ready', (event) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        normalizeMainFrameUrl(event.senderFrame.url) !== expectedURL ||
        renderer
      )
        return;
      void connect().catch(unavailable);
    });
    // 预览只接受来自当前主页面的登记请求：其它帧/来源一律拒绝，避免把任意内容塞进协议表。
    ipcMain.handle('kpbl:preview', (event, html: unknown) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        normalizeMainFrameUrl(event.senderFrame?.url ?? '') !== expectedURL
      )
        throw new Error('FORBIDDEN');
      if (typeof html !== 'string' || html.length > HTML_PREVIEW_LIMIT)
        throw new Error('PREVIEW_INVALID');
      return previewUrl(previews.publish(html));
    });
    // 本地图片预览只接受来自当前主页面的读取请求，且严格限制在已登记工作区与系统临时目录内（硬排除 ~/.kapibala 凭据区）。
    ipcMain.handle('kpbl:preview-file', async (event, params: unknown) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        normalizeMainFrameUrl(event.senderFrame?.url ?? '') !== expectedURL
      )
        throw new Error('FORBIDDEN');
      if (typeof params !== 'object' || params === null) throw new Error('PREVIEW_INVALID');
      const { path: rawPath, root } = params as { path?: unknown; root?: unknown };
      if (typeof rawPath !== 'string' || (root !== undefined && typeof root !== 'string'))
        throw new Error('PREVIEW_INVALID');
      const workspaceRoots = [...registry.values()].map((item) => item.root);
      if (
        root !== undefined &&
        !isAllowedLocalPreviewPath(root, { workspaceRoots, homeDirectory })
      ) {
        throw new Error('FORBIDDEN');
      }
      const target = resolveLocalImagePath(rawPath, root);
      if (!target) throw new Error('PREVIEW_INVALID');
      if (!isAllowedLocalPreviewPath(target, { workspaceRoots, homeDirectory }))
        throw new Error('FORBIDDEN');
      return readImageDataUrl(target);
    });
    nativeTheme.on('updated', () => {
      syncWindowTheme(window);
      if (renderer)
        void renderer
          .sendEvent({ type: 'theme.changed', mode: displayMode() }, 'control')
          .catch(() => {});
    });
    if (process.platform !== 'darwin') {
      try {
        tray = new Tray(
          nativeImage.createFromPath(brandIconFile).resize({ width: 20, height: 20 }),
        );
        tray.setToolTip('Kapibala');
        tray.setContextMenu(
          Menu.buildFromTemplate([
            {
              label: '显示 Kapibala',
              click: () => {
                window?.show();
                window?.focus();
              },
            },
            {
              label: '停止任务并退出',
              click: () => {
                void requestQuit().catch(() => {});
              },
            },
          ]),
        );
        tray.on('click', () => {
          window?.show();
          window?.focus();
        });
      } catch {
        tray = undefined;
      }
    }
    installPreviewProtocol(previews);
    createWindow();
    if (!blocked)
      startup = startHost().catch(() => {
        unavailable();
      });
  });
}
