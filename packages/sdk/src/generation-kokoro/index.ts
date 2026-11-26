/**
 * Community generation with Kokoro TTS in the browser (`@freeappstore/sdk/generation-kokoro`):
 * the runner Books and the Creator Console share (platform#795, books#66). The model runs in a
 * Web Worker the app builds from `@freeappstore/sdk/generation-kokoro/worker`; this module only
 * talks to it, so it does not load the model code. `kokoro-js` and `mp4-muxer` are optional peer
 * dependencies, needed only by apps that import the worker.
 *
 * It generates exactly what a job asks for, or gives the job back: Kokoro v1.0 only, `audio/mp4`
 * only, params `{ voice, speed? }` only, English only (kokoro-js phonemizes English), within the
 * job's `maxBytes` and the 64 KB meta limit.
 */
import type {
  Generation,
  GenerationFormat,
  GenerationJob,
  GenerationModel,
} from '../generation.js';
import { narrationSentences } from './sentences.js';
import type {
  KokoroDevice,
  KokoroSegment,
  KokoroTiming,
  WorkerReply,
  WorkerRequest,
} from './shared.js';

export { narrationSentences } from './sentences.js';
export type { KokoroDevice, KokoroSegment, KokoroTiming } from './shared.js';

/** The model and version this runner generates with (what devices claim and sets must ask for). */
export const KOKORO_MODEL: GenerationModel = { model: 'kokoro', modelVersion: 'v1.0' };
/** The model's download per device: fp32 weights for WebGPU, q8 for WebAssembly (plus ~0.5 MB a voice). */
export const KOKORO_DOWNLOAD_BYTES: Record<KokoroDevice, number> = {
  webgpu: 325_532_232,
  wasm: 92_361_116,
};

const FORMAT: GenerationFormat = 'audio/mp4';
const PARAMS = new Set(['voice', 'speed']);
/** kokoro-js's voices: American and British English (`af_`, `am_`, `bf_`, `bm_`) */
const ENGLISH_VOICE = /^[ab][fm]_/;
/** The platform's limit on a submission's meta (docs/community-generation.md) */
const META_BYTES = 64 * 1024;
/** Upper bound of one segment's JSON, e.g. `[99999,100000,99999.999,99999.999],` */
const SEGMENT_BYTES = 40;
const LEASE_MS = 15 * 60_000;
/** A lease is extended to at most this long after its claim (platform#783) */
const LEASE_CAP_MS = 2 * 60 * 60_000;
/** Characters narrated per second of audio, with pauses (books#22: 10k chars is ~11 min) */
const CHARS_PER_SECOND = 14;
/**
 * Encoder settings to try, in order: 32 kbps mono speech at Kokoro's 24 kHz, so long chapters fit
 * 25 MB (platform#798), else what the browser's AAC encoder takes.
 */
const ENCODERS: AudioEncoderConfig[] = [
  { codec: 'mp4a.40.2', sampleRate: 24_000, numberOfChannels: 1, bitrate: 32_000 },
  { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 1, bitrate: 32_000 },
  { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 1, bitrate: 96_000 },
];

/** The AAC encoder settings this browser supports, or null (no WebCodecs AAC, e.g. Firefox, or no workers). */
export async function kokoroEncoder(): Promise<AudioEncoderConfig | null> {
  if (typeof Worker === 'undefined' || typeof AudioEncoder === 'undefined') return null;
  for (const config of ENCODERS) {
    if ((await AudioEncoder.isConfigSupported(config).catch(() => null))?.supported) return config;
  }
  return null;
}

/** WebGPU when this browser has an adapter, else WebAssembly. */
export async function kokoroDevice(): Promise<KokoroDevice> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  return gpu && (await gpu.requestAdapter().catch(() => null)) ? 'webgpu' : 'wasm';
}

const isModelCache = (name: string) => name.includes('transformers') || name === 'kokoro-voices';

/** Whether the model's weights are in this browser's Cache Storage. */
export async function isKokoroDownloaded(): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  for (const name of (await caches.keys()).filter(isModelCache)) {
    const keys = await (await caches.open(name)).keys();
    if (keys.some((r) => /Kokoro-82M-v1\.0-ONNX\/.*\/onnx\/model/.test(r.url))) return true;
  }
  return false;
}

/** Delete the downloaded model and voices (transformers.js's and kokoro-js's caches). */
export async function deleteKokoroModel(): Promise<void> {
  if (typeof caches === 'undefined') return;
  const names = (await caches.keys()).filter(isModelCache);
  await Promise.all(names.map((name) => caches.delete(name)));
}

