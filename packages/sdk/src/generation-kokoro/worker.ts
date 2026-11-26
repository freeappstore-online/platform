/**
 * The Kokoro narrator's Web Worker body (`@freeappstore/sdk/generation-kokoro/worker`). An app
 * runs it from its own worker module, so its bundler builds the worker and the model's runtime:
 *
 *   // kokoro.worker.ts
 *   import { serveKokoroWorker } from '@freeappstore/sdk/generation-kokoro/worker'
 *   serveKokoroWorker()
 *
 * As Books' scripts/audio/generate.py does (books#66): Kokoro v1.0 speaks the text a sentence at
 * a time (`narrationSentences`), with 0.4 s between sentences and 0.8 s between paragraphs, so each
 * sentence's time is exact: segments [[charStart, charEnd, startSec, endSec], …]. The audio is
 * encoded as it comes (WebCodecs AAC, mono) into an MP4, so a long text never sits in memory as
 * raw samples. The model runs on WebGPU (fp32) when asked and available, else in WebAssembly (q8);
 * transformers.js keeps its files in Cache Storage for the next job.
 *
 * main → worker: { type: 'narrate', id, text, voice, speed, config, device } | { type: 'load', id, device }
 *              | { type: 'cancel' }
 * worker → main: { type: 'loading', progress } | { type: 'loaded', id } | { type: 'progress', id, done, total, chars }
 *              | { type: 'done', id, file: Blob, segments } | { type: 'error', id, message, skip? }
 * A new narrate, or cancel, stops the text in progress at its next sentence.
 */
import { env, KokoroTTS } from 'kokoro-js';
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { narrationSentences } from './sentences.js';
import {
  KOKORO_REPO,
  type KokoroDevice,
  type KokoroSegment,
  type WorkerReply,
  type WorkerRequest,
} from './shared.js';

const RATE = 24_000; // Kokoro's sample rate
const SENTENCE_PAUSE = 0.4;
const PARAGRAPH_PAUSE = 0.8;
/** Characters Kokoro speaks in one go; its input is cut at 510 tokens, so longer sentences go in pieces */
const PIECE = 300;

export interface KokoroWorkerOptions {
  /**
   * Where the ONNX runtime's WebAssembly files are (transformers.js `env.wasmPaths`), e.g. served
   * by the app itself. Default: transformers.js's CDN.
   */
  wasmPaths?: string | { wasm?: string; mjs?: string };
}

let tts: Promise<KokoroTTS> | null = null;
/** The text being narrated; any other stops at its next sentence */
let active: number | null = null;

function post(message: WorkerReply) {
  (globalThis as unknown as { postMessage(message: unknown): void }).postMessage(message);
}

/** A job this device can't do exactly; the main thread gives it back. */
class Unsupported extends Error {}

async function load(device: KokoroDevice): Promise<KokoroTTS> {
  const progress_callback = (p: { status: string; progress?: number }) => {
    if (p.status === 'progress' && p.progress !== undefined)
      post({ type: 'loading', progress: p.progress / 100 });
  };
  if (device === 'webgpu') {
    try {
      return await KokoroTTS.from_pretrained(KOKORO_REPO, {
        dtype: 'fp32',
        device: 'webgpu',
        progress_callback,
      });
    } catch {}
  }
  return KokoroTTS.from_pretrained(KOKORO_REPO, { dtype: 'q8', device: 'wasm', progress_callback });
}

/** `text` in pieces of at most PIECE characters, cut after a comma, semicolon or dash, else a space. */
function pieces(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > PIECE) {
    const head = rest.slice(0, PIECE);
    const space = head.lastIndexOf(' ');
    const cut =
      Math.max(...[...head.matchAll(/[,;:—–]\s/g)].map((m) => m.index + 1), 0) ||
      (space > 0 ? space : PIECE);
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  return [...out, rest.trim()];
}

