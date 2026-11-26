import type { MenuItemConstructorOptions, NativeImage } from 'electron';

export interface TrayState {
  paused: boolean;
  /** FAS apps currently offering tools over the bridge. */
  openApps: number;
  serverError: string | null;
  /** Contribute (#826), while this computer is connected: its status line and whether it is paused. */
  contribute: { status: string; paused: boolean } | null;
  /** The signed-in account (#829): its name and a 16 px avatar, once loaded. */
  account?: { name: string; icon: NativeImage | null } | null;
}

export interface TrayActions {
  open(): void;
  setPaused(paused: boolean): void;
  setContributePaused(paused: boolean): void;
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
 * Pause / Resume while this computer is connected (#826), the signed-in account (#829), Quit.
 */
export function trayMenu(state: TrayState, actions: TrayActions): MenuItemConstructorOptions[] {
  const { contribute } = state;
  return [
    { label: trayStatus(state), enabled: false },
    { type: 'separator' },
    { label: 'Open FreeAppStore', click: actions.open },
    state.paused
      ? { label: 'Resume AI access', click: () => actions.setPaused(false) }
      : { label: 'Pause AI access', click: () => actions.setPaused(true) },
    ...(contribute
      ? ([
          { type: 'separator' },
          { label: contribute.status, enabled: false },
          contribute.paused
            ? { label: 'Resume contributing', click: () => actions.setContributePaused(false) }
            : { label: 'Pause contributing', click: () => actions.setContributePaused(true) },
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
