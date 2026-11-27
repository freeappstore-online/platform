import {
  Generation,
  type GenerationAttemptRecord,
  type GenerationJob,
  type GenerationOpenApp,
  type GenerationReport,
} from '@freeappstore/sdk';
import {
  contributeKokoroApps,
  type KokoroEvent,
  type KokoroResult,
  type KokoroRunner,
  type KokoroRunnerOptions,
} from '@freeappstore/sdk/generation-kokoro';
import { API_ORIGIN, clientHeaders } from './device.js';
import { endReason, type HistoryItem, TEXT_CHARS } from './history.js';
import { ENGINE, kokoroProblem, LANGUAGES, type NativeRunner } from './kokoro.js';
import { type InstallProgress, MODEL_DOWNLOAD_BYTES } from './model.js';

/**
 * Contribute on the desktop (#826): this computer generates community jobs (narration) for the
 * store apps the user opted in to, and keeps going while the window is closed (the app lives in
 * the tray). The loop and every API call run here in the main process with the device credential,
 * so no timer is throttled and the credential never reaches a page. The voice is the phones' own
 * (#837): Kokoro through sherpa-onnx in a utility process; AAC encoding runs in a hidden window
 * (the main process has no WebCodecs). With nothing to do it looks again every 15 minutes.
 */

/** How long the loop waits after a run, or with nothing to do, before looking for work again. */
export const IDLE_MS = 15 * 60_000;

/** WebCodecs AAC settings (the main process has no DOM types). */
type EncoderConfig = KokoroRunnerOptions['encoder'];

/** What the hidden window reports about this computer once it has loaded. */
export interface Engine {
  /** From `kokoroEncoder()`: null when this build of Chromium has no AAC encoder. */
  encoder: EncoderConfig | null;
}

export interface ContributeHost {
  token(): string | null;
  optedIn(): string[];
  paused(): boolean;
  /** The model package is downloaded and unpacked (`model.ts`). */
  modelReady(): boolean;
  /** Downloads, verifies and unpacks it, off the main thread. */
  installModel(progress: InstallProgress): Promise<void>;
  /** The hidden window's encoder, waiting for it to load. */
  engine(): Promise<Engine>;
  /** A runner with the TTS process and the hidden window's encoder. */
  createRunner(encoder: EncoderConfig): NativeRunner;
  deleteModel(): Promise<void>;
  /** The device credential was refused (expired or revoked). */
  signedOut(): void;
  changed(): void;
  /** This computer now, for the attempt records (#827). */
  probe(): Reading;
  /** The app version, OS and device the records name. */
  context(): Pick<GenerationAttemptRecord, 'appVersion' | 'os' | 'device'>;
  /** The history, newest first, and its replacement (`history.ts`). */
  history(): HistoryItem[];
  setHistory(items: HistoryItem[]): void;
  /** Keep a job's audio and segments for playback. */
  keepAudio(appId: string, jobId: string, result: KokoroResult): Promise<void>;
}

/** The engine Contribute shows (#837). */
export const MODEL_INFO = { engine: ENGINE, languages: Object.values(LANGUAGES).join(', ') };

/** What the host reads of this computer at an attempt's start, each sentence and its end. */
export interface Reading {
  /** CPU time of every FreeAppStore process so far. */
  cpuMs?: number;
  /** Memory of every FreeAppStore process now. */
  memMb?: number;
  /** Plugged in (Electron tells power source, not battery level). */
  charging?: boolean;
  thermal?: string;
  /** The FreeAppStore window is shown and focused. */
  foreground: boolean;
}

