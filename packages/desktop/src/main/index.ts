import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
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
import { RpcEndpoint, safeError } from '../shared/rpc.js';
import { readBuildInfo, testPaths } from './build-info.js';
import { ControlLifetime } from './control-lifetime.js';
import { HostGuard } from './guard.js';
import { NativeNotices } from './native-notices.js';
import { Preferences } from './preferences.js';
import { HostSupervisor } from './supervisor.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
app.setName('Kapibala');
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
const registry = new Map<string, Workspace>();
const surfaces = { light: '#FFFFFF', dark: '#181818' } as const;
const displayMode = () =>
  nativeTheme.shouldUseDarkColors ? ('dark' as const) : ('light' as const);

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
    backend = await supervisor.attach(epoch, (notification) => {
      notices.observe(notification);
      return rpc.sendEvent(notification, notificationLane(notification.type));
    });
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
  const win = new BrowserWindow({
    title: 'Kapibala',
    icon: brandIconFile,
    width: state.width,
    height: state.height,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: surfaces[displayMode()],
    webPreferences: {
      preload: path.join(directory, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      additionalArguments: [`--kpbl-mode=${displayMode()}`],
    },
  });
  window = win;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  // 复制使用标准剪贴板写接口；只放行当前主页面，拒绝读取与所有其它浏览器权限。
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(
      contents === win.webContents &&
        permission === 'clipboard-sanitized-write' &&
        details.isMainFrame &&
        details.requestingUrl === expectedURL &&
        contents.mainFrame.url === expectedURL,
    ),
  );
  win.webContents.session.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      contents === win.webContents &&
      permission === 'clipboard-sanitized-write' &&
      details.isMainFrame &&
      details.requestingUrl === expectedURL &&
      contents.mainFrame.url === expectedURL,
  );
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    const allowedFile = url.startsWith(
      pathToFileURL(path.resolve(directory, '../renderer') + path.sep).href,
    );
    const allowedDevelopment =
      developmentURL &&
      [
        new URL(developmentURL).origin,
        new URL(developmentURL.replace('http:', 'ws:')).origin,
      ].includes(new URL(url).origin);
    callback({
      cancel:
        !allowedFile &&
        !allowedDevelopment &&
        !url.startsWith('devtools://') &&
        !url.startsWith('data:'),
    });
  });
  win.webContents.on('render-process-gone', () => {
    renderer?.peer.close('RENDERER_GONE');
  });
  win.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
    if (mainFrame) renderer?.peer.close('RENDERER_NAVIGATED');
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
  expectedURL = initial.href;
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
        event.senderFrame.url === expectedURL
          ? displayMode()
          : 'light';
    });
    ipcMain.on('kpbl:ready', (event) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== expectedURL ||
        renderer
      )
        return;
      void connect().catch(unavailable);
    });
    nativeTheme.on('updated', () => {
      window?.setBackgroundColor(surfaces[displayMode()]);
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
    createWindow();
    if (!blocked)
      startup = startHost().catch(() => {
        unavailable();
      });
  });
}
