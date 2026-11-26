import { arch, cpus, type as osType, release } from 'node:os';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type NativeImage,
  nativeImage,
  nativeTheme,
  net,
  powerMonitor,
  shell,
  Tray,
  type WebContents,
} from 'electron';
import { Contribute, contributeStatus, type Engine, RelayWorker } from './contribute.js';
import {
  API_ORIGIN,
  deleteDeviceToken,
  fetchProfile,
  loadDeviceToken,
  type Profile,
  pairDevice,
  saveDeviceToken,
  unpairDevice,
} from './device.js';
import { type HistoryItem, keepAudio, loadHistory, readAudio, saveHistory } from './history.js';
import { Hub, type Peer } from './hub.js';
import { type ClientId, Integrations, type StdioEntry } from './integrations.js';
import { APP_ID, appOrigin, DEFAULT_PORT, HOST } from './security.js';
import { startServer } from './server.js';
import { loadSettings, type Settings, saveSettings } from './settings.js';
import { loadToken, regenerateToken } from './token.js';
import { trayMenu, trayStatus } from './tray.js';
import { loadBuildInfo, releaseNotesUrl, versionLabel } from './version.js';

// Tests and side-by-side dev runs use their own profile and port.
const userDataOverride = process.env.FAS_DESKTOP_USER_DATA;
if (userDataOverride) app.setPath('userData', userDataOverride);
const port = Number(process.env.FAS_DESKTOP_PORT) || DEFAULT_PORT;
const dev = !app.isPackaged;
// Open at login is registered for the real install only: never for dev builds or for a test or
// side-by-side profile (FAS_DESKTOP_USER_DATA), which would leave a login item pointing at a copy.
const manageLoginItem = app.isPackaged && !userDataOverride;
// Dev builds can load every app from a local dev server (e.g. http://localhost:5173).
const devOrigin = dev ? process.env.FAS_DEV_APP_ORIGIN : undefined;
// Dev builds can point Contribute at a local API (the e2e test's stand-in).
const apiOrigin = (dev && process.env.FAS_DEV_API_ORIGIN) || API_ORIGIN;
const REGISTRY = 'https://freeappstore.online/registry.json';
// "0.3.0 (57, abc1234)": package.json's version with the build number and commit (#832).
const version = versionLabel(
  app.getVersion(),
  loadBuildInfo(fileURLToPath(new URL('../build-info.json', import.meta.url))),
);

// Windows start hidden on the theme's paper colour (DESIGN-SYSTEM tokens) and show on first
// paint, so a dark Mac never sees Electron's default white window (#814).
const windowLook = () => ({
  show: false,
  backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f172a' : '#f8fafc',
});
const showWhenPainted = (win: BrowserWindow) => {
  let shown = false;
  // Once only: the fallback must not bring back a window the user already closed
  const show = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    if (!win.isVisible()) win.show();
  };
  win.once('ready-to-show', show);
  // A slow or failing network load still gets a window, on the dark/light paper colour.
  setTimeout(show, 3000);
};

const preload = (name: string) => fileURLToPath(new URL(`../preload/${name}.cjs`, import.meta.url));
const asset = (name: string) => fileURLToPath(new URL(`../../assets/${name}`, import.meta.url));
const hub = new Hub();
let token = '';
let serverError: string | null = null;
let home: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: Settings;
let integrations: Integrations;
/** Set once the user really quits (tray Quit, Cmd+Q); until then closing a window only hides it. */
let quitting = false;
const appWindows = new Map<string, BrowserWindow>();

const mcpUrl = `http://${HOST}:${port}/mcp`;
const setupCommand = () =>
  `claude mcp add --transport http freeappstore-desktop ${mcpUrl} --header "Authorization: Bearer ${token}"`;

/**
 * How AI clients launch the stdio entry (#815): this app's own binary in node mode running
 * dist/stdio/main.mjs, which electron-builder unpacks from the asar archive (a plain file that
 * node mode can run). Overrides the app runs with are passed on, so the proxy finds the same
 * profile and port. Holds no token.
 */
function stdioEntry(): StdioEntry {
  const script = fileURLToPath(new URL('../stdio/main.mjs', import.meta.url)).replace(
    `${sep}app.asar${sep}`,
    `${sep}app.asar.unpacked${sep}`,
  );
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' };
  if (userDataOverride) env.FAS_DESKTOP_USER_DATA = app.getPath('userData');
  if (port !== DEFAULT_PORT) env.FAS_DESKTOP_PORT = String(port);
  // A dev build's binary is plain Electron: the proxy must name the app directory to start it.
  if (dev) env.FAS_DESKTOP_APP_PATH = app.getAppPath();
  return { command: process.execPath, args: [script], env };
}

