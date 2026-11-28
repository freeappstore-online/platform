import { rm } from 'node:fs/promises';
import { arch, cpus, type as osType, release } from 'node:os';
import { join, sep } from 'node:path';
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
  session,
  shell,
  Tray,
  utilityProcess,
  type WebContents,
} from 'electron';
import electronUpdater from 'electron-updater';
import { loadActivity, saveActivity } from './activity.js';
import { contributeWhen, cpuThreads, IDLE_SECONDS } from './conditions.js';
import { Contribute, contributeStatus, type Engine } from './contribute.js';
import {
  API_ORIGIN,
  clientHeaders,
  createPairCode,
  deleteDeviceToken,
  fetchBacklog,
  fetchProfile,
  loadDeviceToken,
  type Profile,
  pairDevice,
  saveDeviceToken,
  unpairDevice,
} from './device.js';
import { EncoderRelay, type EncoderReply, type TtsPort, TtsProcess } from './engine.js';
import {
  clearHistory,
  type HistoryItem,
  keepAudio,
  loadHistory,
  readAudio,
  saveHistory,
  saveRecord,
} from './history.js';
import { Hub, type Peer } from './hub.js';
import { type ClientId, Integrations, type StdioEntry } from './integrations.js';
import { NativeRunner } from './kokoro.js';
import { modelInstalled } from './model.js';
import { installPermissions } from './permissions.js';
import { Publisher } from './publish.js';
import { APP_ID, appOrigin, DEFAULT_PORT, HOST } from './security.js';
import { startServer } from './server.js';
import { loadSettings, type Settings, saveSettings } from './settings.js';
import { loadToken, regenerateToken } from './token.js';
import { type TrayContributeMode, trayMenu, trayStatus } from './tray.js';
import { Updates } from './updates.js';
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
const VOTES = 'https://api.freeappstore.online/v1/store/votes';
const RELEASES = 'freeappstore-online/platform/releases';
// "0.3.0 (57, abc1234)": package.json's version with the build number and commit (#832).
const version = versionLabel(
  app.getVersion(),
  loadBuildInfo(fileURLToPath(new URL('../build-info.json', import.meta.url))),
);
/** Sent with pairing and every call with the device credential (#833). */
const headers = clientHeaders(version);

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
let activityError: string | null = null;
let activityReadable = true;
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
    updates: {
      ...updates.state,
      auto: settings.autoUpdate,
      supported: app.isPackaged && !process.windowsStore,
      storeManaged: Boolean(process.windowsStore),
    },
    store: { recent: settings.recentApps, favorites: settings.favoriteApps },
    publish: publisher.state,
    openApps: hub.openApps(),
    log: hub.log,
    activityError,
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
  // The Store's Recent row (#840): the latest dozen, kept on this computer only.
  settings.recentApps = [appId, ...settings.recentApps.filter((id) => id !== appId)].slice(0, 12);
  saveSettings(app.getPath('userData'), settings);
  pushState();
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
  // Store packages use Windows' startup controls rather than a mutable executable registration.
  if (process.windowsStore) return;
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
      ? { status: contributeStatus(contribute.state), mode: contributeMode() }
      : null,
    account: profile ? { name: profile.user.name, icon: avatarIcon } : null,
    update:
      updates.state.version &&
      (updates.state.status === 'ready' || updates.state.status === 'manual')
        ? { version: updates.state.version, ready: updates.state.status === 'ready' }
        : null,
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
        setContributeMode,
        update: applyUpdate,
        quit: () => app.quit(),
      }),
    ),
  );
}

const fromHome = (event: IpcMainInvokeEvent) =>
  home !== null &&
  event.sender === home.webContents &&
  event.senderFrame === home.webContents.mainFrame;

