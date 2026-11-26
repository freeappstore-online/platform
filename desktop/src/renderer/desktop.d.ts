// The API the home window's preload (src/preload/home.cts) exposes.
import type { ContributeState } from '../main/contribute.js';
import type { Profile } from '../main/device.js';
import type { HistoryItem } from '../main/history.js';
import type { LogEntry, OpenApp } from '../main/hub.js';
import type { ClientId, ClientStatus } from '../main/integrations.js';

export type { ClientId, ClientStatus, HistoryItem, LogEntry, OpenApp };

/** Contribute (#826) as the home window sees it. */
export interface DesktopContribute extends ContributeState {
  /** This computer has a device credential. */
  connected: boolean;
  /** Waiting for the user to approve the connection in the browser. */
  pairing: boolean;
  pairError: string | null;
  optedIn: string[];
  paused: boolean;
}

export interface DesktopState {
  contribute: DesktopContribute;
  mcpUrl: string;
  setupCommand: string;
  serverError: string | null;
  paused: boolean;
  openAtLogin: boolean;
  /** "0.3.0 (57, abc1234)", or "0.3.0 (dev, abc1234)" for a local build (#832). */
  version: string;
  /** The GitHub release notes for this version. */
  releaseNotes: string;
  openApps: OpenApp[];
  log: LogEntry[];
  /** The signed-in account (#829); `avatar` is a data: URL. Null until loaded or when not connected. */
  profile: (Profile & { avatar: string | null }) | null;
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
    /** The hidden Contribute window's preload (src/preload/contribute.cts, #826). */
    fasContribute: {
      /** Messages from the main process for the model worker, `terminate` or `delete-model`. */
      onMessage(listener: (message: unknown) => void): void;
      fromWorker(message: unknown): void;
      engine(engine: {
        encoder: AudioEncoderConfig | null;
        device: string;
        downloaded: boolean;
      }): void;
    };
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
      contribute: {
        connect(): Promise<void>;
        cancel(): Promise<void>;
        disconnect(): Promise<void>;
        setOptIn(appId: string, on: boolean): Promise<void>;
        setPaused(paused: boolean): Promise<void>;
        downloadModel(): Promise<void>;
        deleteModel(): Promise<void>;
        refresh(): Promise<void>;
        /** This computer's attempts, newest first (#827). */
        history(): Promise<HistoryItem[]>;
        /** A kept attempt's audio and meta `{ segments }`, or null once pruned. */
        audio(appId: string, jobId: string): Promise<{ audio: Uint8Array; meta: unknown } | null>;
        /** This account's Good / Not good (and note) for an uploaded attempt (#831). */
        report(appId: string, jobId: string, good: boolean, note: string): Promise<unknown>;
      };
    };
  }
}
