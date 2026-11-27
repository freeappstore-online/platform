/** What the main thread and the worker share; no model code, so the main thread stays light. */

/** The model's files on Hugging Face */
export const KOKORO_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';

/** Where the model runs: WebGPU (fp32 weights) or WebAssembly (q8 weights). */
export type KokoroDevice = 'webgpu' | 'wasm';

/** A sentence's time in the audio: [charStart, charEnd, startSec, endSec] (Books' meta `segments`). */
export type KokoroSegment = [number, number, number, number];

export type WorkerRequest =
  | {
      type: 'narrate';
      id: number;
      text: string;
      voice: string;
      speed: number;
      config: AudioEncoderConfig;
      device: KokoroDevice;
    }
  | { type: 'load'; id: number; device: KokoroDevice }
  | { type: 'cancel' };

/**
 * Where a narration failed (#813): loading the model, speaking a sentence, or encoding the audio;
 * `worker` is the worker itself crashing (for example out of memory), so no stage could say.
 */
export type KokoroStage = 'load' | 'synth' | 'encode' | 'worker';

/** Wall time of a narration's stages in the worker (#827): model load, synthesis, AAC encode + mux. */
export interface KokoroTiming {
  loadMs: number;
  synthMs: number;
  encodeMs: number;
}

export type WorkerReply =
  | { type: 'loading'; progress: number }
  /** `device`: where the model actually runs (WebGPU falls back to WebAssembly). */
  | { type: 'loaded'; id: number; device?: KokoroDevice }
  | { type: 'progress'; id: number; done: number; total: number; chars: number }
  | {
      type: 'done';
      id: number;
      file: Blob;
      segments: KokoroSegment[];
      timing?: KokoroTiming;
      device?: KokoroDevice;
    }
  | { type: 'error'; id: number; message: string; skip: boolean; stage?: KokoroStage };
