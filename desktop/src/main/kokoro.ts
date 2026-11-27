import type { GenerationJob } from '@freeappstore/sdk';
import {
  KOKORO_MODEL,
  KokoroError,
  type KokoroProgress,
  type KokoroResult,
  type KokoroSegment,
  KokoroSkip,
  type KokoroStage,
  type KokoroWork,
} from '@freeappstore/sdk/generation-kokoro';

/**
 * Kokoro v1.0 on the desktop as the phones run it (#837): sherpa-onnx's offline TTS with the
 * multi-language package (`model.ts`), in a utility process (`tts.ts`), CPU only. The same voices,
 * language rule (#812) and sentence splitting as android `Kokoro.kt` / `Generation.kt`, so a set
 * the phones take (Mandarin, Spanish) is taken here too. AAC encoding is the hidden window's
 * (WebCodecs); this module only drives both, a sentence at a time.
 */

/** Speaker ids of the package's `voices.bin`, from the sherpa-onnx model docs (android `KokoroModel.VOICES`). */
// biome-ignore format: ten speaker ids a row
export const VOICES = [
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah',
  'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis', 'ef_dora', 'em_alex',
  'ff_siwis', 'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi', 'if_sara', 'im_nicola', 'jf_alpha', 'jf_gongitsune', 'jf_nezumi',
  'jf_tebukuro', 'jm_kumo', 'pf_dora', 'pm_alex', 'pm_santa', 'zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi', 'zm_yunjian',
  'zm_yunxi', 'zm_yunxia', 'zm_yunyang', 'em_santa',
];

/** How a job is spoken: English, Spanish or Mandarin (#812). */
export type Language = 'en' | 'es' | 'zh';
export const LANGUAGES: Record<Language, string> = { en: 'English', es: 'Spanish', zh: 'Mandarin' };
/** What this engine is, for Contribute and the In progress detail. */
export const ENGINE = 'Kokoro v1.0 (sherpa-onnx, CPU)';

/**
 * How a job with `voice` from a set naming `tag` is spoken, or null (android `KokoroModel.language`).
 * No tag: by the voice, Mandarin for `z…`, Spanish for `e…`, otherwise English. A tag must be `en`
 * (with an `a…`/`b…` voice), `es` or `zh` (any `zh-…`) and agree with the voice.
 */
export function kokoroLanguage(voice: string, tag: string | null | undefined): Language | null {
  const first = voice[0];
  const byVoice: Language = first === 'z' ? 'zh' : first === 'e' ? 'es' : 'en';
  if (tag === null || tag === undefined) return byVoice;
  const primary = tag.split('-')[0]!.toLowerCase();
  const named =
    primary === 'en'
      ? first === 'a' || first === 'b'
        ? 'en'
        : null
      : primary === 'es' || primary === 'zh'
        ? primary
        : null;
  return named === byVoice ? named : null;
}