/** Kokoro's samples for a sentence; empty when there is nothing to say (e.g. "* * *"). */
async function say(
  model: KokoroTTS,
  text: string,
  voice: string,
  speed: number,
): Promise<Float32Array<ArrayBuffer>> {
  const parts: Float32Array[] = [];
  for (const piece of pieces(text)) {
    if (!/[\p{L}\p{N}]/u.test(piece)) continue;
    parts.push((await model.generate(piece, { voice: voice as 'af_heart', speed })).audio);
  }
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Kokoro's 24 kHz samples at the encoder's rate (24 or 48 kHz) */
function resample(samples: Float32Array<ArrayBuffer>, rate: number): Float32Array<ArrayBuffer> {
  if (rate === RATE) return samples;
  const out = new Float32Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    out[2 * i] = s;
    out[2 * i + 1] = (s + (samples[i + 1] ?? s)) / 2;
  }
  return out;
}

const round = (s: number) => Math.round(s * 1000) / 1000;

/** The model, loaded (downloaded on first use) once per worker. */
async function model(device: KokoroDevice): Promise<KokoroTTS> {
  tts ??= load(device);
  return tts.catch((err) => {
    tts = null;
    throw err;
  });
}

async function narrate(
  id: number,
  text: string,
  voice: string,
  speed: number,
  config: AudioEncoderConfig,
  device: KokoroDevice,
) {
  const tts = await model(device);
  if (!Object.hasOwn(tts.voices, voice)) throw new Unsupported(`unknown voice ${voice}`);
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    audio: { codec: 'aac', numberOfChannels: 1, sampleRate: config.sampleRate },
    fastStart: 'in-memory',
  });
  let failure: unknown = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => {
      failure = e;
    },
  });
  encoder.configure(config);
  let frames = 0; // at Kokoro's rate
  const feed = (samples: Float32Array<ArrayBuffer>) => {
    const data = resample(samples, config.sampleRate);
    encoder.encode(
      new AudioData({
        format: 'f32',
        sampleRate: config.sampleRate,
        numberOfChannels: 1,
        numberOfFrames: data.length,
        timestamp: Math.round((frames / RATE) * 1e6),
        data,
      }),
    );
    frames += samples.length;
  };
  const segments: KokoroSegment[] = [];
  const sentences = narrationSentences(text);
  let pause = 0;
  try {
    for (const [n, [start, end, endsParagraph]] of sentences.entries()) {
      if (active !== id) throw new Error('cancelled');
      if (failure) throw failure;
      const samples = await say(tts, text.slice(start, end), voice, speed);
      if (samples.length) {
        if (pause) feed(new Float32Array(Math.round(pause * RATE)));
        segments.push([start, end, round(frames / RATE), round((frames + samples.length) / RATE)]);
        feed(samples);
        pause = endsParagraph ? PARAGRAPH_PAUSE : SENTENCE_PAUSE;
      }
      post({ type: 'progress', id, done: n + 1, total: sentences.length, chars: end });
    }
    await encoder.flush();
    if (failure) throw failure;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  muxer.finalize();
  return { file: new Blob([muxer.target.buffer], { type: 'audio/mp4' }), segments };
}

/** Serve narrate/cancel messages from the main thread's `KokoroRunner`. Call once, in a module worker. */
export function serveKokoroWorker(options: KokoroWorkerOptions = {}): void {
  if (options.wasmPaths) env.wasmPaths = options.wasmPaths;
  (globalThis as unknown as { onmessage: (e: MessageEvent<WorkerRequest>) => void }).onmessage = (
    e,
  ) => {
    const msg = e.data;
    if (msg.type === 'cancel') {
      active = null;
      return;
    }
    const fail = (err: unknown) =>
      post({
        type: 'error',
        id: msg.id,
        message: err instanceof Error ? err.message : String(err),
        skip: err instanceof Unsupported,
      });
    if (msg.type === 'load') {
      model(msg.device).then(() => post({ type: 'loaded', id: msg.id }), fail);
      return;
    }
    if (msg.type === 'narrate') {
      active = msg.id;
      narrate(msg.id, msg.text, msg.voice, msg.speed, msg.config, msg.device).then(
        (result) => post({ type: 'done', id: msg.id, ...result }),
        fail,
      );
    }
  };
}
