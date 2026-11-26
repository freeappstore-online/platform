import { describe, expect, it, vi } from 'vitest';
import { parseAudio } from './generation-audio.js';
import { M4A, OGG, SENTENCE, wav } from './generation-audio.testutil.js';
import { agree, verdict, wer, words } from './generation-verify.js';

const LIMITS = { minCps: 8, maxCps: 30, maxWer: 0.25 };
const AT = [0.1, 0.5, 0.9];

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
    const v = await verdict(wav(10), 'audio/wav', null, text, LIMITS, AT, async () => text);
    expect(v).toEqual({ ok: true, durationMs: 10_000, wer: 0, transcript: text, windows: null });
  });

  it('rejects silence, wrong text, mismatched type, implausible duration and bad timings', async () => {
    const heard = vi.fn(async () => '');
    expect(
      (await verdict(wav(10, true), 'audio/wav', null, text, LIMITS, AT, heard)).reason,
    ).toMatch(/does not match the text/);
    expect(
      (await verdict(wav(10), 'audio/wav', null, text, LIMITS, AT, async () => 'hello world'))
        .reason,
    ).toMatch(/word error rate 1/);
    expect((await verdict(OGG, 'audio/mp4', null, text, LIMITS, AT, heard)).reason).toMatch(
      /does not match audio\/ogg/,
    );
    expect((await verdict(wav(60), 'audio/wav', null, text, LIMITS, AT, heard)).reason).toMatch(
      /too long/,
    );
    expect((await verdict(wav(2), 'audio/wav', null, text, LIMITS, AT, heard)).reason).toMatch(
      /too short/,
    );
    const backwards = JSON.stringify({
      v: 1,
      segments: [
        [0, 45, 0, 4],
        [45, 90, 3, 6],
      ],
    });
    expect(
      (await verdict(wav(10), 'audio/wav', backwards, text, LIMITS, AT, heard)).reason,
    ).toMatch(/segments/);
    const late = JSON.stringify({ v: 1, segments: [[0, 45, 0, 12]] });
    expect((await verdict(wav(10), 'audio/wav', late, text, LIMITS, AT, heard)).reason).toMatch(
      /segments/,
    );
    const good = JSON.stringify({
      v: 1,
      segments: [
        [0, 45, 0, 3.2],
        [45, 90, 3.5, 6.6],
      ],
    });
    expect((await verdict(wav(10), 'audio/wav', good, text, LIMITS, AT, async () => text)).ok).toBe(
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
      const v = await verdict(bytes, type, null, long, LIMITS, AT, heard);
      expect(v).toEqual(
        expect.objectContaining({
          ok: true,
          wer: 0,
          transcript: null,
          windows: Array(3).fill(`jumps ${SENTENCE} the`),
        }),
      );
      expect(heard).toHaveBeenCalledTimes(3);
    }
    const junk = await verdict(
      M4A,
      'audio/mp4',
      null,
      long,
      LIMITS,
      AT,
      async () => 'buy cheap pills now please',
    );
    expect(junk.ok).toBe(false);
  });
});

describe('replica agreement', () => {
  const all = Array.from({ length: 200 }, (_, i) => `word${i}`);
  const span = (from: number, to: number) => all.slice(from, to).join(' ');
  const whole = (t: string) => ({ transcript: t, windows: null });
  const windows = (...w: string[]) => ({ transcript: null, windows: w });

  it('whole transcripts within maxWer of each other', () => {
    expect(agree(whole(span(0, 40)), whole(span(0, 38)), 0.25)).toBe(true);
    expect(agree(whole(span(0, 40)), whole(span(20, 60)), 0.25)).toBe(false);
  });

  it('the same windows of each replica, ignoring cut edge words and a small shift', () => {
    const a = windows(span(10, 50), span(80, 120), span(150, 190));
    expect(agree(a, windows(span(11, 51), span(79, 119), span(150, 190)), 0.25)).toBe(true);
    // Each of these windows would pass against the text, but they are other stretches.
    expect(agree(a, windows(span(10, 50), span(100, 140), span(150, 190)), 0.25)).toBe(false);
    expect(agree(a, windows(span(10, 50), span(80, 120)), 0.25)).toBe(false);
  });

  it('windows against a whole transcript, anywhere in it', () => {
    expect(agree(whole(span(0, 120)), windows(span(5, 30), span(60, 90)), 0.25)).toBe(true);
    expect(agree(windows(span(5, 30), span(150, 180)), whole(span(0, 120)), 0.25)).toBe(false);
  });
});
