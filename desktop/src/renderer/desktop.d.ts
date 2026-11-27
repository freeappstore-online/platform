// The API the home window's preload (src/preload/home.cts) exposes.
import type { ContributeState } from '../main/contribute.js';
import type { Profile } from '../main/device.js';
import type { HistoryItem } from '../main/history.js';
import type { LogEntry, OpenApp } from '../main/hub.js';
import type { ClientId, ClientStatus } from '../main/integrations.js';
import type { UpdateState } from '../main/updates.js';

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
  /** A newer version (#839); `auto`: automatic checks are on; `supported`: an installed build, which can update. */
  updates: UpdateState & { auto: boolean; supported: boolean };
  /** The Store's apps opened on this computer, most recent first, and the starred ones (#840). */
  store: { recent: string[]; favorites: string[] };
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
  /** When the app was first published (ISO 8601), for Newest (#834). */
  published?: string;
}

declare global {
  interface Window {
    /** The hidden Contribute window's preload (src/preload/contribute.cts, #826, #837). */
    fasContribute: {
      /** Encoder requests from the main process (`EncoderRequest`). */
      onMessage(listener: (message: unknown) => void): void;
      reply(message: unknown): void;
      /** Whether this computer can encode AAC: the encoder settings, or null. */
      engine(engine: { encoder: AudioEncoderConfig | null }): void;
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
      registry(): Promise<{ apps: RegistryApp[]; votes: Record<string, number> }>;
      setFavorite(appId: string, on: boolean): Promise<void>;
      /** Look for a new version now, or apply the one found (Restart to update; the download on macOS). */
      update(action: 'check' | 'apply'): Promise<void>;
      setAutoUpdate(on: boolean): Promise<void>;
      /** A desktop release's notes, or null when that version has no release. */
      releaseNotes(
        version: string,
      ): Promise<{ version: string; body: string; published: string | null } | null>;
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
        /** Saves an attempt's record and audio in a folder the user names (#843); its path or null. */
        saveRecord(appId: string, jobId: string, at: number): Promise<string | null>;
        /** This account's Good / Not good (and note) for an uploaded attempt (#831). */
        report(appId: string, jobId: string, good: boolean, note: string): Promise<unknown>;
      };
    };
  }
}