/** A set or claimed job as far as the runner looks at it. */
export interface KokoroWork extends GenerationModel {
  params: Record<string, unknown>;
  formats: GenerationFormat[];
  maxBytes: number;
  /** The set's BCP 47 language tag (null or absent: none named). */
  language?: string | null;
  input?: { text: string };
}

/**
 * Why this runner can't generate `work` exactly, or null when it can. A set is checked for its
 * model, format, params and language: English only, so a set naming another language (such as
 * `zh`) or using a non-English voice is skipped (platform#812; the phone runners speak Mandarin).
 * A claimed job (with `input` and `encoder`) is also checked for the size of its audio and meta.
 * That the voice exists is checked once the model is loaded.
 */
export function kokoroProblem(work: KokoroWork, encoder?: AudioEncoderConfig): string | null {
  if (work.model !== KOKORO_MODEL.model || work.modelVersion !== KOKORO_MODEL.modelVersion)
    return `model ${work.model} ${work.modelVersion}`;
  if (!work.formats.includes(FORMAT)) return 'no audio/mp4 format';
  const unknown = Object.keys(work.params).filter((k) => !PARAMS.has(k));
  if (unknown.length) return `unknown params ${unknown.join(', ')}`;
  const { voice, speed = 1 } = work.params;
  if (typeof voice !== 'string' || !voice) return 'no voice';
  if (typeof speed !== 'number' || !(speed > 0) || !Number.isFinite(speed)) return 'invalid speed';
  const language = work.language?.split('-')[0]?.toLowerCase();
  if (language && language !== 'en')
    return `language ${work.language}: this browser runner speaks English only`;
  if (!ENGLISH_VOICE.test(voice))
    return `voice ${voice} is not English: this browser runner speaks English only`;
  if (!work.input || !encoder) return null;
  const { text } = work.input;
  const bytes = (((text.length / CHARS_PER_SECOND / speed) * (encoder.bitrate ?? 0)) / 8) * 1.1;
  if (bytes > work.maxBytes) return 'audio would exceed maxBytes';
  if (narrationSentences(text).length * SEGMENT_BYTES + 16 > META_BYTES)
    return 'sentence timings would exceed 64 KB';
  return null;
}

/** A claimed job this device gives back (it can't do it exactly, or not within the lease). */
export class KokoroSkip extends Error {
  constructor(
    readonly job: GenerationJob,
    reason: string,
  ) {
    super(reason);
    this.name = 'KokoroSkip';
  }
}

export interface KokoroProgress {
  /** Sentences done, of `sentences`. */
  sentence: number;
  sentences: number;
  /** Characters done, of `totalChars`. */
  chars: number;
  totalChars: number;
  /** Characters narrated per second of wall time so far. */
  charsPerSecond: number;
}

export interface KokoroRunnerOptions {
  /** Starts the app's worker module, which calls `serveKokoroWorker()`. */
  createWorker: () => Worker;
  /** From `kokoroEncoder()`. */
  encoder: AudioEncoderConfig;
  /** From `kokoroDevice()`; WebGPU falls back to WebAssembly if the model fails to load there. */
  device: KokoroDevice;
}

export interface KokoroResult {
  file: Blob;
  meta: { segments: KokoroSegment[] };
  /** Wall time of the worker's stages (#827); absent from a worker built from an older SDK. */
  timing?: KokoroTiming;
}

/** Generates jobs one at a time in a Web Worker, which keeps the model loaded between jobs. */
export class KokoroRunner {
  private worker: Worker | null = null;
  private ids = 0;

  constructor(private readonly opts: KokoroRunnerOptions) {}

  /** Download (unless cached) and load the model, e.g. once the user agreed to the download. */
  load(onLoading?: (progress: number) => void): Promise<void> {
    this.worker ??= this.opts.createWorker();
    const w = this.worker;
    const id = ++this.ids;
    return new Promise<void>((resolve, reject) => {
      const onMessage = (e: MessageEvent<WorkerReply>) => {
        const msg = e.data;
        if (msg.type === 'loading') return onLoading?.(msg.progress);
        if (msg.id !== id || (msg.type !== 'loaded' && msg.type !== 'error')) return;
        w.removeEventListener('message', onMessage);
        if (msg.type === 'loaded') resolve();
        else reject(new Error(msg.message));
      };
      w.addEventListener('message', onMessage);
      w.postMessage({ type: 'load', id, device: this.opts.device } satisfies WorkerRequest);
    });
  }