const PARAGRAPH = /\S[\s\S]*?(?=\s*\n\s*\n|\s*$)/g;
/** Where a sentence ends and which `.` does not end one, per language (Books' profiles; Mandarin #812). */
const PROFILES: Record<Language, { end: RegExp; abbreviation: RegExp | null }> = {
  en: {
    end: /[.!?…]+[”’"')\]]*(?=\s+(?![a-z]))/g,
    abbreviation: /\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|Rev|Capt|Col|Gen|Lt|Mt|[A-HJ-Z])$/,
  },
  es: {
    end: /[.!?…]+[”’"')\]»]*(?=\s+(?![a-záéíóúüñ]|[—-]+\s?[a-záéíóúüñ]))/gu,
    abbreviation:
      /(?<![\p{L}\p{N}_])(?:Sr|Sra|Srta|Sres|Srs|Dr|Dra|Dña|Ud|Uds|Vd|Vds|Vmd|Excmo|Excma|Ilmo|Ilma|Rvdo|Sto|Sta|Fr|Pbro|[A-ZÁÉÍÓÚÑ])$/u,
  },
  // No spaces between Mandarin sentences: any 。！？；… (or ASCII form) ends one, but not 3.5
  zh: { end: /(?:[。！？；…!?;]|\.(?!\d))+[”’"')\]）」』】》]*/g, abbreviation: null },
};

/**
 * [start, end, endsParagraph] of every sentence of `content`, as Books narrates them (android
 * `Sentences.split`; English as the SDK's `narrationSentences`). Offsets are string indices.
 */
export function sentences(content: string, language: Language): [number, number, boolean][] {
  const { end, abbreviation } = PROFILES[language];
  const out: [number, number, boolean][] = [];
  for (const para of content.matchAll(PARAGRAPH)) {
    const from = para.index;
    const text = para[0];
    let start = from;
    for (const m of text.matchAll(end)) {
      const at = from + m.index;
      if (m[0] === '.' && abbreviation?.test(content.slice(start, at))) continue;
      const stop = at + m[0].length;
      out.push([start, stop, false]);
      const rest = text.slice(stop - from);
      start = stop + rest.length - rest.trimStart().length;
    }
    if (start < from + text.length) out.push([start, from + text.length, false]);
    out[out.length - 1]![2] = true;
  }
  return out;
}

const FORMAT = 'audio/mp4';
const META_BYTES = 64 * 1024;
/** Upper bound of one segment's JSON, e.g. `[99999,100000,99999.999,99999.999],` */
const SEGMENT_BYTES = 40;
/** Characters spoken per second of audio, with pauses, for the size estimate (server bands: zh 2-9). */
const CHARS_PER_SECOND: Record<Language, number> = { en: 14, es: 14, zh: 4 };
const LEASE_MS = 15 * 60_000;
/** A lease is extended to at most this long after its claim (platform#783). */
const LEASE_CAP_MS = 2 * 60 * 60_000;
/** Silence after a sentence and after a paragraph, in seconds (Books). */
const SENTENCE_PAUSE = 0.4;
const PARAGRAPH_PAUSE = 0.8;
/** Shorter audio gets silence at the end, so 对。 is within the server's characters-per-second floor (#812). */
const MIN_SECONDS = 1;

/**
 * Why this engine can't generate `work` exactly, or null when it can (the phones' rules): Kokoro
 * v1.0, `audio/mp4`, params `{ voice, speed? }` with a voice of the package and speed 0.5-2, and a
 * language it speaks with that voice. A claimed job (with `input`, and the encoder's `bitrate`) is
 * also checked for the likely size of its audio and of its sentence timings.
 */
export function kokoroProblem(work: KokoroWork, bitrate?: number): string | null {
  if (work.model !== KOKORO_MODEL.model || work.modelVersion !== KOKORO_MODEL.modelVersion)
    return `model ${work.model} ${work.modelVersion}`;
  if (!work.formats.includes(FORMAT)) return 'no audio/mp4 format';
  const unknown = Object.keys(work.params).filter((k) => k !== 'voice' && k !== 'speed');
  if (unknown.length) return `unknown params ${unknown.join(', ')}`;
  const { voice, speed = 1 } = work.params;
  if (typeof voice !== 'string' || !voice) return 'no voice';
  if (!VOICES.includes(voice)) return `unknown voice ${voice}`;
  if (typeof speed !== 'number' || !(speed >= 0.5 && speed <= 2)) return 'speed must be 0.5-2';
  const language = kokoroLanguage(voice, work.language);
  if (!language) return `language ${work.language} with voice ${voice}`;
  if (!work.input || !bitrate) return null;
  const { text } = work.input;
  const seconds = text.length / CHARS_PER_SECOND[language] / speed;
  if (((seconds * bitrate) / 8) * 1.1 > work.maxBytes) return 'audio would exceed maxBytes';
  if (sentences(text, language).length * SEGMENT_BYTES + 16 > META_BYTES)
    return 'sentence timings would exceed 64 KB';
  return null;
}

/** One sentence's audio from the TTS process; `loadMs` is the time spent loading the model first. */
export interface Speech {
  samples: Float32Array;
  sampleRate: number;
  loadMs: number;
}

export interface NativeRunnerOptions {
  /** Speaks one sentence (`tts.ts`); Mandarin gets its own engine with the number and date rules. */
  say(text: string, sid: number, speed: number, mandarin: boolean): Promise<Speech>;
  /** Starts an AAC encoding of mono samples at `sampleRate` (the hidden window). */
  encode(sampleRate: number): Encoding;
  /** The encoder's bitrate, for the size estimate. */
  bitrate: number;
  /** Frees the model's memory (ends the TTS process). */
  dispose(): void;
  /** How long to rest after a sentence that took `ms` to speak (#830); none when absent. */
  rest?(ms: number): number;
}

/** An AAC encoding in progress: samples go in as they are spoken; `finish` returns the MP4. */
export interface Encoding {
  write(samples: Float32Array): void;
  finish(): Promise<Uint8Array>;
  cancel(): void;
}

const round = (s: number) => Math.round(s * 1000) / 1000;

/** `promise`, or `signal`'s reason once it aborts. */
function unlessAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Generates a job the way the phones do: a sentence at a time, joined by Books' pauses, each one
 * encoded as soon as it is spoken. It stands in for the SDK's `KokoroRunner` in
 * `contributeKokoroApps` (which only calls `generate`): `KokoroSkip` gives a job back.
 */
export class NativeRunner {
  constructor(private readonly opts: NativeRunnerOptions) {}

  async generate(
    job: GenerationJob,
    hooks: { signal?: AbortSignal; onProgress?: (progress: KokoroProgress) => void } = {},
  ): Promise<KokoroResult> {
    const { signal, onProgress } = hooks;
    const problem = kokoroProblem(job, this.opts.bitrate);
    if (problem) throw new KokoroSkip(job, problem);
    if (signal?.aborted) throw signal.reason;
    const { voice, speed = 1 } = job.params as { voice: string; speed?: number };
    const language = kokoroLanguage(voice, job.language)!;
    const text = job.input.text;
    const parts = sentences(text, language);
    // Before `contribute` extends the lease, its expiry is 15 minutes after the claim
    const capAt = job.leaseExpiresAt - LEASE_MS + LEASE_CAP_MS;
    const timing = { loadMs: 0, synthMs: 0, encodeMs: 0 };
    const started = Date.now();
    const segments: KokoroSegment[] = [];
    let encoding: Encoding | null = null;
    let rate = 24_000;
    let length = 0; // samples written
    let pause = 0; // seconds of silence before the next sentence
    let done = false;
    /** Where a failure happened (#813): speaking, or encoding. */
    let stage: KokoroStage = 'synth';
    try {
      for (const [n, [start, end, endsParagraph]] of parts.entries()) {
        let t = Date.now();
        stage = 'synth';
        const speech = await unlessAborted(
          this.opts.say(text.slice(start, end), VOICES.indexOf(voice), speed, language === 'zh'),
          signal,
        );
        const sentenceMs = Date.now() - t - speech.loadMs;
        timing.loadMs += speech.loadMs;
        timing.synthMs += sentenceMs;
        if (speech.samples.length) {
          t = Date.now();
          stage = 'encode';
          if (!encoding) {
            rate = speech.sampleRate;
            encoding = this.opts.encode(rate);
          }
          if (pause) {
            encoding.write(new Float32Array(Math.round(pause * rate)));
            length += Math.round(pause * rate);
          }
          segments.push([
            start,
            end,
            round(length / rate),
            round((length + speech.samples.length) / rate),
          ]);
          encoding.write(speech.samples);
          length += speech.samples.length;
          pause = endsParagraph ? PARAGRAPH_PAUSE : SENTENCE_PAUSE;
          timing.encodeMs += Date.now() - t;
        }
        // Pace is measured without the model's load
        const elapsed = Math.max(Date.now() - started - timing.loadMs, 1);
        onProgress?.({
          sentence: n + 1,
          sentences: parts.length,
          chars: end,
          totalChars: text.length,
          charsPerSecond: end / (elapsed / 1000),
        });
        // At this pace it would run past the lease's cap: give it back now rather than at the end
        if (elapsed > 2 * 60_000 && Date.now() + (elapsed * (text.length - end)) / end > capAt)
          throw new KokoroSkip(job, 'too slow to finish within the lease');
        const rest = n < parts.length - 1 ? (this.opts.rest?.(sentenceMs) ?? 0) : 0;
        if (rest > 0)
          await unlessAborted(new Promise((resolve) => setTimeout(resolve, rest)), signal);
      }
      if (!encoding) throw new KokoroSkip(job, 'nothing to say in the text');
      stage = 'encode';
      const t = Date.now();
      const short = Math.round(MIN_SECONDS * rate) - length;
      if (short > 0) encoding.write(new Float32Array(short));
      const bytes = await unlessAborted(encoding.finish(), signal);
      done = true;
      timing.encodeMs += Date.now() - t;
      const file = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: FORMAT });
      const meta = { segments };
      if (file.size > job.maxBytes) throw new KokoroSkip(job, 'audio exceeds maxBytes');
      if (JSON.stringify(meta).length > META_BYTES)
        throw new KokoroSkip(job, 'sentence timings exceed 64 KB');
      return { file, meta, timing };
    } catch (err) {
      // A give-back, a stop or the lease's cap stays as it is; anything else failed in `stage`
      if (signal?.aborted || err instanceof KokoroSkip || err instanceof KokoroError) throw err;
      throw new KokoroError(err instanceof Error ? err.message : String(err), stage);
    } finally {
      if (!done) (encoding as Encoding | null)?.cancel();
    }
  }

  /** Frees the model's memory; its files stay. */
  dispose(): void {
    this.opts.dispose();
  }
}
