import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ContributeMode,
  type ContributeWhen,
  contributeWhen,
  DEFAULT_WHEN,
} from './conditions.js';

/** What the user chose on Home or in the tray, kept in userData/settings.json across restarts. */
export interface Settings {
  /** AI access paused: every MCP tool call returns an error and no app tool runs. */
  paused: boolean;
  /** Start FreeAppStore when the user logs in. On by default (#815). */
  openAtLogin: boolean;
  /** Contribute (#826): the apps this computer generates for. */
  contributeApps: string[];
  /** Auto, or Off: the hard stop, kept across restarts and updates (#830). */
  contributeMode: ContributeMode;
  /** When it runs in Auto (#830). */
  contributeWhen: ContributeWhen;
  /**
   * The account (user id) the Contribute history and opt-ins belong to (#848), checked against
   * `/native/me` before any of it is shown or used. Null once cleared by a sign-out.
   */
  contributeAccount: string | null;
  /** Look for a new version on start and daily (#839). On by default. */
  autoUpdate: boolean;
  /** Store (#840): apps opened on this computer, most recent first, and the starred ones. */
  recentApps: string[];
  favoriteApps: string[];
  /** Publish (#800): the app folders on this computer, as the user picked them. */
  publishProjects: string[];
}

const FILE = 'settings.json';
const DEFAULTS: Settings = {
  paused: false,
  openAtLogin: true,
  contributeApps: [],
  contributeMode: 'auto',
  contributeWhen: DEFAULT_WHEN,
  contributeAccount: null,
  autoUpdate: true,
  recentApps: [],
  favoriteApps: [],
  publishProjects: [],
};
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

/** The saved settings, plus whether this is the first run (no settings file yet). */
export function loadSettings(dir: string): { settings: Settings; firstRun: boolean } {
  const path = join(dir, FILE);
  if (!existsSync(path)) return { settings: { ...DEFAULTS }, firstRun: true };
  // `contributePaused`: before #830, Pause; it is Off now
  let saved: Partial<Settings> & { contributePaused?: unknown } = {};
  try {
    saved = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A damaged file falls back to the defaults; the next save rewrites it.
  }
  return {
    settings: {
      paused: bool(saved.paused, DEFAULTS.paused),
      openAtLogin: bool(saved.openAtLogin, DEFAULTS.openAtLogin),
      contributeApps: strings(saved.contributeApps),
      contributeMode:
        saved.contributeMode === 'off' || saved.contributeMode === 'auto'
          ? saved.contributeMode
          : saved.contributePaused === true
            ? 'off'
            : DEFAULTS.contributeMode,
      contributeWhen: contributeWhen(saved.contributeWhen),
      contributeAccount:
        typeof saved.contributeAccount === 'string' ? saved.contributeAccount : null,
      autoUpdate: bool(saved.autoUpdate, DEFAULTS.autoUpdate),
      recentApps: strings(saved.recentApps),
      favoriteApps: strings(saved.favoriteApps),
      publishProjects: strings(saved.publishProjects),
    },
    firstRun: false,
  };
}

export function saveSettings(dir: string, settings: Settings): void {
  const path = join(dir, FILE);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}
