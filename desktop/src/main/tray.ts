import type { MenuItemConstructorOptions, NativeImage } from 'electron';

export interface TrayState {
  paused: boolean;
  /** FAS apps currently offering tools over the bridge. */
  openApps: number;
  serverError: string | null;
  /** Contribute (#826), while this computer is connected: its status line and mode (#830). */
  contribute: { status: string; mode: TrayContributeMode } | null;
  /** The signed-in account (#829): its name and a 16 px avatar, once loaded. */
  account?: { name: string; icon: NativeImage | null } | null;
  /** A newer version (#839): downloaded and ready to install, or (macOS) to download by hand. */
  update?: { version: string; ready: boolean } | null;
}

/** Auto, Run now (one run that ignores the conditions) or Off (#830). */
export type TrayContributeMode = 'auto' | 'run-now' | 'off';

export interface TrayActions {
  open(): void;
  setPaused(paused: boolean): void;
  setContributeMode(mode: TrayContributeMode): void;
  /** Restart to update, or open the download (macOS). */
  update(): void;
  quit(): void;
}

/** One line of status: what the menu-bar icon's tooltip and the menu's first item say. */
export function trayStatus({ paused, openApps, serverError }: TrayState): string {
  if (serverError) return 'FreeAppStore: AI access unavailable';
  if (paused) return 'FreeAppStore: AI access paused';
  const apps = openApps === 1 ? '1 app connected' : `${openApps} apps connected`;
  return `FreeAppStore: On, ${apps}`;
}

/**
 * The menu-bar (tray) menu (#815): status, Open, Pause / Resume, then Contribute's status and
 * its mode, Auto / Run now / Off, while this computer is connected (#826, #830), the signed-in
 * account (#829), Quit. An available
 * update (#839) comes right after the status.
 */
export function trayMenu(state: TrayState, actions: TrayActions): MenuItemConstructorOptions[] {
  const { contribute, update } = state;
  return [
    { label: trayStatus(state), enabled: false },
    ...(update
      ? [
          {
            label: update.ready
              ? `Update available: restart to update to ${update.version}`
              : `Update available: download version ${update.version}`,
            click: actions.update,
          },
        ]
      : []),
    { type: 'separator' },
    { label: 'Open FreeAppStore', click: actions.open },
    state.paused
      ? { label: 'Resume AI access', click: () => actions.setPaused(false) }
      : { label: 'Pause AI access', click: () => actions.setPaused(true) },
    ...(contribute
      ? ([
          { type: 'separator' },
          { label: contribute.status, enabled: false },
          ...(
            [
              ['auto', 'Contribute: Auto'],
              ['run-now', 'Contribute: Run now'],
              ['off', 'Contribute: Off'],
            ] as const
          ).map(
            ([mode, label]): MenuItemConstructorOptions => ({
              label,
              type: 'radio',
              checked: contribute.mode === mode,
              click: () => actions.setContributeMode(mode),
            }),
          ),
        ] satisfies MenuItemConstructorOptions[])
      : []),
    ...(state.account
      ? ([
          { type: 'separator' },
          {
            label: state.account.name,
            ...(state.account.icon ? { icon: state.account.icon } : {}),
            click: actions.open,
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    { type: 'separator' },
    { label: 'Quit FreeAppStore', click: actions.quit },
  ];
}
