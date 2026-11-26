import type { MenuItemConstructorOptions } from 'electron';

export interface TrayState {
  paused: boolean;
  /** FAS apps currently offering tools over the bridge. */
  openApps: number;
  serverError: string | null;
}

export interface TrayActions {
  open(): void;
  setPaused(paused: boolean): void;
  quit(): void;
}

/** One line of status: what the menu-bar icon's tooltip and the menu's first item say. */
export function trayStatus({ paused, openApps, serverError }: TrayState): string {
  if (serverError) return 'FreeAppStore: AI access unavailable';
  if (paused) return 'FreeAppStore: AI access paused';
  const apps = openApps === 1 ? '1 app connected' : `${openApps} apps connected`;
  return `FreeAppStore: On, ${apps}`;
}

/** The menu-bar (tray) menu (#815): status, Open, Pause / Resume, Quit. */
export function trayMenu(state: TrayState, actions: TrayActions): MenuItemConstructorOptions[] {
  return [
    { label: trayStatus(state), enabled: false },
    { type: 'separator' },
    { label: 'Open FreeAppStore', click: actions.open },
    state.paused
      ? { label: 'Resume AI access', click: () => actions.setPaused(false) }
      : { label: 'Pause AI access', click: () => actions.setPaused(true) },
    { type: 'separator' },
    { label: 'Quit FreeAppStore', click: actions.quit },
  ];
}