  /**
   * The job's audio (`audio/mp4`) and meta `{ segments }`. Rejects with `KokoroSkip` when the job
   * can't be done exactly or would not finish within its lease's 2-hour cap, and with
   * `signal.reason` when aborted.
   */
  generate(
    job: GenerationJob,
    hooks: {
      signal?: AbortSignal;
      /** Model download, 0-1 (only while it is not cached). */
      onLoading?: (progress: number) => void;
      onProgress?: (progress: KokoroProgress) => void;
    } = {},
  ): Promise<KokoroResult> {
    const { signal, onLoading, onProgress } = hooks;
    const problem = kokoroProblem(job, this.opts.encoder);
    if (problem) return Promise.reject(new KokoroSkip(job, problem));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const text = job.input.text;
    const { voice, speed = 1 } = job.params as { voice: string; speed?: number };
    // Before `contribute` extends the lease, its expiry is 15 minutes after the claim
    const capAt = job.leaseExpiresAt - LEASE_MS + LEASE_CAP_MS;
    const started = Date.now();
    this.worker ??= this.opts.createWorker();
    const w = this.worker;
    const id = ++this.ids;
    return new Promise<KokoroResult>((resolve, reject) => {
      const finish = (fn: () => void) => {
        w.removeEventListener('message', onMessage);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const cancel = () => w.postMessage({ type: 'cancel' } satisfies WorkerRequest);
      const onAbort = () => {
        cancel();
        finish(() => reject(signal!.reason));
      };
      const onMessage = (e: MessageEvent<WorkerReply>) => {
        const msg = e.data;
        if (msg.type === 'loading') return onLoading?.(msg.progress);
        if (msg.id !== id) return; // a cancelled job's last word, or a load
        if (msg.type === 'progress') {
          const elapsed = Date.now() - started;
          onProgress?.({
            sentence: msg.done,
            sentences: msg.total,
            chars: msg.chars,
            totalChars: text.length,
            charsPerSecond: msg.chars / Math.max(elapsed / 1000, 0.001),
          });
          // At this pace it would run past the lease's cap: give it back now rather than at the end
          if (elapsed > 2 * 60_000 && started + (elapsed * text.length) / msg.chars > capAt) {
            cancel();
            finish(() => reject(new KokoroSkip(job, 'too slow to finish within the lease')));
          }
        } else if (msg.type === 'done') {
          const meta = { segments: msg.segments };
          const problem =
            msg.file.size > job.maxBytes
              ? 'audio exceeds maxBytes'
              : JSON.stringify(meta).length > META_BYTES
                ? 'sentence timings exceed 64 KB'
                : null;
          finish(() =>
            problem
              ? reject(new KokoroSkip(job, problem))
              : resolve({ file: msg.file, meta, ...(msg.timing && { timing: msg.timing }) }),
          );
        } else if (msg.type === 'error') {
          finish(() =>
            reject(msg.skip ? new KokoroSkip(job, msg.message) : new Error(msg.message)),
          );
        }
      };
      w.addEventListener('message', onMessage);
      signal?.addEventListener('abort', onAbort);
      w.postMessage({
        type: 'narrate',
        id,
        text,
        voice,
        speed,
        config: this.opts.encoder,
        device: this.opts.device,
      } satisfies WorkerRequest);
    });
  }

  /** Stop the worker and free the model's memory (its files stay cached). */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

export type KokoroEvent =
  | { type: 'loading'; progress: number }
  | { type: 'claimed'; job: GenerationJob }
  | { type: 'progress'; job: GenerationJob; progress: KokoroProgress }
  /** The job's audio is ready and about to upload (#827): for the device's own history. */
  | { type: 'generated'; job: GenerationJob; result: KokoroResult }
  | { type: 'submitted'; job: GenerationJob; submitted: number }
  | { type: 'skipped'; job: GenerationJob; reason: string }
  /** `contributeKokoroApps` only: a claimed job that failed (e.g. its upload never got through). */
  | { type: 'failed'; job: GenerationJob; reason: string };

type Turn =
  | { outcome: 'submitted'; job: GenerationJob }
  | { outcome: 'skipped' | 'failed'; job: GenerationJob }
  | { outcome: 'no-work' | 'aborted' | 'lease-expired' };

/**
 * One job of `setId` (any set when undefined): claim → generate → submit through
 * `generation.contribute`, which retries transient failures and keeps the lease. The lease is
 * renewed on every message from the worker, so it holds where the page's timers are throttled
 * (a background tab). A job the runner gives back is reported `skipped`: the next claim releases
 * it, and it is never offered to this user again. Any other failure after the claim is thrown
 * with the job attached as `failedJob`.
 */
async function kokoroTurn(
  generation: Generation,
  runner: KokoroRunner,
  signal: AbortSignal,
  setId: string | undefined,
  onEvent?: (event: KokoroEvent) => void,
): Promise<Turn> {
  let claimed: GenerationJob | null = null;
  try {
    const { submitted, stopped } = await generation.contribute({
      ...(setId !== undefined && { setId }),
      models: [KOKORO_MODEL],
      signal,
      limit: 1,
      generate: async (job, lease) => {
        const result = await runner.generate(job, {
          signal,
          onLoading: (progress) => {
            void lease.renew();
            onEvent?.({ type: 'loading', progress });
          },
          onProgress: (progress) => {
            void lease.renew();
            onEvent?.({ type: 'progress', job, progress });
          },
        });
        onEvent?.({ type: 'generated', job, result });
        return result;
      },
      onProgress: ({ stage, job }) => {
        if (stage === 'generating') {
          claimed = job;
          onEvent?.({ type: 'claimed', job });
        }
      },
    });
    if (submitted && claimed) return { outcome: 'submitted', job: claimed };
    return { outcome: stopped === 'limit' ? 'lease-expired' : stopped };
  } catch (err) {
    if (signal.aborted) return { outcome: 'aborted' };
    if (!(err instanceof KokoroSkip)) throw Object.assign(err as object, { failedJob: claimed });
    onEvent?.({ type: 'skipped', job: err.job, reason: err.message });
    return { outcome: 'skipped', job: err.job };
  }
}

/**
 * Claim → generate → submit with `runner` through `generation.contribute` (which extends each
 * lease while generating) until there is no work or `signal` aborts. A job the runner gives back
 * is skipped: the next claim releases it, and it is never offered to this user again.
 */
export async function contributeKokoro(
  generation: Generation,
  opts: {
    runner: KokoroRunner;
    signal: AbortSignal;
    /** Only this set; check it with `kokoroProblem` first, or each of its jobs is claimed and skipped. */
    setId?: string;
    onEvent?: (event: KokoroEvent) => void;
  },
): Promise<{ submitted: number; stopped: 'no-work' | 'aborted' }> {
  const { runner, signal, setId, onEvent } = opts;
  let submitted = 0;
  while (!signal.aborted) {
    const turn = await kokoroTurn(generation, runner, signal, setId, onEvent);
    if (turn.outcome === 'no-work') return { submitted, stopped: 'no-work' };
    if (turn.outcome === 'submitted')
      onEvent?.({ type: 'submitted', job: turn.job, submitted: ++submitted });
    // A skip or a lease that ran out: claim the next job
  }
  return { submitted, stopped: 'aborted' };
}

/** An app `contributeKokoroApps` generates for: its `Generation` and the sets to claim from, in order. */
export interface KokoroApp {
  appId: string;
  generation: Generation;
  /** Sets this runner can do (`kokoroProblem` null), so none of their jobs is claimed only to be skipped. */
  setIds: string[];
}

/**
 * Generate for several apps the way the phone runners do (platform#819): one job from each app in
 * turn, not one app drained before the next. `apps` is read again before each turn, so an app
 * turned off mid-run is left out. An app leaves the run once none of its sets has a job for this
 * user, or a job of it is not submitted (skipped, its lease ran out, or it failed: reported as a
 * `failed` event and the run goes on). Ends with `no-work` once every app has left, or `aborted`.
 * A claim that still fails after its retries, or a lost sign-in, is thrown.
 */
export async function contributeKokoroApps(opts: {
  runner: KokoroRunner;
  signal: AbortSignal;
  apps: () => KokoroApp[];
  onEvent?: (event: KokoroEvent, appId: string) => void;
}): Promise<{ submitted: number; stopped: 'no-work' | 'aborted' }> {
  const { runner, signal, apps, onEvent } = opts;
  const done = new Set<string>(); // app ids, and `appId setId` for sets with no work
  let submitted = 0;
  while (!signal.aborted) {
    const round = apps().filter((app) => !done.has(app.appId));
    if (!round.length) return { submitted, stopped: 'no-work' };
    for (const { appId } of round) {
      const app = apps().find((a) => a.appId === appId);
      if (signal.aborted) break;
      if (!app) continue;
      const emit = (event: KokoroEvent) => onEvent?.(event, appId);
      let turn: Turn = { outcome: 'no-work' };
      for (const setId of app.setIds) {
        if (done.has(`${appId} ${setId}`)) continue;
        try {
          turn = await kokoroTurn(app.generation, runner, signal, setId, emit);
        } catch (err) {
          const job = (err as { failedJob?: GenerationJob | null }).failedJob;
          if (!job || (err as Error).message === 'Not signed in.') throw err;
          emit({ type: 'failed', job, reason: err instanceof Error ? err.message : String(err) });
          turn = { outcome: 'failed', job };
        }
        if (turn.outcome !== 'no-work') break;
        done.add(`${appId} ${setId}`);
      }
      if (turn.outcome === 'aborted') break;
      if (turn.outcome === 'submitted')
        emit({ type: 'submitted', job: turn.job, submitted: ++submitted });
      else done.add(appId);
    }
  }
  return { submitted, stopped: 'aborted' };
}