function state() {
  return {
    contribute: contributeState(),
    profile,
    mcpUrl,
    setupCommand: setupCommand(),
    serverError,
    paused: settings.paused,
    openAtLogin: settings.openAtLogin,
    version,
    releaseNotes: releaseNotesUrl(app.getVersion()),
    openApps: hub.openApps(),
    log: hub.log,
  };
}

const isHttp = (url: string) => /^https?:\/\//i.test(url);
const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};
function openExternal(url: string) {
  if (isHttp(url)) void shell.openExternal(url);
}

// ── App windows ─────────────────────────────────────────────────

function openAppWindow(appId: string): void {
  const existing = appWindows.get(appId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }
  const origin = appOrigin(appId, devOrigin);
  void app.dock?.show();
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    title: appId,
    ...windowLook(),
    webPreferences: {
      preload: preload('app'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // All app windows share one profile, separate from the home window and the user's browser.
      partition: 'persist:fas-apps',
    },
  });
  showWhenPainted(win);
  appWindows.set(appId, win);
  const contents = win.webContents;
  const peerId = `desktop:${contents.id}`;
  const sameOrigin = (url: string) => originOf(url) === origin;

  // Navigation stays on the app's origin; anything else opens in the system browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) void contents.loadURL(url);
    else openExternal(url);
    return { action: 'deny' };
  });
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (sameOrigin(url)) return;
    event.preventDefault();
    openExternal(url);
  };
  contents.on('will-navigate', (event) => guard(event, event.url));
  contents.on('will-redirect', (event) => guard(event, event.url));
  // A reload or navigation drops the old page's tools; the new page registers again.
  contents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) hub.disconnect(peerId);
  });
  contents.on('render-process-gone', () => hub.disconnect(peerId));
  win.on('closed', () => {
    hub.disconnect(peerId);
    if (appWindows.get(appId) === win) appWindows.delete(appId);
    updateDock();
  });
  void win.loadURL(`${origin}/`);
}

/** The bridge peer for an app window: its app id comes from the window, never from the page. */
function windowPeer(contents: WebContents, appId: string): Peer {
  return {
    id: `desktop:${contents.id}`,
    source: 'desktop',
    send: (text) => contents.send('bridge:message', text),
    reject: () => hub.disconnect(`desktop:${contents.id}`),
    resolveAppId: () => ({ appId }),
  };
}

ipcMain.on('bridge:send', (event: IpcMainEvent, text: unknown) => {
  if (typeof text !== 'string') return;
  const win = BrowserWindow.fromWebContents(event.sender);
  const entry = [...appWindows].find(([, w]) => w === win);
  if (!entry) return;
  const [appId] = entry;
  // Only the window's top frame, while it is on the app's own origin, may use the bridge.
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return;
  if (originOf(frame.url) !== appOrigin(appId, devOrigin)) return;
  hub.receive(windowPeer(event.sender, appId), text);
});

// ── Home window ─────────────────────────────────────────────────

function createHome(): void {
  home = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 420,
    minHeight: 480,
    title: 'FreeAppStore',
    ...windowLook(),
    webPreferences: {
      preload: preload('home'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  showWhenPainted(home);
  const contents = home.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event) => {
    event.preventDefault();
    openExternal(event.url);
  });
  // Closing the window only hides it: the app keeps running in the menu bar (tray) and keeps
  // serving AI clients. Quit from the tray or with Cmd+Q.
  home.on('close', (event) => {
    if (quitting || !home) return;
    event.preventDefault();
    home.hide();
    updateDock();
  });
  home.on('closed', () => {
    home = null;
  });
  void home.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)));
}

function showHome(): void {
  void app.dock?.show();
  if (!home) {
    createHome();
    return;
  }
  if (home.isMinimized()) home.restore();
  home.show();
  home.focus();
}

/** macOS: a dock icon only while a window is showing; otherwise the app lives in the menu bar. */
function updateDock(): void {
  if (!app.dock || quitting) return;
  if (BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible())) return;
  app.dock.hide();
}

// ── Pause, open at login, tray ──────────────────────────────────

function setPaused(paused: boolean): void {
  settings.paused = paused;
  saveSettings(app.getPath('userData'), settings);
  pushState();
}

function applyLoginItem(): void {
  // `args` is for Windows; macOS reports a login launch through wasOpenedAtLogin.
  if (manageLoginItem)
    app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, args: ['--hidden'] });
}