ipcMain.handle('home:clear-activity', (event) => {
  if (!fromHome(event)) return;
  activityReadable = true;
  hub.clearLog();
});

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
  const [response, votes] = await Promise.all([
    net.fetch(REGISTRY, { signal: AbortSignal.timeout(20_000) }),
    // Votes only order Most popular (#834): the Store still loads without them.
    net
      .fetch(VOTES, { signal: AbortSignal.timeout(20_000) })
      .then((r) => (r.ok ? r.json() : {}))
      .then((body: { votes?: Record<string, number> }) => body.votes ?? {})
      .catch(() => ({})),
  ]);
  if (!response.ok) throw new Error(`registry.json: ${response.status}`);
  const { apps } = (await response.json()) as { apps: unknown[] };
  return { apps, votes };
});

ipcMain.handle('home:set-favorite', (event, appId: unknown, on: unknown) => {
  if (!fromHome(event) || typeof appId !== 'string' || !APP_ID.test(appId)) return;
  const favorites = settings.favoriteApps.filter((id) => id !== appId);
  settings.favoriteApps = on === true ? [...favorites, appId] : favorites;
  saveSettings(app.getPath('userData'), settings);
  pushState();
});

ipcMain.handle('home:clear-recent', (event) => {
  if (!fromHome(event)) return;
  settings.recentApps = [];
  saveSettings(app.getPath('userData'), settings);
  pushState();
});

// ── Publish (#800) ──────────────────────────────────────────────

/**
 * The environment of the bundled `fas` CLI and of git. Packaged builds always publish through the real API; dev
 * builds follow FAS_DEV_API_ORIGIN (the e2e stand-in) and FAS_DESKTOP_CLI_HOME (a home directory holding the
 * CLI's sign-in, so tests never touch ~/.fas).
 */
function publishEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.FAS_API_BASE;
  if (dev && process.env.FAS_DEV_API_ORIGIN) env.FAS_API_BASE = apiOrigin;
  const home = dev ? process.env.FAS_DESKTOP_CLI_HOME : undefined;
  if (home) {
    env.HOME = home;
    env.USERPROFILE = home;
  }
  return env;
}
const cliEnv = publishEnv();
const publisher = new Publisher({
  // Like the stdio entry: this app's binary in node mode. The CLI holds the sign-in; this process never reads it.
  fas: {
    command: process.execPath,
    args: [fileURLToPath(new URL('../cli/fas.mjs', import.meta.url))],
    env: { ...cliEnv, ELECTRON_RUN_AS_NODE: '1' },
  },
  git: { command: 'git', args: [], env: cliEnv },
  dev,
  projects: () => settings.publishProjects,
  saveProjects: (paths) => {
    settings.publishProjects = paths;
    saveSettings(app.getPath('userData'), settings);
  },
  open: openExternal,
  changed: () => pushState(),
});

/** Only folders the user picked in a folder dialog: the page names a project, never an arbitrary path. */
const isProject = (path: unknown): path is string =>
  typeof path === 'string' && settings.publishProjects.includes(path);

