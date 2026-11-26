import { Generation, type GenerationOpenApp } from '@freeappstore/sdk';
import {
  contributeKokoroApps,
  KOKORO_DOWNLOAD_BYTES,
  type KokoroDevice,
  type KokoroEvent,
  KokoroRunner,
  type KokoroRunnerOptions,
  kokoroProblem,
} from '@freeappstore/sdk/generation-kokoro';
import { API_ORIGIN } from './device.js';

/**
 * Contribute on the desktop (#826): this computer generates community jobs (narration) for the
 * store apps the user opted in to, with the SDK's shared Kokoro runner, and keeps going while the
 * window is closed (the app lives in the tray). The loop and every API call run here in the main
 * process with the device credential, so no timer is throttled and the credential never reaches a
 * page; synthesis and AAC encoding run in a Web Worker in a hidden window (the main process has no
 * WebCodecs), reached through `RelayWorker`. With nothing to do it looks again every 15 minutes.
 */

/** How long the loop waits after a run, or with nothing to do, before looking for work again. */
export const IDLE_MS = 15 * 60_000;

/** The hidden window's model worker, seen from here as the `Worker` that `KokoroRunner` talks to. */
export class RelayWorker extends EventTarget {
  constructor(private readonly post: (message: unknown) => void) {
    super();
  }
  postMessage(message: unknown): void {
    this.post(message);
  }
  terminate(): void {
    this.post({ type: 'terminate' });
  }
  /** A message from the worker; a finished job's audio arrives as bytes and becomes a Blob again. */
  receive(message: { type?: string; file?: ArrayBuffer }): void {
    const data =
      message.type === 'done' && message.file
        ? { ...message, file: new Blob([message.file], { type: 'audio/mp4' }) }
        : message;
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

/** The worker type `KokoroRunner` takes (a DOM `Worker`); `RelayWorker` does what it uses of one. */
type RunnerWorker = ReturnType<KokoroRunnerOptions['createWorker']>;

/** What the hidden window reports about this computer once it has loaded. */
export interface Engine {
  /** From `kokoroEncoder()`: null when this build of Chromium has no AAC encoder. */
  encoder: KokoroRunnerOptions['encoder'] | null;
  device: KokoroDevice;
  /** Whether the model's files are in the window's Cache Storage. */
  downloaded: boolean;
}

export interface ContributeHost {
  token(): string | null;
  optedIn(): string[];
  paused(): boolean;
  modelReady(): boolean;
  setModelReady(ready: boolean): void;
  /** The hidden window's engine, waiting for it to load. */
  engine(): Promise<Engine>;
  createWorker(): RelayWorker;
  deleteModel(): Promise<void>;
  /** The device credential was refused (expired or revoked). */
  signedOut(): void;
  changed(): void;
}

export interface ContributeApp {
  appId: string;
  oneliner: string | null;
  /** Jobs this device could claim, in sets it can run. */
  open: number;
  /** Why this computer can't run any of the app's sets, or null. */
  problem: string | null;
}

export interface ContributeState {
  status: 'running' | 'idle' | 'paused';
  /** Why it is idle, or how the last run ended. */
  message: string | null;
  /** Apps with open work, from discovery; null until it has been asked. */
  apps: ContributeApp[] | null;
  model: { device: KokoroDevice; bytes: number; ready: boolean; loading: number | null } | null;
  /** False when this computer can't encode AAC; null until the hidden window says. */
  encoder: boolean | null;
  current: {
    appId: string;
    key: string;
    sentence: number;
    sentences: number;
    charsPerSecond: number;
  } | null;
  /** Since the app started. */
  submitted: number;
  skipped: number;
  failed: number;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class Contribute {
  state: ContributeState = {
    status: 'idle',
    message: null,
    apps: null,
    model: null,
    encoder: null,
    current: null,
    submitted: 0,
    skipped: 0,
    failed: 0,
  };
  private controller: AbortController | null = null;
  private wakeUp: () => void = () => {};
  private looping = false;
  private loading = false;

  constructor(
    private readonly host: ContributeHost,
    private readonly origin = API_ORIGIN,
    private readonly idleMs = IDLE_MS,
  ) {}

  private set(next: Partial<ContributeState>) {
    this.state = { ...this.state, ...next };
    this.host.changed();
  }

  /** Start the loop, or look for work now (after a setting changed). Pausing stops the job in hand. */
  wake(): void {
    if (this.host.paused()) this.controller?.abort(new Error('Paused'));
    if (!this.looping) void this.loop();
    else this.wakeUp();
  }

  /** Stop the loop for good (quit, disconnect). */
  stop(): void {
    this.controller?.abort(new Error('Stopped'));
  }

  private async loop() {
    this.looping = true;
    try {
      while (this.host.token()) {
        const woken = new Promise<void>((resolve) => {
          this.wakeUp = resolve;
        });
        await this.once();
        if (!this.host.token()) break;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          woken,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.idleMs);
          }),
        ]);
        clearTimeout(timer);
      }
    } finally {
      this.looping = false;
      this.set({ status: 'idle', current: null });
    }
  }

  private async fetchApps(token: string): Promise<GenerationOpenApp[]> {
    const response = await fetch(`${this.origin}/v1/generation/open`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 401) throw new Error('Not signed in.');
    if (!response.ok) throw new Error(`Looking for work failed (HTTP ${response.status}).`);
    return ((await response.json()) as { apps: GenerationOpenApp[] }).apps;
  }

  private async engine(): Promise<Engine> {
    const engine = await this.host.engine();
    const ready = this.host.modelReady() && engine.downloaded;
    this.set({
      encoder: engine.encoder !== null,
      model: {
        device: engine.device,
        bytes: KOKORO_DOWNLOAD_BYTES[engine.device],
        ready,
        loading: this.state.model?.loading ?? null,
      },
    });
    return engine;
  }

  /** One look for work and, if there is some, one run. */
  private async once() {
    const token = this.host.token();
    if (!token) return;
    if (this.host.paused()) return this.set({ status: 'paused', message: null, current: null });
    let discovered: GenerationOpenApp[];
    try {
      discovered = await this.fetchApps(token);
    } catch (err) {
      if (errorText(err) === 'Not signed in.') return this.host.signedOut();
      return this.set({ status: 'idle', message: `Couldn't look for work: ${errorText(err)}` });
    }
    const runnable = (app: GenerationOpenApp) => app.sets.filter((s) => !kokoroProblem(s));
    this.set({
      apps: discovered.map((app) => ({
        appId: app.appId,
        oneliner: app.oneliner,
        open: runnable(app).reduce((n, s) => n + s.open, 0),
        problem: runnable(app).length ? null : (app.sets.map((s) => kokoroProblem(s))[0] ?? null),
      })),
    });
    const engine = await this.engine();
    if (!engine.encoder)
      return this.set({ status: 'idle', message: "This computer can't encode AAC audio." });
    if (!this.state.model?.ready)
      return this.set({ status: 'idle', message: 'Download the voice model to start.' });
    const apps = discovered
      .filter((app) => runnable(app).length)
      .map((app) => ({
        appId: app.appId,
        generation: new Generation(app.appId, this.origin, {
          token,
          handleUnauthorized: () => {},
        }),
        setIds: runnable(app).map((s) => s.setId),
      }));
    const chosen = () => apps.filter((app) => this.host.optedIn().includes(app.appId));
    if (!chosen().length) {
      const message = this.host.optedIn().length
        ? 'No work for the apps you chose right now. FreeAppStore looks again every 15 minutes.'
        : 'Choose the apps to generate for.';
      return this.set({ status: 'idle', message });
    }
    await this.run(engine, chosen);
  }

  private async run(engine: Engine, apps: Parameters<typeof contributeKokoroApps>[0]['apps']) {
    const controller = new AbortController();
    this.controller = controller;
    const runner = new KokoroRunner({
      createWorker: () => this.host.createWorker() as unknown as RunnerWorker,
      encoder: engine.encoder!,
      device: engine.device,
    });
    this.set({ status: 'running', message: null, current: null });
    const onEvent = (e: KokoroEvent, appId: string) => {
      if (e.type === 'claimed')
        this.set({
          current: { appId, key: e.job.key, sentence: 0, sentences: 0, charsPerSecond: 0 },
        });
      else if (e.type === 'progress')
        this.set({
          current: {
            appId,
            key: e.job.key,
            sentence: e.progress.sentence,
            sentences: e.progress.sentences,
            charsPerSecond: e.progress.charsPerSecond,
          },
        });
      else if (e.type === 'submitted')
        this.set({ submitted: this.state.submitted + 1, current: null });
      else if (e.type === 'skipped') this.set({ skipped: this.state.skipped + 1, current: null });
      else if (e.type === 'failed') this.set({ failed: this.state.failed + 1, current: null });
    };
    try {
      await contributeKokoroApps({ runner, signal: controller.signal, apps, onEvent });
      this.set({
        message: controller.signal.aborted
          ? null
          : 'No more work for now. FreeAppStore looks again every 15 minutes.',
      });
    } catch (err) {
      if (errorText(err) === 'Not signed in.') this.host.signedOut();
      else this.set({ message: `Stopped on an error: ${errorText(err)}` });
    } finally {
      runner.dispose(); // frees the model's memory until the next run
      this.controller = null;
      this.set({ status: this.host.paused() ? 'paused' : 'idle', current: null });
    }
  }

  /** Download (unless cached) and load the model once the user agreed to its size. */
  async downloadModel(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const engine = await this.engine();
      if (!engine.encoder) return;
      const runner = new KokoroRunner({
        createWorker: () => this.host.createWorker() as unknown as RunnerWorker,
        encoder: engine.encoder,
        device: engine.device,
      });
      const model = this.state.model!;
      this.set({ model: { ...model, loading: 0 }, message: null });
      try {
        await runner.load((loading) => this.set({ model: { ...model, loading } }));
        engine.downloaded = true; // the window reported it before the download
        this.host.setModelReady(true);
        this.set({ model: { ...model, ready: true, loading: null } });
      } catch (err) {
        this.set({
          model: { ...model, loading: null },
          message: `The model didn't download: ${errorText(err)}`,
        });
      } finally {
        runner.dispose();
      }
    } finally {
      this.loading = false;
    }
    this.wake();
  }

  /** Stop and delete the model's files. */
  async deleteModel(): Promise<void> {
    this.controller?.abort(new Error('Stopped'));
    this.host.setModelReady(false);
    await this.host.deleteModel();
    (await this.host.engine()).downloaded = false;
    if (this.state.model) this.set({ model: { ...this.state.model, ready: false } });
  }
}

/** One line for the tray: what Contribute is doing. */
export function contributeStatus(state: ContributeState): string {
  if (state.status === 'paused') return 'Contribute: paused';
  if (state.current)
    return state.current.sentences
      ? `Contribute: ${state.current.appId}, sentence ${state.current.sentence} of ${state.current.sentences}`
      : `Contribute: ${state.current.appId}, starting`;
  if (state.status === 'running') return 'Contribute: looking for a job';
  return 'Contribute: idle';
}