/** The job in hand and what has been measured so far. */
interface Attempt {
  /** The account it ran for (`Contribute.reset`). */
  epoch: number;
  appId: string;
  generation: Generation;
  job: GenerationJob;
  at: number;
  start: Reading;
  peakMemMb: number;
  background: boolean;
  result: KokoroResult | null;
  generatedAt: number | null;
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
  model: {
    engine: string;
    languages: string;
    bytes: number;
    ready: boolean;
    /** Downloading or unpacking, 0-1; null when neither. */
    loading: number | null;
    stage: 'download' | 'unpack';
  } | null;
  /** False when this computer can't encode AAC; null until the hidden window says. */
  encoder: boolean | null;
  /** The job in hand (#838): its history item is `in_progress`, this is what changes as it runs. */
  current: {
    appId: string;
    jobId: string;
    key: string;
    /** When it was claimed, as its history item's `at`. */
    at: number;
    /** Sentence being done of `sentences` (0 of 0 before the first). */
    sentence: number;
    sentences: number;
    charsPerSecond: number;
    /** CPU time of every FreeAppStore process since the claim. */
    cpuMs: number | null;
    leaseExpiresAt: number;
    /** The audio is encoded and kept (the detail can play it); it is uploading. */
    encoded: boolean;
  } | null;
  /** Since the app started. */
  submitted: number;
  skipped: number;
  failed: number;
  /** Bumped when the history changes, so the window reads it again. */
  historyVersion: number;
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
    historyVersion: 0,
  };
  private controller: AbortController | null = null;
  private wakeUp: () => void = () => {};
  private looping = false;
  private loading = false;
  /** Bumped by `reset` (sign-out, #848): work from before it writes nothing. */
  private epoch = 0;

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

  /**
   * Sign-out or another account (#848): stop, forget what this account's run showed, and drop
   * whatever the job in hand, an upload or a verdict refresh still in flight would write later.
   */
  reset(): void {
    this.epoch++;
    this.stop();
    this.set({
      status: 'idle',
      message: null,
      apps: null,
      current: null,
      submitted: 0,
      skipped: 0,
      failed: 0,
      historyVersion: this.state.historyVersion + 1,
    });
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
      headers: {
        ...clientHeaders(this.host.context().appVersion ?? 'unknown'),
        Authorization: `Bearer ${token}`,
      },
    });
    if (response.status === 401) throw new Error('Not signed in.');
    if (!response.ok) throw new Error(`Looking for work failed (HTTP ${response.status}).`);
    return ((await response.json()) as { apps: GenerationOpenApp[] }).apps;
  }

  private async engine(): Promise<Engine> {
    const engine = await this.host.engine();
    this.set({
      encoder: engine.encoder !== null,
      model: {
        ...MODEL_INFO,
        bytes: MODEL_DOWNLOAD_BYTES,
        ready: this.host.modelReady(),
        loading: this.state.model?.loading ?? null,
        stage: this.state.model?.stage ?? 'download',
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
    let engine: Engine;
    try {
      engine = await this.engine();
    } catch (err) {
      return this.set({ status: 'idle', message: `Couldn't start generating: ${errorText(err)}` });
    }
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
    // Paused or disconnected while looking for work: there was no run to stop yet
    if (this.host.token() !== token) return;
    if (this.host.paused()) return this.set({ status: 'paused', message: null, current: null });
    const epoch = this.epoch;
    await this.run(engine, chosen);
    await this.verdicts(apps, epoch);
  }

  /** Copy the server's verdicts on this account's submissions into the history. */
  private async verdicts(apps: { appId: string; generation: Generation }[], epoch: number) {
    const items = this.host.history();
    const wanted = new Set(items.filter((i) => i.outcome === 'submitted').map((i) => i.appId));
    let changed = false;
    for (const { appId, generation } of apps) {
      if (!wanted.has(appId)) continue;
      const mine = await generation.mySubmissions().catch(() => []);
      for (const item of items) {
        const s = mine.find((m) => m.jobId === item.jobId);
        if (item.appId !== appId || !s) continue;
        item.verdict = {
          submissionId: s.submissionId,
          status: s.status,
          reason: s.reason,
          durationMs: s.durationMs,
          report: s.report,
        };
        changed = true;
      }
    }
    if (changed) this.saveHistory(items, epoch);
  }

  /**
   * Send this account's Good / Not good for an upload in the history (#831), with the device
   * credential, and keep it with the item. People judge the audio; nothing else does.
   */
  async report(
    appId: string,
    jobId: string,
    good: boolean,
    note: string,
  ): Promise<GenerationReport> {
    const token = this.host.token();
    const epoch = this.epoch;
    const items = this.host.history();
    const item = items.find((i) => i.appId === appId && i.jobId === jobId);
    const submissionId = item?.verdict?.submissionId;
    if (!token || !item?.verdict || !submissionId)
      throw new Error('Nothing uploaded to report on.');
    const generation = new Generation(appId, this.origin, { token, handleUnauthorized: () => {} });
    const report = await generation.report(submissionId, good, note || undefined);
    item.verdict.report = report;
    this.saveHistory(items, epoch);
    return report;
  }

  /** Writes nothing for an account signed out since `epoch` (#848). */
  private saveHistory(items: HistoryItem[], epoch: number) {
    if (epoch !== this.epoch) return;
    this.host.setHistory(items);
    this.set({ historyVersion: this.state.historyVersion + 1 });
  }

  /** Updates the In progress detail of `a`, if it is still the job in hand. */
  private live(a: Attempt, changes: Partial<NonNullable<ContributeState['current']>>) {
    const { current } = this.state;
    if (current?.jobId !== a.job.id || current.at !== a.at) return;
    this.set({ current: { ...current, ...changes, leaseExpiresAt: a.job.leaseExpiresAt } });
  }

  private same = (i: HistoryItem, a: Attempt) =>
    i.appId === a.appId && i.jobId === a.job.id && i.at === a.at;

  private item(
    a: Attempt,
    outcome: HistoryItem['outcome'],
    reason: string | null,
    record: GenerationAttemptRecord,
  ): HistoryItem {
    return {
      appId: a.appId,
      jobId: a.job.id,
      key: a.job.key,
      at: a.at,
      outcome,
      reason,
      text: a.job.input.text.slice(0, TEXT_CHARS),
      chars: a.job.input.text.length,
      record,
      verdict: null,
    };
  }

  /**
   * The job in hand goes on the record from its claim (#838), so it can be opened while it runs; a
   * run cut off with the app (quit, crash) is closed at the next start (`loadHistory`). Its record
   * so far names this computer; its `reason` is what it would end with then, never sent.
   */
  private begin(a: Attempt) {
    const record: GenerationAttemptRecord = {
      runner: 'desktop',
      reason: 'user_stop',
      ...this.host.context(),
      startedAt: a.at,
    };
    this.saveHistory([this.item(a, 'in_progress', null, record), ...this.host.history()], a.epoch);
    this.set({
      current: {
        appId: a.appId,
        jobId: a.job.id,
        key: a.job.key,
        at: a.at,
        sentence: 0,
        sentences: 0,
        charsPerSecond: 0,
        cpuMs: null,
        leaseExpiresAt: a.job.leaseExpiresAt,
        encoded: false,
      },
    });
  }

  /** Record how the job in hand ended, here and (the numbers) on the server. */
  private finish(
    a: Attempt | null,
    outcome: HistoryItem['outcome'],
    reason: string | null,
    err?: unknown,
  ) {
    if (!a) return;
    const end = this.host.probe();
    const now = Date.now();
    const timing = a.result?.timing;
    const segments = a.result?.meta.segments;
    const durationMs = segments?.length ? Math.round(segments.at(-1)![3] * 1000) : undefined;
    const record: GenerationAttemptRecord = {
      runner: 'desktop',
      reason: endReason(outcome, reason, err),
      ...(outcome !== 'submitted' && reason && { error: reason.slice(0, 300) }),
      ...this.host.context(),
      background: a.background || !end.foreground,
      ...(a.start.thermal && { thermalStart: a.start.thermal }),
      ...(end.thermal && { thermalEnd: end.thermal }),
      ...(a.start.charging !== undefined && { chargingStart: a.start.charging }),
      ...(end.charging !== undefined && { chargingEnd: end.charging }),
      startedAt: a.at,
      wallMs: now - a.at,
      ...timing,
      ...(outcome === 'submitted' && a.generatedAt && { uploadMs: now - a.generatedAt }),
      ...(a.start.cpuMs !== undefined &&
        end.cpuMs !== undefined && { cpuMs: Math.max(0, end.cpuMs - a.start.cpuMs) }),
      ...(a.peakMemMb && { peakMemMb: Math.round(a.peakMemMb) }),
      ...(a.result && { bytes: a.result.file.size }),
      ...(durationMs && { durationMs }),
      ...(durationMs && timing && { rtf: Math.round((timing.synthMs / durationMs) * 1000) / 1000 }),
    };
    const { job } = a;
    // In place of its In progress item (#838), if it got one
    this.saveHistory(
      [
        this.item(a, outcome, reason, record),
        ...this.host.history().filter((i) => !this.same(i, a)),
      ],
      a.epoch,
    );
    a.generation
      .recordAttempts([{ jobId: job.id, ...record }])
      .catch((e) => console.warn('contribute: attempt record not sent', e));
  }

  private async run(engine: Engine, apps: Parameters<typeof contributeKokoroApps>[0]['apps']) {
    const controller = new AbortController();
    this.controller = controller;
    const runner = this.host.createRunner(engine.encoder!);
    const epoch = this.epoch;
    this.set({ status: 'running', message: null, current: null });
    let attempt: Attempt | null = null;
    const sample = () => {
      const r = this.host.probe();
      if (attempt) {
        attempt.peakMemMb = Math.max(attempt.peakMemMb, r.memMb ?? 0);
        attempt.background ||= !r.foreground;
      }
      return r;
    };
    const start = (appId: string, job: GenerationJob) => {
      const reading = this.host.probe();
      attempt = {
        epoch,
        appId,
        generation: apps().find((a) => a.appId === appId)!.generation,
        job,
        at: Date.now(),
        start: reading,
        peakMemMb: reading.memMb ?? 0,
        background: !reading.foreground,
        result: null,
        generatedAt: null,
      };
    };
    const end = (outcome: HistoryItem['outcome'], reason: string | null, err?: unknown) => {
      this.finish(attempt, outcome, reason, err);
      attempt = null;
    };
    const onEvent = (e: KokoroEvent, appId: string) => {
      // Signed out since this run started: nothing more of it is shown or kept
      if (epoch !== this.epoch) return;
      if (e.type === 'claimed') {
        // A job still in hand at the next claim was abandoned when its lease ran out
        end('stopped', 'the lease ran out before it finished');
        start(appId, e.job);
        this.begin(attempt!);
      } else if (e.type === 'generated') {
        const a = attempt as Attempt | null;
        if (a?.job.id !== e.job.id) return;
        a.result = e.result;
        a.generatedAt = Date.now();
        sample();
        this.host
          .keepAudio(appId, e.job.id, e.result)
          .then(() => this.live(a, { encoded: true }))
          .catch((err) => console.warn('contribute: audio not kept', err));
      } else if (e.type === 'progress') {
        const r = sample();
        const a = attempt as Attempt | null;
        if (a?.job.id !== e.job.id) return;
        this.live(a, {
          sentence: e.progress.sentence,
          sentences: e.progress.sentences,
          charsPerSecond: e.progress.charsPerSecond,
          cpuMs:
            r.cpuMs !== undefined && a.start.cpuMs !== undefined
              ? Math.max(0, r.cpuMs - a.start.cpuMs)
              : null,
        });
      } else if (e.type === 'submitted') {
        end('submitted', null);
        this.set({ submitted: this.state.submitted + 1, current: null });
      } else if (e.type === 'skipped' || e.type === 'failed') {
        if ((attempt as Attempt | null)?.job.id !== e.job.id) start(appId, e.job);
        end(e.type, e.reason);
        if (e.type === 'skipped') this.set({ skipped: this.state.skipped + 1, current: null });
        else this.set({ failed: this.state.failed + 1, current: null });
      }
    };
    try {
      // contributeKokoroApps only calls the runner's generate(), which NativeRunner has
      await contributeKokoroApps({
        runner: runner as unknown as KokoroRunner,
        signal: controller.signal,
        apps,
        onEvent,
      });
      // A job still in hand when the run ends by itself ran out of lease (no event says so)
      end(
        'stopped',
        controller.signal.aborted
          ? 'stopped before it finished'
          : 'the lease ran out before it finished',
      );
      this.set({
        message: controller.signal.aborted
          ? null
          : 'No more work for now. FreeAppStore looks again every 15 minutes.',
      });
    } catch (err) {
      if (controller.signal.aborted) end('stopped', 'stopped before it finished');
      else end('failed', errorText(err), err);
      if (errorText(err) === 'Not signed in.') this.host.signedOut();
      else this.set({ message: `Stopped on an error: ${errorText(err)}` });
    } finally {
      runner.dispose(); // frees the model's memory until the next run
      this.controller = null;
      this.set({ status: this.host.paused() ? 'paused' : 'idle', current: null });
    }
  }

  /** Download, verify and unpack the model once the user agreed to its size. */
  async downloadModel(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const engine = await this.engine();
      if (!engine.encoder) return;
      const model = this.state.model!;
      this.set({ model: { ...model, loading: 0, stage: 'download' }, message: null });
      try {
        await this.host.installModel((stage, loading) =>
          this.set({ model: { ...model, loading, stage } }),
        );
        this.set({ model: { ...model, ready: true, loading: null } });
      } catch (err) {
        this.set({
          model: { ...model, loading: null },
          message: `The model didn't download: ${errorText(err)}`,
        });
      }
    } finally {
      this.loading = false;
    }
    this.wake();
  }

  /** Stop and delete the model's files. */
  async deleteModel(): Promise<void> {
    this.controller?.abort(new Error('Stopped'));
    await this.host.deleteModel();
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
