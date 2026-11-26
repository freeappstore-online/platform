import { describe, expect, it } from 'vitest';
import { parseAudio } from './generation-audio.js';
import { M4A, OGG, SENTENCE, wav } from './generation-audio.testutil.js';
import { cpsBand, verdict } from './generation-verify.js';

const LIMITS = { minCps: 8, maxCps: 30 };
const ZH = { minCps: 2, maxCps: 9 };

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
});

describe('generation verdicts (no AI compute, #831)', () => {
  const text = SENTENCE.repeat(3);

  it('accepts plausible audio and records its duration', () => {
    expect(verdict(wav(10), 'audio/wav', null, text, LIMITS)).toEqual({
      ok: true,
      durationMs: 10_000,
    });
  });

  it('rejects a mismatched type, implausible duration and bad timings', () => {
    expect(verdict(OGG, 'audio/mp4', null, text, LIMITS).reason).toMatch(
      /does not match audio\/ogg/,
    );
    expect(verdict(wav(60), 'audio/wav', null, text, LIMITS).reason).toMatch(/too long/);
    expect(verdict(wav(2), 'audio/wav', null, text, LIMITS).reason).toMatch(/too short/);
    expect(verdict(new TextEncoder().encode('<html>'), 'audio/wav', null, text, LIMITS).ok).toBe(
      false,
    );
    const backwards = JSON.stringify({
      v: 1,
      segments: [
        [0, 45, 0, 4],
        [45, 90, 3, 6],
      ],
    });
    expect(verdict(wav(10), 'audio/wav', backwards, text, LIMITS).reason).toMatch(/segments/);
    const late = JSON.stringify({ v: 1, segments: [[0, 45, 0, 12]] });
    expect(verdict(wav(10), 'audio/wav', late, text, LIMITS).reason).toMatch(/segments/);
    const good = JSON.stringify({
      v: 1,
      segments: [
        [0, 45, 0, 3.2],
        [45, 90, 3.5, 6.6],
      ],
    });
    expect(verdict(wav(10), 'audio/wav', good, text, LIMITS).ok).toBe(true);
  });

  it('default characters-per-second bands by language', () => {
    expect(cpsBand('zh')).toEqual([2, 9]);
    expect(cpsBand('zh-Hans')).toEqual([2, 9]);
    expect(cpsBand('ja')).toEqual([3, 15]);
    expect(cpsBand('en')).toEqual([8, 30]);
    expect(cpsBand(null)).toEqual([8, 30]);
  });

  it('audio up to 3 s is never too long for its text (#810)', () => {
    expect(verdict(wav(1.5), 'audio/wav', null, '对。', ZH).ok).toBe(true);
    expect(verdict(wav(2), 'audio/wav', null, 'Hi.', LIMITS).ok).toBe(true);
    expect(verdict(wav(4), 'audio/wav', null, '对。', ZH).reason).toMatch(/too long/);
  });
});
