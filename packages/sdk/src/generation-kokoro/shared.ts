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

export type WorkerReply =
  | { type: 'loading'; progress: number }
  | { type: 'loaded'; id: number }
  | { type: 'progress'; id: number; done: number; total: number; chars: number }
  | { type: 'done'; id: number; file: Blob; segments: KokoroSegment[] }
  | { type: 'error'; id: number; message: string; skip: boolean };
