// The API the home window's preload (src/preload/home.cts) exposes.
import type { LogEntry, OpenApp } from '../main/hub.js';
import type { ClientId, ClientStatus } from '../main/integrations.js';

export type { ClientId, ClientStatus, LogEntry, OpenApp };

export interface DesktopState {
  mcpUrl: string;
  setupCommand: string;
  serverError: string | null;
  paused: boolean;
  openAtLogin: boolean;
  version: string;
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
      setPaused(paused: boolean): Promise<void>;
      setOpenAtLogin(open: boolean): Promise<void>;
      clients(): Promise<ClientStatus[]>;
      /** Connect (true) or disconnect (false) a client; resolves with every client's new status. */
      setConnected(id: ClientId, connect: boolean): Promise<ClientStatus[]>;
      registry(): Promise<{ apps: RegistryApp[] }>;
    };
  }
}
