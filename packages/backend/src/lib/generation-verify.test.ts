import { describe, expect, it, vi } from 'vitest';
import { parseAudio } from './generation-audio.js';
import { M4A, OGG, SENTENCE, wav } from './generation-audio.testutil.js';
import { verdict, wer, words } from './generation-verify.js';

const LIMITS = { minCps: 8, maxCps: 30, maxWer: 0.25 };

describe('generation audio containers', () => {
  it('measures WAV, MP4 (mvhd) and Ogg Opus (last granule) durations', () => {
    expect(parseAudio(wav(3))).toEqual(
      expect.objectContaining({ type: 'audio/wav', durationMs: 3000 }),
    );
    expect(parseAudio(M4A).type).toBe('audio/mp4');
    expect(parseAudio(M4A).durationMs).toBeCloseTo(70_000, -2);
    expect(parseAudio(OGG).type).toBe('audio/ogg');
    expect(parseAudio(OGG).durationMs).toBeCloseTo(70_000, -2);
  });

  it('rejects truncated files, trailing bytes and other formats', () => {
    for (const b of [M4A, OGG, wav(1)]) {
      expect(() => parseAudio(b.subarray(0, b.length - 100))).toThrow(/truncated/i);
      expect(() => parseAudio(new Uint8Array([...b, 1, 2, 3]))).toThrow();
    }
    expect(() => parseAudio(new TextEncoder().encode('<html>not audio</html>'))).toThrow(/not WAV/);
  });

  it('cuts standalone windows: PCM WAV, Ogg pages after the headers, AAC as ADTS', () => {
    const clip = parseAudio(wav(30)).window(5000, 20_000);
    expect(parseAudio(clip).durationMs).toBe(20_000);
    const ogg = parseAudio(OGG).window(30_000, 20_000);
    expect(new TextDecoder().decode(ogg.subarray(0, 4))).toBe('OggS');
    expect(ogg.length).toBeLessThan(OGG.length / 2);
    const aac = parseAudio(M4A).window(30_000, 20_000);
    expect([aac[0], aac[1]! & 0xf6]).toEqual([0xff, 0xf0]);
    expect(aac.length).toBeLessThan(M4A.length / 2);
  });
});

describe('generation verdicts', () => {
  const text = SENTENCE.repeat(3);

  it('word error rate, whole and within a longer text', () => {
    expect(wer(words('The quick, brown fox!'), words('the quick brown fox'))).toBe(0);
    expect(wer(words('a quick brown cat'), words('the quick brown fox'))).toBe(0.5);
    expect(wer([], words('the fox'))).toBe(1);
    expect(wer(words('brown fox jumps'), words(text), true)).toBe(0);
    expect(wer(words('purple elephants dance'), words(text), true)).toBe(1);
  });

  it('accepts matching narration and records duration and WER', async () => {
    const v = await verdict(wav(10), 'audio/wav', null, text, LIMITS, async () => text);
    expect(v).toEqual({ ok: true, durationMs: 10_000, wer: 0, transcript: text });
  });

  it('rejects silence, wrong text, mismatched type, implausible duration and bad timings', async () => {
    const heard = vi.fn(async () => '');
    expect((await verdict(wav(10, true), 'audio/wav', null, text, LIMITS, heard)).reason).toMatch(
      /does not match the text/,
    );
    expect(
      (await verdict(wav(10), 'audio/wav', null, text, LIMITS, async () => 'hello world')).reason,
    ).toMatch(/word error rate 1/);
    expect((await verdict(OGG, 'audio/mp4', null, text, LIMITS, heard)).reason).toMatch(
      /does not match audio\/ogg/,
    );
    expect((await verdict(wav(60), 'audio/wav', null, text, LIMITS, heard)).reason).toMatch(
      /too long/,
    );
    expect((await verdict(wav(2), 'audio/wav', null, text, LIMITS, heard)).reason).toMatch(
      /too short/,
    );
    const backwards = JSON.stringify({
      v: 1,
      segments: [
        [0, 45, 0, 4],
        [45, 90, 3, 6],
      ],
    });
    expect((await verdict(wav(10), 'audio/wav', backwards, text, LIMITS, heard)).reason).toMatch(
      /segments/,
    );
    const late = JSON.stringify({ v: 1, segments: [[0, 45, 0, 12]] });
    expect((await verdict(wav(10), 'audio/wav', late, text, LIMITS, heard)).reason).toMatch(
      /segments/,
    );
    const good = JSON.stringify({
      v: 1,
      segments: [
        [0, 45, 0, 3.2],
        [45, 90, 3.5, 6.6],
      ],
    });
    expect((await verdict(wav(10), 'audio/wav', good, text, LIMITS, async () => text)).ok).toBe(
      true,
    );
  });

  it('long audio is checked as three sampled windows, each against the text', async () => {
    const long = SENTENCE.repeat(30);
    const heard = vi.fn(async () => `jumps ${SENTENCE} the`);
    for (const [bytes, type] of [
      [M4A, 'audio/mp4'],
      [OGG, 'audio/ogg'],
    ] as const) {
      heard.mockClear();
      const v = await verdict(bytes, type, null, long, LIMITS, heard);
      expect(v).toEqual(expect.objectContaining({ ok: true, wer: 0, transcript: null }));
      expect(heard).toHaveBeenCalledTimes(3);
    }
    const junk = await verdict(
      M4A,
      'audio/mp4',
      null,
      long,
      LIMITS,
      async () => 'buy cheap pills now please',
    );
    expect(junk.ok).toBe(false);
  });
});
