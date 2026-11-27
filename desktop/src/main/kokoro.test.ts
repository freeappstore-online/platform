import { KokoroError, KokoroSkip, kokoroEndReason } from '@freeappstore/sdk/generation-kokoro';
import { describe, expect, it } from 'vitest';
import { kokoroLanguage, kokoroProblem, NativeRunner, sentences, VOICES } from './kokoro.js';

const work = (params: Record<string, unknown>, language: string | null = null) => ({
  model: 'kokoro',
  modelVersion: 'v1.0',
  params,
  formats: ['audio/mp4' as const],
  maxBytes: 25_000_000,
  language,
});
const job = (text: string, voice: string, language: string | null = null) => ({
  ...work({ voice }, language),
  id: 'j1',
  setId: 's1',
  key: 'k',
  input: { text },
  leaseToken: 'l',
  leaseExpiresAt: Date.now() + 15 * 60_000,
});

describe('the phones’ rules (#812, #837)', () => {
  it('has the package’s 54 voices in speaker order', () => {
    expect(VOICES).toHaveLength(54);
    expect([VOICES.indexOf('af_heart'), VOICES.indexOf('zf_xiaoxiao'), VOICES.at(-1)]).toEqual([
      3,
      47,
      'em_santa',
    ]);
  });

  it('speaks a set’s language only with a voice of it; no language goes by the voice', () => {
    expect(kokoroLanguage('zf_xiaobei', 'zh')).toBe('zh');
    expect(kokoroLanguage('zf_xiaobei', 'zh-Hans')).toBe('zh');
    expect(kokoroLanguage('zf_xiaobei', null)).toBe('zh');
    expect(kokoroLanguage('ef_dora', 'es')).toBe('es');
    expect(kokoroLanguage('af_heart', 'en-US')).toBe('en');
    expect(kokoroLanguage('af_heart', null)).toBe('en');
    expect(kokoroLanguage('af_heart', 'zh')).toBeNull();
    expect(kokoroLanguage('zf_xiaobei', 'en')).toBeNull();
    expect(kokoroLanguage('ff_siwis', 'fr')).toBeNull();
  });

  it('says why it can’t run a set, or null', () => {
    expect(kokoroProblem(work({ voice: 'zf_xiaobei' }, 'zh'))).toBeNull();
    expect(kokoroProblem(work({ voice: 'af_heart', speed: 1.5 }))).toBeNull();
    expect(kokoroProblem(work({ voice: 'af_heart' }, 'zh'))).toBe(
      'language zh with voice af_heart',
    );
    expect(kokoroProblem(work({ voice: 'xx_nobody' }))).toBe('unknown voice xx_nobody');
    expect(kokoroProblem(work({ voice: 'af_heart', speed: 3 }))).toBe('speed must be 0.5-2');
    expect(kokoroProblem(work({ voice: 'af_heart', pitch: 1 }))).toBe('unknown params pitch');
    expect(kokoroProblem({ ...work({ voice: 'af_heart' }), formats: ['audio/ogg' as const] })).toBe(
      'no audio/mp4 format',
    );
    expect(kokoroProblem({ ...work({ voice: 'af_heart' }), modelVersion: 'v1.1' })).toBe(
      'model kokoro v1.1',
    );
    const long = { ...job('字'.repeat(10_000), 'zf_xiaobei', 'zh'), maxBytes: 1_000_000 };
    expect(kokoroProblem(long, 32_000)).toBe('audio would exceed maxBytes');
  });

  it('splits Mandarin at its own punctuation and Spanish without its abbreviations', () => {
    const zh = '今天是3.5度。我们去公园吧！好\n\n对。';
    expect(sentences(zh, 'zh').map(([a, b, p]) => [zh.slice(a, b), p])).toEqual([
      ['今天是3.5度。', false],
      ['我们去公园吧！', false],
      ['好', true],
      ['对。', true],
    ]);
    const es = 'La Sra. Pérez llegó. ¿Vienes? —dijo él. Sí.';
    expect(sentences(es, 'es').map(([a, b]) => es.slice(a, b))).toEqual([
      'La Sra. Pérez llegó.',
      '¿Vienes? —dijo él.',
      'Sí.',
    ]);
    const en = 'Mr. Smith left. He came back.';
    expect(sentences(en, 'en').map(([a, b]) => en.slice(a, b))).toEqual([
      'Mr. Smith left.',
      'He came back.',
    ]);
  });
});

