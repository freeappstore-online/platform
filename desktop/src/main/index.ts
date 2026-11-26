import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  net,
  shell,
  type WebContents,
} from 'electron';
import { Hub, type Peer } from './hub.js';
import { APP_ID, appOrigin, DEFAULT_PORT, HOST } from './security.js';
import { startServer } from './server.js';
import { loadToken, regenerateToken } from './token.js';

// Tests and side-by-side dev runs use their own profile and port.
if (process.env.FAS_DESKTOP_USER_DATA) app.setPath('userData', process.env.FAS_DESKTOP_USER_DATA);
const port = Number(process.env.FAS_DESKTOP_PORT) || DEFAULT_PORT;
const dev = !app.isPackaged;
// Dev builds can load every app from a local dev server (e.g. http://localhost:5173).
const devOrigin = dev ? process.env.FAS_DEV_APP_ORIGIN : undefined;
const REGISTRY = 'https://freeappstore.online/registry.json';

const preload = (name: string) => fileURLToPath(new URL(`../preload/${name}.cjs`, import.meta.url));
const hub = new Hub();
let token = '';
let serverError: string | null = null;
let home: BrowserWindow | null = null;
const appWindows = new Map<string, BrowserWindow>();

const mcpUrl = `http://${HOST}:${port}/mcp`;
const setupCommand = () =>
  `claude mcp add --transport http fas ${mcpUrl} --header "Authorization: Bearer ${token}"`;

function state() {
  return {
    mcpUrl,
    setupCommand: setupCommand(),
    serverError,
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
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    title: appId,
    webPreferences: {
      preload: preload('app'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // All app windows share one profile, separate from the home window and the user's browser.
      partition: 'persist:fas-apps',
    },
  });
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
    webPreferences: {
      preload: preload('home'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const contents = home.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event) => {
    event.preventDefault();
    openExternal(event.url);
  });
  home.on('closed', () => {
    home = null;
  });
  void home.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)));
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
ipcMain.handle('home:registry', async (event) => {
  if (!fromHome(event)) return null;
  const response = await net.fetch(REGISTRY);
  if (!response.ok) throw new Error(`registry.json: ${response.status}`);
  return response.json();
});

function pushState() {
  if (home && !home.isDestroyed()) home.webContents.send('home:state', state());
}
hub.on('change', pushState);

// ── Startup ─────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!home) return createHome();
    if (home.isMinimized()) home.restore();
    home.focus();
  });

  app.whenReady().then(async () => {
    token = loadToken(app.getPath('userData'));
    try {
      await startServer({ hub, port, dev, token: () => token, openApp: openAppWindow });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      serverError =
        code === 'EADDRINUSE'
          ? `Port ${port} is in use, so AI clients can't connect. Quit the other program using it and restart FreeAppStore.`
          : `The local MCP server could not start (${code ?? 'unknown error'}).`;
    }
    createHome();
    app.on('activate', () => {
      if (!home) createHome();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