function trayState() {
  return {
    paused: settings.paused,
    openApps: hub.openApps().length,
    serverError,
    contribute: deviceToken
      ? { status: contributeStatus(contribute.state), paused: settings.contributePaused }
      : null,
    account: profile ? { name: profile.user.name, icon: avatarIcon } : null,
  };
}

function createTray(): void {
  // macOS: a monochrome template image (from brand/assets/mark-mono.svg) that follows the menu
  // bar's appearance; elsewhere the colour icon.
  const icon = nativeImage.createFromPath(
    asset(process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'),
  );
  tray = new Tray(icon);
  // Windows and Linux open the app on click; macOS shows the menu.
  if (process.platform !== 'darwin') tray.on('click', showHome);
  updateTray();
}

function updateTray(): void {
  if (!tray) return;
  const current = trayState();
  tray.setToolTip(trayStatus(current));
  tray.setContextMenu(
    Menu.buildFromTemplate(
      trayMenu(current, {
        open: showHome,
        setPaused,
        setContributePaused,
        quit: () => app.quit(),
      }),
    ),
  );
}

const fromHome = (event: IpcMainInvokeEvent) => home !== null && event.sender === home.webContents;

ipcMain.handle('home:state', (event) => (fromHome(event) ? state() : null));
ipcMain.handle('home:open-app', (event, appId: unknown) => {
  if (fromHome(event) && typeof appId === 'string' && APP_ID.test(appId)) openAppWindow(appId);
});
ipcMain.handle('home:copy-setup', (event) => {
  if (fromHome(event)) clipboard.writeText(setupCommand());
});
ipcMain.handle('home:regenerate-token', async (event) => {
  if (!fromHome(event) || !home) return;
  const { response } = await dialog.showMessageBox(home, {
    type: 'warning',
    buttons: ['Regenerate', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Regenerate the MCP token?',
    detail: 'AI clients set up with the current token stop working until you add them again.',
  });
  if (response !== 0) return;
  token = regenerateToken(app.getPath('userData'));
  pushState();
});
ipcMain.handle('home:set-paused', (event, paused: unknown) => {
  if (fromHome(event) && typeof paused === 'boolean') setPaused(paused);
});
ipcMain.handle('home:set-open-at-login', (event, open: unknown) => {
  if (!fromHome(event) || typeof open !== 'boolean') return;
  settings.openAtLogin = open;
  saveSettings(app.getPath('userData'), settings);
  applyLoginItem();
  pushState();
});
const isClient = (id: unknown): id is ClientId => id === 'claude-code' || id === 'claude-desktop';
ipcMain.handle('home:clients', (event) => (fromHome(event) ? integrations.status() : null));
ipcMain.handle('home:connect', async (event, id: unknown, connect: unknown) => {
  if (!fromHome(event) || !isClient(id)) return null;
  await (connect === false ? integrations.disconnect(id) : integrations.connect(id));
  return integrations.status();
});
ipcMain.handle('home:registry', async (event) => {
  if (!fromHome(event)) return null;
  const response = await net.fetch(REGISTRY);
  if (!response.ok) throw new Error(`registry.json: ${response.status}`);
  return response.json();
});

function pushState() {
  if (home && !home.isDestroyed()) home.webContents.send('home:state', state());
  updateTray();
}
hub.on('change', pushState);

// ── Contribute (#826) ───────────────────────────────────────────

let deviceToken: string | null = null;
let pairing: AbortController | null = null;
let pairError: string | null = null;
/** The hidden window that hosts the model worker; created when Contribute first needs it. */
let engineWindow: BrowserWindow | null = null;
let engineReady: Promise<Engine> | null = null;
let relay: RelayWorker | null = null;
let modelDeleted: (() => void) | null = null;
let history: HistoryItem[] | null = null;
const contribute = new Contribute(
  {
    token: () => deviceToken,
    optedIn: () => settings.contributeApps,
    paused: () => settings.contributePaused,
    modelReady: () => settings.contributeModel,
    setModelReady: (ready) => saveContribute({ contributeModel: ready }),
    engine: () => {
      engineWindowContents();
      return engineReady!;
    },
    createWorker: () => {
      const contents = engineWindowContents();
      relay = new RelayWorker((message) => {
        if (!contents.isDestroyed()) contents.send('contribute:to-worker', message);
      });
      return relay;
    },
    deleteModel: () =>
      new Promise<void>((resolve) => {
        modelDeleted = resolve;
        engineWindowContents().send('contribute:to-worker', { type: 'delete-model' });
      }),
    signedOut,
    changed: () => pushState(),
    probe: () => {
      const metrics = app.getAppMetrics();
      return {
        cpuMs: Math.round(metrics.reduce((n, m) => n + (m.cpu.cumulativeCPUUsage ?? 0), 0) * 1000),
        memMb: metrics.reduce((n, m) => n + m.memory.workingSetSize, 0) / 1024,
        charging: !powerMonitor.isOnBatteryPower(),
        ...(process.platform === 'darwin' && { thermal: powerMonitor.getCurrentThermalState() }),
        foreground: !!home && !home.isDestroyed() && home.isVisible() && home.isFocused(),
      };
    },
    context: () => ({
      appVersion: version,
      os: `${osType()} ${release()}`,
      device: `${cpus()[0]?.model ?? 'unknown CPU'} ${arch()}`,
    }),
    history: () => historyItems(),
    setHistory: (items) => {
      history = saveHistory(app.getPath('userData'), items);
    },
    keepAudio: async (appId, jobId, result) =>
      keepAudio(
        app.getPath('userData'),
        appId,
        jobId,
        new Uint8Array(await result.file.arrayBuffer()),
        result.meta,
      ),
  },
  apiOrigin,
);

/** This computer's Contribute history (#827), read from userData once. */
function historyItems(): HistoryItem[] {
  if (!history) history = loadHistory(app.getPath('userData'));
  return history;
}

function contributeState() {
  return {
    ...contribute.state,
    connected: deviceToken !== null,
    pairing: pairing !== null,
    pairError,
    optedIn: settings.contributeApps,
    paused: settings.contributePaused,
  };
}

/**
 * The hidden window's contents: no throttling, since it does the work while every other window
 * is closed. It loads the SDK's runner page from disk and reports this computer's encoder,
 * WebGPU or WebAssembly, and whether the model is cached.
 */
function engineWindowContents(): WebContents {
  if (engineWindow && !engineWindow.isDestroyed()) return engineWindow.webContents;
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: preload('contribute'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  engineWindow = win;
  const contents = win.webContents;
  engineReady = new Promise<Engine>((resolve) => {
    ipcMain.removeAllListeners('contribute:engine');
    ipcMain.on('contribute:engine', (event, engine: Engine) => {
      if (event.sender === contents) resolve(engine);
    });
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  // A crashed renderer takes the job in hand with it: stop, and start over on the next look
  contents.on('render-process-gone', () => {
    contribute.stop();
    win.destroy();
  });
  win.on('closed', () => {
    if (engineWindow === win) engineWindow = null;
  });
  void win.loadFile(fileURLToPath(new URL('../renderer/contribute.html', import.meta.url)));
  return contents;
}

ipcMain.on('contribute:from-worker', (event, message: { type?: string }) => {
  if (!engineWindow || event.sender !== engineWindow.webContents) return;
  if (message?.type === 'model-deleted') {
    modelDeleted?.();
    modelDeleted = null;
  } else relay?.receive(message);
});

function saveContribute(changes: Partial<Settings>) {
  Object.assign(settings, changes);
  saveSettings(app.getPath('userData'), settings);
  pushState();
}

function setContributePaused(paused: boolean) {
  saveContribute({ contributePaused: paused });
  contribute.wake();
}

const deviceLabel = () =>
  `FreeAppStore desktop (${
    { darwin: 'Mac', win32: 'Windows', linux: 'Linux' }[process.platform as string] ??
    process.platform
  })`;

async function connectDevice() {
  if (pairing || deviceToken) return;
  pairing = new AbortController();
  pairError = null;
  pushState();
  try {
    const token = await pairDevice({
      label: deviceLabel(),
      open: openExternal,
      signal: pairing.signal,
      api: `${apiOrigin}/v1`,
    });
    saveDeviceToken(app.getPath('userData'), token);
    deviceToken = token;
  } catch (error) {
    if (!pairing.signal.aborted) pairError = (error as Error).message;
  } finally {
    pairing = null;
    pushState();
  }
  if (deviceToken) {
    contribute.wake();
    void refreshProfile();
  }
}

function signedOut() {
  disconnectDevice(false);
  pairError = 'This computer’s connection expired or was removed. Connect it again.';
  pushState();
}

// ── Profile (#829): the signed-in account, in memory only ───────

/** `avatar` is a data: URL (the home window's CSP allows no remote images). */
let profile: (Profile & { avatar: string | null }) | null = null;
let avatarIcon: NativeImage | null = null;

async function refreshProfile() {
  const token = deviceToken;
  if (!token) return;
  try {
    const next = await fetchProfile(token, `${apiOrigin}/v1`);
    if (token !== deviceToken) return;
    if (!next) return signedOut();
    let avatar: string | null = null;
    let icon: NativeImage | null = null;
    if (next.user.avatarUrl?.startsWith('https://')) {
      const response = await net.fetch(next.user.avatarUrl).catch(() => null);
      const image = response?.ok
        ? nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()))
        : null;
      if (image && !image.isEmpty()) {
        avatar = image.resize({ width: 96, height: 96 }).toDataURL();
        icon = image.resize({ width: 16, height: 16 });
      }
    }
    if (token !== deviceToken) return;
    profile = { ...next, avatar };
    avatarIcon = icon;
    pushState();
  } catch {
    // Offline or the API is down: keep what is shown, the next start or connect tries again.
  }
}

function disconnectDevice(revoke: boolean) {
  profile = null;
  avatarIcon = null;
  if (deviceToken && revoke) void unpairDevice(deviceToken, `${apiOrigin}/v1`);
  deleteDeviceToken(app.getPath('userData'));
  deviceToken = null;
  contribute.stop();
  contribute.wake(); // ends the loop's wait
  engineWindow?.destroy();
}

ipcMain.handle('home:contribute-history', (event) => (fromHome(event) ? historyItems() : []));
ipcMain.handle('home:contribute-audio', (event, appId: unknown, jobId: unknown) => {
  if (!fromHome(event) || typeof appId !== 'string' || typeof jobId !== 'string') return null;
  if (!APP_ID.test(appId) || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) return null;
  return readAudio(app.getPath('userData'), appId, jobId);
});
ipcMain.handle('home:contribute-connect', (event) => {
  if (fromHome(event)) void connectDevice();
});
ipcMain.handle('home:contribute-cancel', (event) => {
  if (fromHome(event)) pairing?.abort();
});
ipcMain.handle('home:contribute-disconnect', (event) => {
  if (!fromHome(event)) return;
  disconnectDevice(true);
  pushState();
});
ipcMain.handle('home:contribute-opt-in', (event, appId: unknown, on: unknown) => {
  if (!fromHome(event) || typeof appId !== 'string' || !APP_ID.test(appId)) return;
  const apps = settings.contributeApps.filter((id) => id !== appId);
  saveContribute({ contributeApps: on === true ? [...apps, appId] : apps });
  contribute.wake();
});
ipcMain.handle('home:contribute-paused', (event, paused: unknown) => {
  if (fromHome(event) && typeof paused === 'boolean') setContributePaused(paused);
});
ipcMain.handle('home:contribute-download', (event) => {
  if (fromHome(event) && deviceToken) void contribute.downloadModel();
});
ipcMain.handle('home:contribute-delete-model', async (event) => {
  if (fromHome(event) && deviceToken) await contribute.deleteModel();
});
ipcMain.handle('home:contribute-refresh', (event) => {
  if (fromHome(event)) contribute.wake();
});

// ── Startup ─────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Opening the app again (Finder, Start menu, the stdio proxy) shows the running one.
  app.on('second-instance', (_event, argv) => {
    if (!argv.includes('--hidden')) showHome();
  });
  app.on('before-quit', () => {
    quitting = true;
    contribute.stop();
  });

  app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    const loaded = loadSettings(userData);
    settings = loaded.settings;
    if (loaded.firstRun) {
      saveSettings(userData, settings);
      applyLoginItem();
    }
    // Started at login or by an AI client's stdio proxy: run in the background, no window.
    const hidden =
      process.argv.includes('--hidden') ||
      (manageLoginItem &&
        process.platform === 'darwin' &&
        app.getLoginItemSettings().wasOpenedAtLogin);
    integrations = new Integrations({
      entry: stdioEntry(),
      appData: app.getPath('appData'),
      home: app.getPath('home'),
    });
    token = loadToken(userData);
    deviceToken = loadDeviceToken(userData);
    try {
      await startServer({
        hub,
        port,
        dev,
        token: () => token,
        openApp: openAppWindow,
        paused: () => settings.paused,
        version: app.getVersion(),
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      serverError =
        code === 'EADDRINUSE'
          ? `Port ${port} is in use, so AI clients can't connect. Quit the other program using it and restart FreeAppStore.`
          : `The local MCP server could not start (${code ?? 'unknown error'}).`;
    }
    createTray();
    if (deviceToken) {
      contribute.wake();
      void refreshProfile();
    }
    if (hidden) app.dock?.hide();
    else createHome();
    app.on('activate', showHome);
  });

  // The app keeps running in the tray with no window open.
  app.on('window-all-closed', () => {});
}