describe('NativeRunner', () => {
  /** Speaks `seconds` of samples a sentence; records what the encoder got. */
  function runner(seconds = 1, rest?: (ms: number) => number) {
    const said: { text: string; mandarin: boolean }[] = [];
    const written: number[] = [];
    const events: string[] = [];
    const native = new NativeRunner({
      say: async (text, _sid, _speed, mandarin) => {
        said.push({ text, mandarin });
        return { samples: new Float32Array(24_000 * seconds), sampleRate: 24_000, loadMs: 0 };
      },
      encode: (rate) => {
        events.push(`start ${rate}`);
        return {
          write: (samples) => written.push(samples.length),
          finish: async () => new Uint8Array(100),
          cancel: () => events.push('cancel'),
        };
      },
      bitrate: 32_000,
      dispose: () => events.push('dispose'),
      rest,
    });
    return { native, said, written, events };
  }

  it('speaks Mandarin a sentence at a time, joined by pauses, timed per sentence', async () => {
    const { native, said, written, events } = runner();
    const progress: number[] = [];
    const result = await native.generate(job('你好。再见。', 'zf_xiaobei', 'zh'), {
      onProgress: (p) => progress.push(p.sentence),
    });
    expect(said).toEqual([
      { text: '你好。', mandarin: true },
      { text: '再见。', mandarin: true },
    ]);
    expect(written).toEqual([24_000, 9_600, 24_000]); // a sentence, 0.4 s, a sentence
    expect(result.meta.segments).toEqual([
      [0, 3, 0, 1],
      [3, 6, 1.4, 2.4],
    ]);
    expect([result.file.type, result.file.size]).toEqual(['audio/mp4', 100]);
    expect(progress).toEqual([1, 2]);
    expect(events).toEqual(['start 24000']);
  });

  it('rests between sentences as asked, not after the last, and a rest can be cut short (#830)', async () => {
    const asked: number[] = [];
    const { native, said } = runner(1, (ms) => {
      asked.push(ms);
      return 30;
    });
    const started = Date.now();
    await native.generate(job('One. Two. Three.', 'af_heart'));
    expect(asked).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    // Aborted while resting: it stops there
    const controller = new AbortController();
    const resting = runner(1, () => 60_000);
    const going = resting.native.generate(job('One. Two.', 'af_heart'), {
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort(new Error('Off'));
    await expect(going).rejects.toThrow('Off');
    expect(resting.said).toHaveLength(1);
    expect(said).toHaveLength(3);
  });

  it('pads audio under a second with silence (#812)', async () => {
    const { native, written } = runner(0.25);
    await native.generate(job('对。', 'zf_xiaobei', 'zh'));
    expect(written).toEqual([6_000, 18_000]);
  });

  it('gives back a job it can’t speak, and stops when aborted', async () => {
    const { native, events } = runner();
    await expect(native.generate(job('Hi.', 'af_heart', 'zh'))).rejects.toBeInstanceOf(KokoroSkip);
    const controller = new AbortController();
    const going = native.generate(job('One. Two.', 'af_heart'), {
      signal: controller.signal,
      onProgress: () => controller.abort(new Error('Paused')),
    });
    await expect(going).rejects.toThrow('Paused');
    expect(events).toEqual(['start 24000', 'cancel']);
  });

  it('names the stage a job failed in, so the record says model_error or encode_error (#813)', async () => {
    const failing = (say: boolean) =>
      new NativeRunner({
        say: async () => {
          if (say) throw new Error('TTS process exited');
          return { samples: new Float32Array(24_000), sampleRate: 24_000, loadMs: 0 };
        },
        encode: () => ({
          write: () => {},
          finish: async () => {
            throw new Error('EncodingError');
          },
          cancel: () => {},
        }),
        bitrate: 32_000,
        dispose: () => {},
      });
    const spoken = await failing(true)
      .generate(job('Hi.', 'af_heart'))
      .catch((e) => e);
    expect(spoken).toBeInstanceOf(KokoroError);
    expect(spoken).toMatchObject({ stage: 'synth', message: 'TTS process exited' });
    expect(kokoroEndReason('failed', spoken.message, spoken)).toBe('model_error');
    const encoded = await failing(false)
      .generate(job('Hi.', 'af_heart'))
      .catch((e) => e);
    expect(encoded).toMatchObject({ stage: 'encode', message: 'EncodingError' });
    expect(kokoroEndReason('failed', encoded.message, encoded)).toBe('encode_error');
  });
});
