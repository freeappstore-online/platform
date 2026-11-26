import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What the user chose on Home or in the tray, kept in userData/settings.json across restarts. */
export interface Settings {
  /** AI access paused: every MCP tool call returns an error and no app tool runs. */
  paused: boolean;
  /** Start FreeAppStore when the user logs in. On by default (#815). */
  openAtLogin: boolean;
  /** Contribute (#826): the apps this computer generates for, and whether it is paused. */
  contributeApps: string[];
  contributePaused: boolean;
  /** The user agreed to the voice model's download and it completed. */
  contributeModel: boolean;
}

const FILE = 'settings.json';
const DEFAULTS: Settings = {
  paused: false,
  openAtLogin: true,
  contributeApps: [],
  contributePaused: false,
  contributeModel: false,
};
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

/** The saved settings, plus whether this is the first run (no settings file yet). */
export function loadSettings(dir: string): { settings: Settings; firstRun: boolean } {
  const path = join(dir, FILE);
  if (!existsSync(path)) return { settings: { ...DEFAULTS }, firstRun: true };
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A damaged file falls back to the defaults; the next save rewrites it.
  }
  return {
    settings: {
      paused: bool(saved.paused, DEFAULTS.paused),
      openAtLogin: bool(saved.openAtLogin, DEFAULTS.openAtLogin),
      contributeApps: Array.isArray(saved.contributeApps)
        ? saved.contributeApps.filter((id): id is string => typeof id === 'string')
        : [],
      contributePaused: bool(saved.contributePaused, DEFAULTS.contributePaused),
      contributeModel: bool(saved.contributeModel, DEFAULTS.contributeModel),
    },
    firstRun: false,
  };
}

export function saveSettings(dir: string, settings: Settings): void {
  const path = join(dir, FILE);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}
