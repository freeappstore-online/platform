// The hidden Contribute window (#826, #837): the AAC encoder for the main process, which has no
// WebCodecs. Samples arrive a sentence at a time as the TTS process speaks them and are encoded
// as they come (32 kbps mono AAC-LC in MP4); the finished file goes back as bytes.
import { deleteKokoroModel, kokoroEncoder } from '@freeappstore/sdk/generation-kokoro';
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { EncoderReply, EncoderRequest } from '../main/engine.js';

const bridge = window.fasContribute;
const config = await kokoroEncoder();

interface Session {
  muxer: Muxer<ArrayBufferTarget>;
  encoder: AudioEncoder;
  /** Samples written, at the input's rate. */
  frames: number;
  rate: number;
  failure: unknown;
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
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      audio: { codec: 'aac', numberOfChannels: 1, sampleRate: config!.sampleRate },
      fastStart: 'in-memory',
    });
    const session: Session = {
      muxer,
      encoder: new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => {
          session.failure = e;
        },
      }),
      frames: 0,
      rate: msg.sampleRate,
      failure: null,
    };
    session.encoder.configure(config!);
    sessions.set(msg.id, session);
    return null;
  }
  const session = sessions.get(msg.id);
  if (!session)
    return msg.type === 'finish' ? { type: 'error', id: msg.id, message: 'encoding failed' } : null;
  try {
    if (session.failure) throw session.failure;
    if (msg.type === 'write') {
      const data = resample(msg.samples, session.rate, config!.sampleRate);
      session.encoder.encode(
        new AudioData({
          format: 'f32',
          sampleRate: config!.sampleRate,
          numberOfChannels: 1,
          numberOfFrames: data.length,
          timestamp: Math.round((session.frames / session.rate) * 1e6),
          data,
        }),
      );
      session.frames += msg.samples.length;
      return null;
    }
    if (msg.type === 'cancel') {
      sessions.delete(msg.id);
      if (session.encoder.state !== 'closed') session.encoder.close();
      return null;
    }
    await session.encoder.flush();
    if (session.failure) throw session.failure;
    session.encoder.close();
    session.muxer.finalize();
    sessions.delete(msg.id);
    return { type: 'done', id: msg.id, file: session.muxer.target.buffer };
  } catch (err) {
    sessions.delete(msg.id);
    if (session.encoder.state !== 'closed') session.encoder.close();
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
