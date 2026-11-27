// The hidden Contribute window (#826, #837): the AAC encoder for the main process, which has no
// WebCodecs. Samples arrive a sentence at a time as the TTS process speaks them and are encoded
// as they come (32 kbps mono AAC-LC in MP4); the finished file goes back as bytes. Where WebCodecs
// has no AAC encoder (Linux, #854), FFmpeg's, built to WebAssembly, encodes in a worker instead.
import { deleteKokoroModel, kokoroEncoder } from '@freeappstore/sdk/generation-kokoro';
import { AudioSample, AudioSampleSource, BufferTarget, Mp4OutputFormat, Output } from 'mediabunny';
import type { EncoderReply, EncoderRequest } from '../main/engine.js';

const bridge = window.fasContribute;
/** The phones' settings: 32 kbps mono at Kokoro's 24 kHz (platform#798). */
const WASM_AAC: AudioEncoderConfig = {
  codec: 'mp4a.40.2',
  sampleRate: 24_000,
  numberOfChannels: 1,
  bitrate: 32_000,
};
const native = await kokoroEncoder();
// Only loaded where it is needed: it is about 1 MB
if (!native) (await import('@mediabunny/aac-encoder')).registerAacEncoder();
const config = native ?? WASM_AAC;

interface Session {
  output: Output<Mp4OutputFormat, BufferTarget>;
  source: AudioSampleSource;
  /** The samples added so far, one after another (the encoder's backpressure). */
  added: Promise<void>;
  /** Samples written, at the input's rate. */
  frames: number;
  rate: number;
}
const sessions = new Map<number, Session>();

/** The input's samples at the encoder's rate: Kokoro's 24 kHz doubled where 24 kHz AAC is refused. */
function resample(samples: Float32Array, from: number, to: number): Float32Array<ArrayBuffer> {
  if (from === to) return samples as Float32Array<ArrayBuffer>;
  const ratio = to / from;
  const out = new Float32Array(Math.round(samples.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const at = i / ratio;
    const j = Math.floor(at);
    const a = samples[j] ?? 0;
    out[i] = a + ((samples[j + 1] ?? a) - a) * (at - j);
  }
  return out;
}

async function handle(msg: EncoderRequest): Promise<EncoderReply | null> {
  if (msg.type === 'start') {
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    });
    const source = new AudioSampleSource({ codec: 'aac', bitrate: config.bitrate! });
    output.addAudioTrack(source);
    const session: Session = {
      output,
      source,
      added: output.start(),
      frames: 0,
      rate: msg.sampleRate,
    };
    session.added.catch(() => {}); // surfaces at finish
    sessions.set(msg.id, session);
    return null;
  }
  const session = sessions.get(msg.id);
  if (!session)
    return msg.type === 'finish' ? { type: 'error', id: msg.id, message: 'encoding failed' } : null;
  if (msg.type === 'write') {
    const sample = new AudioSample({
      format: 'f32',
      sampleRate: config.sampleRate,
      numberOfChannels: 1,
      timestamp: session.frames / session.rate,
      data: resample(msg.samples, session.rate, config.sampleRate),
    });
    session.frames += msg.samples.length;
    session.added = session.added
      .then(() => session.source.add(sample))
      .finally(() => sample.close());
    session.added.catch(() => {}); // surfaces at finish
    return null;
  }
  sessions.delete(msg.id);
  if (msg.type === 'cancel') {
    void session.added.then(() => session.output.cancel()).catch(() => {});
    return null;
  }
  try {
    await session.added;
    await session.output.finalize();
    return { type: 'done', id: msg.id, file: session.output.target.buffer! };
  } catch (err) {
    void session.output.cancel().catch(() => {});
    return { type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) };
  }
}

bridge.onMessage((message) => {
  void handle(message as EncoderRequest).then((reply) => reply && bridge.reply(reply));
});
bridge.engine({ encoder: config });
// The battery level, for Contribute's battery floor (#830); a computer without one reports 100
const battery = await (
  navigator as Navigator & {
    getBattery?: () => Promise<EventTarget & { level: number }>;
  }
)
  .getBattery?.()
  .catch(() => null);
if (battery) {
  const report = () => bridge.battery(Math.round(battery.level * 100));
  report();
  battery.addEventListener('levelchange', report);
} else bridge.battery(null);
// The browser runner's model (kokoro-js, before #837) is no longer used: free its storage
void deleteKokoroModel();
