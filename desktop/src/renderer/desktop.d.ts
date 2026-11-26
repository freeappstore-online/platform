// The API the home window's preload (src/preload/home.cts) exposes.
import type { LogEntry, OpenApp } from '../main/hub.js';

export type { LogEntry, OpenApp };

export interface DesktopState {
  mcpUrl: string;
  setupCommand: string;
  serverError: string | null;
  openApps: OpenApp[];
  log: LogEntry[];
}

/** An entry of https://freeappstore.online/registry.json. */
export interface RegistryApp {
  id: string;
  name: string;
  category?: string;
  icon?: string;
  iconBg?: string;
  description?: string;
}

declare global {
  interface Window {
    fasDesktop: {
      state(): Promise<DesktopState>;
      onState(listener: (state: DesktopState) => void): void;
      openApp(appId: string): Promise<void>;
      copySetupCommand(): Promise<void>;
      regenerateToken(): Promise<void>;
      registry(): Promise<{ apps: RegistryApp[] }>;
    };
  }
}
