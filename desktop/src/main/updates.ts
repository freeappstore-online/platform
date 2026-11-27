/**
 * Updates (#839): look for a newer version on start and daily, from the release the app was built for
 * (electron-builder's `publish`, read by electron-updater from app-update.yml). Windows and Linux download it in
 * the background and install it on Restart to update or on quit. macOS builds are unsigned, so Squirrel.Mac can't
 * install them: there the app says which version is available and the user downloads it.
 */

/** What the app knows about a newer version. */
export interface UpdateState {
  /**
   * idle: nothing newer found, or not looked yet; checking; downloading (Windows, Linux); ready: downloaded,
   * Restart to update; manual: macOS, download it by hand; error: the last check or download failed.
   */
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'manual' | 'error';
  /** The newer version, once found. */
  version: string | null;
  /** Download progress, 0–100, while downloading. */
  percent: number | null;
  error: string | null;
  /** When the last check answered (ms). */
  checkedAt: number | null;
}

/** The part of electron-updater's `autoUpdater` this uses. */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: electron-updater's events each pass their own argument
  on(event: string, listener: (arg: any) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export const DAY = 24 * 60 * 60 * 1000;

export class Updates {
  state: UpdateState = {
    status: 'idle',
    version: null,
    percent: null,
    error: null,
    checkedAt: null,
  };
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly updater: Updater,
    private readonly options: {
      /** This platform installs updates itself (not macOS's unsigned builds). */
      canInstall: boolean;
      /** Automatic checks are on. */
      enabled(): boolean;
      changed(): void;
    },
  ) {
    updater.autoDownload = options.canInstall;
    updater.autoInstallOnAppQuit = options.canInstall;
    const busy = () => this.state.status === 'downloading' || this.state.status === 'ready';
    updater.on('checking-for-update', () => {
      if (!busy()) this.set({ status: 'checking', error: null });
    });
    updater.on('update-available', ({ version }: { version: string }) =>
      this.set({
        status: options.canInstall ? 'downloading' : 'manual',
        version,
        percent: options.canInstall ? 0 : null,
        checkedAt: Date.now(),
      }),
    );
    updater.on('update-not-available', () =>
      this.set({ status: 'idle', version: null, percent: null, checkedAt: Date.now() }),
    );
    updater.on('download-progress', ({ percent }: { percent: number }) =>
      this.set({ percent: Math.round(percent) }),
    );
    updater.on('update-downloaded', ({ version }: { version: string }) =>
      this.set({ status: 'ready', version, percent: null }),
    );
    // A failed check or download is tried again on the next one; a found version stays shown.
    updater.on('error', (error: Error) =>
      this.set({
        ...(this.state.status !== 'ready' && this.state.status !== 'manual' && { status: 'error' }),
        percent: null,
        error: error.message.split('\n')[0] ?? String(error),
      }),
    );
  }

  /** Look now, then once a day while automatic checks are on. */
  start() {
    if (this.options.enabled()) this.check();
    this.timer ??= setInterval(() => {
      if (this.options.enabled()) this.check();
    }, DAY);
  }

  check() {
    if (this.state.status === 'downloading' || this.state.status === 'ready') return;
    // Failures also arrive as the `error` event.
    this.updater.checkForUpdates().catch(() => {});
  }

  /** Restart to update: quits, installs and starts the new version. */
  install() {
    if (this.state.status === 'ready') this.updater.quitAndInstall();
  }

  private set(changes: Partial<UpdateState>) {
    Object.assign(this.state, changes);
    this.options.changed();
  }
}
