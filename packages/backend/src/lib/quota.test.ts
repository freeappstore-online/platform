import { describe, it, expect } from 'vitest';
import { checkKvWrite, type KvLimits } from './quota.js';

const limits: KvLimits = {
  maxValueBytes: 1000,
  maxTotalBytesPerUser: 10_000,
  maxKeysPerUser: 5,
};

const newKey = { keyExists: false, existingKeyBytes: 0 };
const overwrite = (existingBytes: number): { keyExists: true; existingKeyBytes: number } => ({
  keyExists: true,
  existingKeyBytes: existingBytes,
});

describe('checkKvWrite', () => {
  it('accepts a write that fits all limits', () => {
    expect(
      checkKvWrite({ totalBytes: 0, keyCount: 0, ...newKey }, 500, limits),
    ).toEqual({ ok: true });
  });

  it('rejects a value larger than maxValueBytes', () => {
    const result = checkKvWrite({ totalBytes: 0, keyCount: 0, ...newKey }, 1001, limits);
    expect(result).toEqual({ ok: false, reason: 'value exceeds 1000 bytes' });
  });

  it('rejects a write that pushes the user over total quota', () => {
    const result = checkKvWrite({ totalBytes: 9500, keyCount: 4, ...newKey }, 600, limits);
    expect(result).toEqual({ ok: false, reason: 'per-user kv quota exceeded' });
  });

  it('correctly accounts for overwriting an existing key when projecting total', () => {
    // user has 9500 bytes total, 800 of which belong to the key being written.
    // overwriting with 1000 leaves 9700 — under the 10k cap.
    const result = checkKvWrite({ totalBytes: 9500, keyCount: 4, ...overwrite(800) }, 1000, limits);
    expect(result).toEqual({ ok: true });
  });

  it('rejects a NEW key when keyCount is at limit', () => {
    const result = checkKvWrite({ totalBytes: 100, keyCount: 5, ...newKey }, 10, limits);
    expect(result).toEqual({
      ok: false,
      reason: 'per-user key count limit (5) exceeded',
    });
  });

  it('allows OVERWRITE of an existing key even when keyCount is at limit', () => {
    // Critical: hitting the key-count limit must not block updates to keys
    // that already exist, otherwise the user is locked out of their own data.
    const result = checkKvWrite(
      { totalBytes: 100, keyCount: 5, ...overwrite(50) },
      30,
      limits,
    );
    expect(result).toEqual({ ok: true });
  });

  it('treats a 0-byte existing value as an existing key, not a new one', () => {
    // Regression: if existence were inferred from `existingKeyBytes === 0`,
    // a zero-byte (or freshly-truncated) value would look like a brand new
    // key and re-trigger the key-count limit. Now we trust keyExists.
    const result = checkKvWrite(
      { totalBytes: 0, keyCount: 5, keyExists: true, existingKeyBytes: 0 },
      100,
      limits,
    );
    expect(result).toEqual({ ok: true });
  });

  it('allows writing a value of exactly maxValueBytes', () => {
    const result = checkKvWrite({ totalBytes: 0, keyCount: 0, ...newKey }, 1000, limits);
    expect(result).toEqual({ ok: true });
  });

  it('rejects a write of one byte too many over total', () => {
    const result = checkKvWrite({ totalBytes: 9999, keyCount: 1, ...newKey }, 2, limits);
    expect(result).toEqual({ ok: false, reason: 'per-user kv quota exceeded' });
  });
});
