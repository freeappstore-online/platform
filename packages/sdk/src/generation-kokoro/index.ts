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
import type { KokoroDevice, KokoroSegment, WorkerReply, WorkerRequest } from './shared.js';

export { narrationSentences } from './sentences.js';
export type { KokoroDevice, KokoroSegment } from './shared.js';

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
            problem ? reject(new KokoroSkip(job, problem)) : resolve({ file: msg.file, meta }),
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
  | { type: 'submitted'; job: GenerationJob; submitted: number }
  | { type: 'skipped'; job: GenerationJob; reason: string };

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
    try {
      const { stopped } = await generation.contribute({
        ...(setId !== undefined && { setId }),
        models: [KOKORO_MODEL],
        signal,
        generate: (job) =>
          runner.generate(job, {
            signal,
            onLoading: (progress) => onEvent?.({ type: 'loading', progress }),
            onProgress: (progress) => onEvent?.({ type: 'progress', job, progress }),
          }),
        onProgress: ({ stage, job }) => {
          if (stage === 'generating') onEvent?.({ type: 'claimed', job });
          else onEvent?.({ type: 'submitted', job, submitted: ++submitted });
        },
      });
      if (stopped === 'no-work') return { submitted, stopped };
      // A lease that ran out: claim the next job
    } catch (err) {
      if (signal.aborted) break;
      if (!(err instanceof KokoroSkip)) throw err;
      onEvent?.({ type: 'skipped', job: err.job, reason: err.message });
    }
  }
  return { submitted, stopped: 'aborted' };
}
