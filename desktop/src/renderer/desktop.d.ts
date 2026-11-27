// The API the home window's preload (src/preload/home.cts) exposes.
import type { ContributeWhen } from '../main/conditions.js';
import type { ContributeState } from '../main/contribute.js';
import type { PairCode, Profile } from '../main/device.js';
import type { HistoryItem } from '../main/history.js';
import type { LogEntry, OpenApp } from '../main/hub.js';
import type { ClientId, ClientStatus } from '../main/integrations.js';
import type { CheckResult, MyApp, Project, PublishState } from '../main/publish.js';
import type { UpdateState } from '../main/updates.js';

export type {
  CheckResult,
  ClientId,
  ClientStatus,
  ContributeWhen,
  HistoryItem,
  LogEntry,
  MyApp,
  OpenApp,
  Project,
  PublishState,
};

/** Auto, Run now (one run that ignores the conditions) or Off (#830). */
export type ContributeMode = 'auto' | 'run-now' | 'off';

/** Contribute (#826) as the home window sees it. */
export interface DesktopContribute extends ContributeState {
  /** This computer has a device credential. */
  connected: boolean;
  /** Waiting for the user to approve the connection in the browser. */
  pairing: boolean;
  pairError: string | null;
  optedIn: string[];
  mode: ContributeMode;
  /** When it runs in Auto (#830). */
  when: ContributeWhen;
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
  /** Publish (#800): the CLI's sign-in, this account's apps, the app folders here and the last command. */
  publish: PublishState;
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
      /** The AAC encoder's settings. */
      engine(engine: { encoder: AudioEncoderConfig }): void;
      battery(level: number | null): void;
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
      /** A 5-minute, single-use code for a phone to scan and join this account (#845). */
      pairCode(): Promise<PairCode | null>;
      /** Publish (#800), each a run of the bundled `fas` CLI or git; `path` is a project's. */
      publish: {
        refresh(): Promise<void>;
        signIn(): Promise<void>;
        signOut(): Promise<void>;
        /** Stops the command running (a sign-in waiting for GitHub). */
        cancel(): Promise<void>;
        /** `fas init <appId>` in a folder the user picks; false when canceled or it failed. */
        create(appId: string): Promise<boolean>;
        /** Adds an app folder the user picks. */
        add(): Promise<boolean>;
        remove(path: string): Promise<void>;
        show(path: string): Promise<void>;
        check(path: string): Promise<void>;
        publish(path: string, input: { category: string; oneliner: string }): Promise<boolean>;
        /** Commits every change with `message`, then pushes main: push to main deploys. */
        push(path: string, message: string): Promise<boolean>;
      };
      contribute: {
        connect(): Promise<void>;
        cancel(): Promise<void>;
        disconnect(): Promise<void>;
        setOptIn(appId: string, on: boolean): Promise<void>;
        setMode(mode: ContributeMode): Promise<void>;
        /** Changes some of the conditions; the rest stay. */
        setWhen(changes: Partial<ContributeWhen>): Promise<void>;
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
        /** Copies the capability report and the latest jobs' records to the clipboard (#813). */
        copyDiagnostics(): Promise<boolean>;
      };
    };
  }
}