async function pickFolder(title: string, buttonLabel: string): Promise<string | null> {
  if (!home) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(home, {
    title,
    buttonLabel,
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled ? null : (filePaths[0] ?? null);
}

ipcMain.handle('home:publish-refresh', (event) => {
  if (fromHome(event)) return publisher.refresh();
});
ipcMain.handle('home:publish-sign-in', (event) => {
  if (fromHome(event)) return publisher.signIn();
});
ipcMain.handle('home:publish-sign-out', (event) => {
  if (fromHome(event)) return publisher.signOut();
});
ipcMain.handle('home:publish-cancel', (event) => {
  if (fromHome(event)) publisher.cancel();
});
ipcMain.handle('home:publish-new', async (event, appId: unknown) => {
  if (!fromHome(event) || typeof appId !== 'string' || publisher.busy) return false;
  const parent = await pickFolder('Where to create the app', 'Create here');
  return parent ? publisher.create(parent, appId) : false;
});
ipcMain.handle('home:publish-add', async (event) => {
  if (!fromHome(event) || !home) return false;
  const path = await pickFolder('Add an app folder', 'Add');
  if (!path) return false;
  if (await publisher.add(path)) return true;
  await dialog.showMessageBox(home, {
    type: 'warning',
    message: "That folder isn't a FreeAppStore app.",
    detail: 'Choose the folder with fas.json in it, or create a new app.',
  });
  return false;
});
ipcMain.handle('home:publish-remove', (event, path: unknown) => {
  if (fromHome(event) && isProject(path)) return publisher.remove(path);
});
ipcMain.handle('home:publish-show', (event, path: unknown) => {
  if (fromHome(event) && isProject(path)) void shell.openPath(path);
});
ipcMain.handle('home:publish-check', (event, path: unknown) => {
  if (fromHome(event) && isProject(path)) return publisher.check(path);
});
ipcMain.handle('home:publish-publish', (event, path: unknown, input: unknown) => {
  if (!fromHome(event) || !isProject(path) || !input || typeof input !== 'object') return false;
  const { category, oneliner } = input as Record<string, unknown>;
  if (typeof category !== 'string' || typeof oneliner !== 'string') return false;
  return publisher.publish(path, { category, oneliner });
});
ipcMain.handle('home:publish-push', (event, path: unknown, message: unknown) => {
  if (fromHome(event) && isProject(path) && typeof message === 'string')
    return publisher.push(path, message);
  return false;
});

// ── Updates (#839) ──────────────────────────────────────────────

const updates = new Updates(electronUpdater.autoUpdater, {
  canInstall: process.platform !== 'darwin',
  storeManaged: Boolean(process.windowsStore),
  enabled: () => settings.autoUpdate && app.isPackaged,
  changed: () => pushState(),
});

/** Restart to update, or on macOS download the signed app ZIP for this Mac. */
function applyUpdate() {
  const { status, version } = updates.state;
  if (status === 'ready') updates.install();
  else if (status === 'manual' && version)
    openExternal(
      `https://github.com/${RELEASES}/download/desktop-v${version}/FreeAppStore-mac-${process.arch}.zip`,
    );
}

ipcMain.handle('home:update', (event, action: unknown) => {
  if (!fromHome(event)) return;
  if (action === 'check' && app.isPackaged) updates.check();
  else if (action === 'apply') applyUpdate();
});
ipcMain.handle('home:set-auto-update', (event, on: unknown) => {
  if (!fromHome(event) || typeof on !== 'boolean') return;
  settings.autoUpdate = on;
  saveSettings(app.getPath('userData'), settings);
  if (on) updates.start();
  pushState();
});
/** A desktop release's notes (the GitHub release body), or null when there is no such release. */
ipcMain.handle('home:release-notes', async (event, version: unknown) => {
  if (!fromHome(event) || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))
    return null;
  const response = await net.fetch(
    `https://api.github.com/repos/${RELEASES}/tags/desktop-v${version}`,
    { headers: { accept: 'application/vnd.github+json' } },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub: ${response.status}`);
  const release = (await response.json()) as { body?: string; published_at?: string };
  return { version, body: release.body ?? '', published: release.published_at ?? null };
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
const modelDir = () => join(app.getPath('userData'), 'kokoro');
// Dev builds can download the model from elsewhere (the e2e test's stand-in)
const modelSource = (dev && process.env.FAS_DEV_MODEL_URL) || undefined;
/** The TTS utility process (`tts.ts`): sherpa-onnx and the model's install, off the main thread. */
const tts = new TtsProcess(
  () =>
    utilityProcess.fork(fileURLToPath(new URL('./tts.js', import.meta.url)), [modelDir()], {
      serviceName: 'FreeAppStore Contribute',
    }) as unknown as TtsPort,
);
const encoders = new EncoderRelay((message) => {
  const contents = engineWindowContents();
  if (!contents.isDestroyed()) contents.send('contribute:to-encoder', message);
});
let history: HistoryItem[] | null = null;
/**
 * The connected account is the one the Contribute history and opt-ins belong to (#848): checked
 * against `/native/me` after connecting (`verifyAccount`). Until then Contribute claims nothing
 * and shows no history.
 */
let accountVerified = false;
const contribute = new Contribute(
  {
    token: () => (accountVerified ? deviceToken : null),
    optedIn: () => settings.contributeApps,
    mode: () => settings.contributeMode,
    when: () => settings.contributeWhen,
    machine: () => ({
      onBattery: powerMonitor.isOnBatteryPower(),
      battery: batteryLevel,
      thermal: process.platform === 'darwin' ? powerMonitor.getCurrentThermalState() : null,
      speedLimit,
      inUse: powerMonitor.getSystemIdleState(IDLE_SECONDS) === 'active',
    }),
    modelReady: () => modelInstalled(modelDir()),
    installModel: (progress) => tts.install(progress, modelSource),
    engine: () => {
      engineWindowContents();
      return engineReady!;
    },
    createRunner: (encoder, rest) =>
      new NativeRunner({
        say: (text, sid, speed, mandarin) =>
          tts.say(text, sid, speed, mandarin, cpuThreads(settings.contributeWhen.cpu)),
        encode: (rate) => encoders.start(rate),
        bitrate: encoder.bitrate ?? 32_000,
        dispose: () => tts.close(),
        rest,
      }),
    deleteModel: async () => {
      tts.close();
      await rm(modelDir(), { recursive: true, force: true });
    },
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
    keepAudio: async (appId, jobId, result) => {
      const token = deviceToken;
      const audio = new Uint8Array(await result.file.arrayBuffer());
      // Signed out meanwhile (#848): the audio is not kept
      if (token === deviceToken)
        keepAudio(app.getPath('userData'), appId, jobId, audio, result.meta);
    },
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
    optedIn: accountVerified ? settings.contributeApps : [],
    mode: contributeMode(),
    when: settings.contributeWhen,
  };
}

/** Auto, Off, or Auto running once regardless (Run now), as the window and the tray show it (#830). */
const contributeMode = (): TrayContributeMode =>
  settings.contributeMode === 'off' ? 'off' : contribute.state.runNow ? 'run-now' : 'auto';

/**
 * This computer's battery level, from the hidden window (Electron's main process has none), and
 * the CPU speed limit the OS last advertised (#830). Null until told.
 */
let batteryLevel: number | null = null;
let speedLimit: number | null = null;

/**
 * The hidden window's contents: no throttling, since it does the work while every other window
 * is closed. It loads the encoder page from disk and reports the AAC settings it encodes
 * with (#837: synthesis is the TTS process's; #854: WebAssembly where WebCodecs has no AAC).
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
  engineReady = new Promise<Engine>((resolve, reject) => {
    ipcMain.removeAllListeners('contribute:engine');
    ipcMain.on('contribute:engine', (event, engine: Engine) => {
      if (event.sender === contents) resolve(engine);
    });
    // Closed before it reported (a crash, a disconnect): the next look opens a new one
    win.on('closed', () => reject(new Error('the generating window closed')));
  });
  engineReady.catch(() => {}); // only a waiting engine() call cares
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  // A crashed renderer takes the job in hand with it: stop, and start over on the next look
  contents.on('render-process-gone', () => {
    contribute.stop();
    win.destroy();
  });
  win.on('closed', () => {
    if (engineWindow === win) engineWindow = null;
    encoders.closed();
  });
  void win.loadFile(fileURLToPath(new URL('../renderer/contribute.html', import.meta.url)));
  return contents;
}

ipcMain.on('contribute:from-encoder', (event, message: EncoderReply) => {
  if (!engineWindow || event.sender !== engineWindow.webContents) return;
  encoders.receive(message);
});
ipcMain.on('contribute:battery', (event, level: unknown) => {
  if (!engineWindow || event.sender !== engineWindow.webContents) return;
  batteryLevel = typeof level === 'number' && level >= 0 && level <= 100 ? Math.round(level) : null;
});

function saveContribute(changes: Partial<Settings>) {
  Object.assign(settings, changes);
  saveSettings(app.getPath('userData'), settings);
  pushState();
}

/** Auto, Run now (one run regardless of the conditions, then Auto) or Off, the hard stop (#830). */
function setContributeMode(mode: TrayContributeMode) {
  saveContribute({ contributeMode: mode === 'off' ? 'off' : 'auto' });
  if (mode === 'run-now') contribute.runNow();
  else contribute.wake();
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
      headers,
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
  // Contribute starts once refreshProfile has checked whose history this is
  if (deviceToken) void refreshProfile();
}

/**
 * Contribute's history, kept audio and opt-ins belong to one account (#848): an explicit sign-out
 * deletes them, and a different account never inherits them. `account` is who they are for next.
 */
function clearContribute(account: string | null) {
  contribute.reset();
  history = clearHistory(app.getPath('userData'));
  saveContribute({ contributeApps: [], contributeAccount: account });
}

/** The account behind the credential is now known: keep or clear Contribute's state, then start. */
function verifyAccount(userId: string) {
  if (settings.contributeAccount && settings.contributeAccount !== userId) clearContribute(userId);
  else if (!settings.contributeAccount) saveContribute({ contributeAccount: userId });
  if (accountVerified) return;
  accountVerified = true;
  contribute.reset(); // the window reads the history again, now shown
  contribute.wake();
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
    const next = await fetchProfile(token, headers, `${apiOrigin}/v1`);
    if (token !== deviceToken) return;
    if (!next) return signedOut();
    verifyAccount(next.user.id);
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

/**
 * `revoke`: an explicit sign-out, which also deletes Contribute's history, audio and opt-ins
 * (#848). A credential the server refused keeps them for the same account to reconnect; another
 * account clears them (`verifyAccount`).
 */
function disconnectDevice(revoke: boolean) {
  profile = null;
  avatarIcon = null;
  if (deviceToken && revoke) void unpairDevice(deviceToken, headers, `${apiOrigin}/v1`);
  deleteDeviceToken(app.getPath('userData'));
  deviceToken = null;
  accountVerified = false;
  if (revoke) clearContribute(null);
  else contribute.reset();
  contribute.wake(); // ends the loop's wait
  engineWindow?.destroy();
}

ipcMain.handle('home:contribute-history', (event) =>
  fromHome(event) && accountVerified ? historyItems() : [],
);
ipcMain.handle('home:contribute-audio', (event, appId: unknown, jobId: unknown) => {
  if (!fromHome(event) || typeof appId !== 'string' || typeof jobId !== 'string') return null;
  if (!APP_ID.test(appId) || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) return null;
  if (!accountVerified) return null;
  return readAudio(app.getPath('userData'), appId, jobId);
});
/** Saves an item's record and audio in a folder the user names (#843); its path, or null. */
ipcMain.handle(
  'home:contribute-save-record',
  async (event, appId: unknown, jobId: unknown, at: unknown) => {
    if (!fromHome(event) || !home) return null;
    if (!accountVerified) return null;
    const item = historyItems().find((i) => i.appId === appId && i.jobId === jobId && i.at === at);
    if (!item) return null;
    const { canceled, filePath } = await dialog.showSaveDialog(home, {
      title: 'Save record',
      buttonLabel: 'Save',
      defaultPath: `${item.appId}-${item.key.replace(/[^\w.-]+/g, '_')}-record`,
      message: 'A folder with record.json and the audio',
    });
    if (canceled || !filePath) return null;
    saveRecord(app.getPath('userData'), item, filePath);
    return filePath;
  },
);
/** Copy diagnostics (#813): the capability report and the latest jobs' records, to the clipboard. */
ipcMain.handle('home:contribute-diagnostics', (event) => {
  if (!fromHome(event)) return false;
  clipboard.writeText(contribute.diagnostics());
  return true;
});
ipcMain.handle(
  'home:contribute-report',
  (event, appId: unknown, jobId: unknown, good: unknown, note: unknown) => {
    if (!fromHome(event) || typeof appId !== 'string' || typeof jobId !== 'string') return null;
    if (typeof good !== 'boolean' || typeof note !== 'string' || note.length > 500) return null;
    return contribute.report(appId, jobId, good, note);
  },
);
/** A code for a phone to scan and join this account (#845). */
ipcMain.handle('home:pair-code', (event) =>
  fromHome(event) && deviceToken ? createPairCode(deviceToken, headers, `${apiOrigin}/v1`) : null,
);
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
  if (!fromHome(event) || !accountVerified || typeof appId !== 'string' || !APP_ID.test(appId))
    return;
  const apps = settings.contributeApps.filter((id) => id !== appId);
  saveContribute({ contributeApps: on === true ? [...apps, appId] : apps });
  contribute.wake();
});
ipcMain.handle('home:contribute-mode', (event, mode: unknown) => {
  if (fromHome(event) && (mode === 'auto' || mode === 'run-now' || mode === 'off'))
    setContributeMode(mode);
});
ipcMain.handle('home:contribute-when', (event, changes: unknown) => {
  if (!fromHome(event) || !changes || typeof changes !== 'object') return;
  saveContribute({ contributeWhen: contributeWhen({ ...settings.contributeWhen, ...changes }) });
  contribute.wake();
});
ipcMain.handle('home:contribute-download', (event) => {
  if (fromHome(event) && deviceToken) void contribute.downloadModel();
});
ipcMain.handle('home:contribute-delete-model', async (event) => {
  if (fromHome(event) && deviceToken) await contribute.deleteModel();
});
ipcMain.handle('home:contribute-backlog', async (event) => {
  if (!fromHome(event) || !accountVerified || !deviceToken)
    throw new Error('Sign in to see awaiting jobs.');
  return fetchBacklog(deviceToken, headers, `${apiOrigin}/v1`);
});
ipcMain.handle('home:contribute-refresh', (event) => {
  if (!fromHome(event)) return;
  if (accountVerified) void contribute.refreshApps();
  else void refreshProfile();
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
    publisher.cancel();
  });

  app.whenReady().then(async () => {
    // Electron otherwise automatically approves requests from remote pages (#857).
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    installPermissions(session.fromPartition('persist:fas-apps'), {
      origin(contents) {
        const entry = [...appWindows].find(
          ([, win]) => !win.isDestroyed() && win.webContents === contents,
        );
        return entry ? appOrigin(entry[0], devOrigin) : null;
      },
      async ask(contents, origin, access) {
        const win = BrowserWindow.fromWebContents(contents);
        if (!win || win.isDestroyed()) return false;
        const result = await dialog.showMessageBox(win, {
          type: 'question',
          title: 'App permission',
          message: `Allow ${origin} to use ${access}?`,
          detail:
            'Applies until you close this app window. Your computer may also ask for permission.',
          buttons: ['Deny', 'Allow'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        return result.response === 1;
      },
    });
    const userData = app.getPath('userData');
    const activity = loadActivity(userData);
    hub.restoreLog(activity.entries);
    activityError = activity.error;
    activityReadable = !activity.error;
    hub.on('activity', () => {
      if (!activityReadable) return; // Preserve an unreadable file until the user chooses Clear history.
      try {
        saveActivity(userData, hub.log);
        activityError = null;
      } catch {
        activityError = 'AI activity could not be saved. Check free space and folder permissions.';
      }
    });
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
    // Contribute state left by a sign-out before #848 belongs to no one: it goes
    if (!deviceToken && !settings.contributeAccount) clearContribute(null);
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
    updates.start();
    // Power and heat changed: Contribute checks its conditions again now (#830)
    const recheck = () => contribute.wake();
    powerMonitor.on('on-ac', recheck);
    powerMonitor.on('on-battery', recheck);
    powerMonitor.on('thermal-state-change', recheck);
    powerMonitor.on('resume', recheck);
    powerMonitor.on('speed-limit-change', ({ limit }) => {
      speedLimit = limit;
      contribute.wake();
    });
    if (deviceToken) {
      // Checked when it was connected; refreshProfile checks again
      if (settings.contributeAccount) {
        accountVerified = true;
        contribute.wake();
      }
      void refreshProfile();
    }
    if (hidden) app.dock?.hide();
    else createHome();
    app.on('activate', showHome);
  });

  // The app keeps running in the tray with no window open.
  app.on('window-all-closed', () => {});
}
