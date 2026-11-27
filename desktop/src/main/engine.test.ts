import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { EncoderRelay, type TtsPort, TtsProcess } from './engine.js';

/** A stand-in utility process: answers each `say` with one sample, and can exit. */
function fakePort() {
  const sent: unknown[] = [];
  const emitter = new EventEmitter();
  const port = {
    postMessage: (m: { type: string; id?: number }) => {
      sent.push(m);
      if (m.type === 'say')
        queueMicrotask(() =>
          emitter.emit('message', {
            type: 'said',
            id: m.id,
            samples: new Float32Array(1),
            sampleRate: 24_000,
            loadMs: 5,
          }),
        );
      if (m.type === 'install')
        queueMicrotask(() => {
          emitter.emit('message', { type: 'progress', stage: 'download', fraction: 0.5 });
          emitter.emit('message', { type: 'installed' });
        });
    },
    on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
    kill: () => emitter.emit('exit', 0),
  };
  return { port: port as unknown as TtsPort, sent, emitter };
}

describe('TtsProcess', () => {
  it('starts the process on first use, answers requests, and ends it on close', async () => {
    let forks = 0;
    const fake = fakePort();
    const tts = new TtsProcess(() => {
      forks++;
      return fake.port;
    });
    const progress: unknown[] = [];
    await tts.install((stage, fraction) => progress.push([stage, fraction]), 'http://x/m.tar.bz2');
    expect(progress).toEqual([['download', 0.5]]);
    const speech = await tts.say('你好。', 47, 1, true);
    expect([speech.sampleRate, speech.loadMs]).toEqual([24_000, 5]);
    expect(fake.sent).toEqual([
      { type: 'install', source: 'http://x/m.tar.bz2' },
      { type: 'say', id: 1, text: '你好。', sid: 47, speed: 1, mandarin: true },
    ]);
    expect(forks).toBe(1);
    // A request in flight fails when the process goes
    fake.port.postMessage = () => {};
    const pending = tts.say('x', 0, 1, false);
    tts.close();
    await expect(pending).rejects.toThrow();
  });
});

describe('EncoderRelay', () => {
  it('sends samples over and turns the finished file back into bytes', async () => {
    const sent: { type: string; id: number }[] = [];
    const relay = new EncoderRelay((m) => sent.push(m));
    const encoding = relay.start(24_000);
    encoding.write(new Float32Array(2));
    const file = encoding.finish();
    relay.receive({ type: 'done', id: 1, file: new Uint8Array([1, 2]).buffer });
    expect(await file).toEqual(new Uint8Array([1, 2]));
    expect(sent.map((m) => m.type)).toEqual(['start', 'write', 'finish']);
  });

  it('fails a finish after an encoder error, and when the window closes', async () => {
    const relay = new EncoderRelay(() => {});
    const broken = relay.start(24_000);
    relay.receive({ type: 'error', id: 1, message: 'bad data' });
    await expect(broken.finish()).rejects.toThrow('bad data');
    const lost = relay.start(24_000).finish();
    relay.closed();
    await expect(lost).rejects.toThrow('the encoder window closed');
  });
});
