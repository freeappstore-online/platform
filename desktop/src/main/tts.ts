// Contribute's TTS process (#837): an Electron utility process, so synthesis and the model's
// unpacking never hold up the main process. It runs sherpa-onnx's offline TTS (CPU) as the phones
// do (android `KokoroSynthesizer`) and installs the model package (`model.ts`). The main process
// ends it after each run, which frees the model's memory.
//
// main → tts: { type: 'install', source? } | { type: 'say', id, text, sid, speed, mandarin, threads }
// tts → main: { type: 'progress', stage, fraction } | { type: 'installed' }
//           | { type: 'said', id, samples, sampleRate, loadMs } | { type: 'error', id?, message }

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { installModel, MANDARIN_RULES, MODEL_ROOT, MODEL_URL } from './model.js';

interface OfflineTts {
  generate(request: { text: string; sid: number; speed: number; enableExternalBuffer: boolean }): {
    samples: Float32Array;
    sampleRate: number;
  };
}
const sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as {
  OfflineTts: new (config: unknown) => OfflineTts;
};

export type TtsRequest =
  | { type: 'install'; source?: string }
  | {
      type: 'say';
      id: number;
      text: string;
      sid: number;
      speed: number;
      mandarin: boolean;
      /** sherpa-onnx threads: Contribute's CPU setting (#830). */
      threads: number;
    };

const dir = process.argv[2]!;
const root = join(dir, MODEL_ROOT);
const port = process.parentPort;
/** The loaded engine, whether it is the Mandarin one, and its threads. */
let engine: { mandarin: boolean; threads: number; tts: OfflineTts } | null = null;

/**
 * As android `KokoroSynthesizer.load`: no dataDir (sherpa-onnx 2.x phonemizes through the lexicons;
 * Mandarin is looked up in lexicon-zh), and the Mandarin number and date rules only for Mandarin,
 * where they would otherwise read digits in English text as Chinese.
 */
function load(mandarin: boolean, threads: number): OfflineTts {
  const file = (name: string) => join(root, name);
  return new sherpa.OfflineTts({
    model: {
      kokoro: {
        model: file('model.onnx'),
        voices: file('voices.bin'),
        tokens: file('tokens.txt'),
        lexicon: [file('lexicon-us-en.txt'), file('lexicon-zh.txt')].join(','),
        dictDir: file('dict'),
      },
      numThreads: threads,
      provider: 'cpu',
    },
    ruleFsts: mandarin ? MANDARIN_RULES.map(file).join(',') : '',
  });
}

port.on('message', async ({ data }: { data: TtsRequest }) => {
  if (data.type === 'install') {
    try {
      await installModel(
        dir,
        (stage, fraction) => port.postMessage({ type: 'progress', stage, fraction }),
        data.source ?? MODEL_URL,
      );
      port.postMessage({ type: 'installed' });
    } catch (err) {
      port.postMessage({ type: 'error', message: (err as Error).message });
    }
    return;
  }
  try {
    let loadMs = 0;
    if (engine?.mandarin !== data.mandarin || engine.threads !== data.threads) {
      engine = null; // one engine at a time
      const t = Date.now();
      engine = {
        mandarin: data.mandarin,
        threads: data.threads,
        tts: load(data.mandarin, data.threads),
      };
      loadMs = Date.now() - t;
    }
    const { samples, sampleRate } = engine.tts.generate({
      text: data.text,
      sid: data.sid,
      speed: data.speed,
      enableExternalBuffer: false, // Electron's V8 refuses buffers it doesn't own
    });
    port.postMessage({ type: 'said', id: data.id, samples, sampleRate, loadMs });
  } catch (err) {
    port.postMessage({ type: 'error', id: data.id, message: (err as Error).message });
  }
});
