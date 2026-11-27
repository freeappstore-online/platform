import type { Encoding, Speech } from './kokoro.js';
import type { InstallProgress } from './model.js';
import type { TtsRequest } from './tts.js';

/** What `TtsProcess` needs of Electron's `UtilityProcess`. */
export interface TtsPort {
  postMessage(message: TtsRequest): void;
  on(event: 'message', listener: (message: TtsReply) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  kill(): boolean;
}

type TtsReply =
  | { type: 'progress'; stage: 'download' | 'unpack'; fraction: number }
  | { type: 'installed' }
  | { type: 'said'; id: number; samples: Float32Array; sampleRate: number; loadMs: number }
  | { type: 'error'; id?: number; message: string };

/**
 * The TTS utility process (`tts.ts`) seen from the main process: started on first use, one
 * request at a time, ended by `close` (which frees the model's memory). A request in flight when
 * it exits fails.
 */
export class TtsProcess {
  private port: TtsPort | null = null;
  private ids = 0;
  private pending = new Map<number, { resolve: (s: Speech) => void; reject: (e: Error) => void }>();
  private installing: {
    progress: InstallProgress;
    resolve: () => void;
    reject: (e: Error) => void;
  } | null = null;

  constructor(private readonly fork: () => TtsPort) {}

  private started(): TtsPort {
    if (this.port) return this.port;
    const port = this.fork();
    this.port = port;
    port.on('message', (m) => this.receive(m));
    port.on('exit', () => {
      if (this.port === port) this.port = null;
      this.failAll(new Error('the TTS process ended'));
    });
    return port;
  }

  private failAll(err: Error) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    this.installing?.reject(err);
    this.installing = null;
  }

  private receive(m: TtsReply) {
    if (m.type === 'progress') return this.installing?.progress(m.stage, m.fraction);
    if (m.type === 'installed' || (m.type === 'error' && m.id === undefined)) {
      const install = this.installing;
      this.installing = null;
      return m.type === 'installed' ? install?.resolve() : install?.reject(new Error(m.message));
    }
    const request = this.pending.get(m.id!);
    this.pending.delete(m.id!);
    if (m.type === 'said') request?.resolve(m);
    else request?.reject(new Error(m.message));
  }

  /** Downloads, verifies and unpacks the model (`model.ts`) in the process. */
  install(progress: InstallProgress, source?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.installing = { progress, resolve, reject };
      this.started().postMessage({ type: 'install', ...(source && { source }) });
    });
  }

  say(text: string, sid: number, speed: number, mandarin: boolean): Promise<Speech> {
    const id = ++this.ids;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.started().postMessage({ type: 'say', id, text, sid, speed, mandarin });
    });
  }

  /** Ends the process: the model's memory is freed, a request in flight fails. */
  close(): void {
    const port = this.port;
    this.port = null;
    port?.kill();
    this.failAll(new Error('stopped'));
  }
}

/** The hidden window's encoder messages (`src/renderer/contribute.ts`). */
export type EncoderRequest =
  | { type: 'start'; id: number; sampleRate: number }
  | { type: 'write'; id: number; samples: Float32Array }
  | { type: 'finish'; id: number }
  | { type: 'cancel'; id: number };
export type EncoderReply =
  | { type: 'done'; id: number; file: ArrayBuffer }
  | { type: 'error'; id: number; message: string };

/**
 * AAC encodings in the hidden window, which has WebCodecs (the main process has none): samples
 * go over as they are spoken, the finished MP4 comes back as bytes.
 */
export class EncoderRelay {
  private ids = 0;
  private waiting = new Map<
    number,
    { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }
  >();
  /** Encodings started and not yet finished or cancelled; an error before `finish` waits here. */
  private failed = new Map<number, Error>();

  constructor(private readonly send: (message: EncoderRequest) => void) {}

  start(sampleRate: number): Encoding {
    const id = ++this.ids;
    this.send({ type: 'start', id, sampleRate });
    return {
      write: (samples) => this.send({ type: 'write', id, samples }),
      finish: () => {
        const err = this.failed.get(id);
        this.failed.delete(id);
        if (err) return Promise.reject(err);
        return new Promise<Uint8Array>((resolve, reject) => {
          this.waiting.set(id, { resolve, reject });
          this.send({ type: 'finish', id });
        });
      },
      cancel: () => {
        this.failed.delete(id);
        this.waiting.delete(id);
        this.send({ type: 'cancel', id });
      },
    };
  }

  receive(m: EncoderReply): void {
    const waiting = this.waiting.get(m.id);
    this.waiting.delete(m.id);
    if (m.type === 'done') waiting?.resolve(new Uint8Array(m.file));
    else if (waiting) waiting.reject(new Error(m.message));
    else this.failed.set(m.id, new Error(m.message));
  }

  /** The window went away: every encoding in hand fails. */
  closed(): void {
    for (const { reject } of this.waiting.values()) reject(new Error('the encoder window closed'));
    this.waiting.clear();
  }
}
