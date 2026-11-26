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
  nativeImage,
  nativeTheme,
  net,
  shell,
  Tray,
  type WebContents,
} from 'electron';
import { Hub, type Peer } from './hub.js';
import { type ClientId, Integrations, type StdioEntry } from './integrations.js';
import { APP_ID, appOrigin, DEFAULT_PORT, HOST } from './security.js';
import { startServer } from './server.js';
import { loadSettings, type Settings, saveSettings } from './settings.js';
import { loadToken, regenerateToken } from './token.js';
import { trayMenu, trayStatus } from './tray.js';

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
const REGISTRY = 'https://freeappstore.online/registry.json';

// Windows start hidden on the theme's paper colour (DESIGN-SYSTEM tokens) and show on first
// paint, so a dark Mac never sees Electron's default white window (#814).
const windowLook = () => ({
  show: false,
  backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f172a' : '#f8fafc',
});
const showWhenPainted = (win: BrowserWindow) => {
  const show = () => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
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
    mcpUrl,
    setupCommand: setupCommand(),
    serverError,
    paused: settings.paused,
    openAtLogin: settings.openAtLogin,
    version: app.getVersion(),
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
  return { paused: settings.paused, openApps: hub.openApps().length, serverError };
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
      trayMenu(current, { open: showHome, setPaused, quit: () => app.quit() }),
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
    if (hidden) app.dock?.hide();
    else createHome();
    app.on('activate', showHome);
  });

  // The app keeps running in the tray with no window open.
  app.on('window-all-closed', () => {});
}
