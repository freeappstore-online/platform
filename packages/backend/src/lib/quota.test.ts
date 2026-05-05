import { describe, it, expect } from 'vitest';
import { checkKvWrite, type KvLimits } from './quota.js';

const limits: KvLimits = {
  maxValueBytes: 1000,
  maxTotalBytesPerUser: 10_000,
  maxKeysPerUser: 5,
};

describe('checkKvWrite', () => {
  it('accepts a write that fits all limits', () => {
    expect(
      checkKvWrite({ totalBytes: 0, keyCount: 0, existingKeyBytes: 0 }, 500, limits),
    ).toEqual({ ok: true });
  });

  it('rejects a value larger than maxValueBytes', () => {
    const result = checkKvWrite(
      { totalBytes: 0, keyCount: 0, existingKeyBytes: 0 },
      1001,
      limits,
    );
    expect(result).toEqual({ ok: false, reason: 'value exceeds 1000 bytes' });
  });

  it('rejects a write that pushes the user over total quota', () => {
    const result = checkKvWrite(
      { totalBytes: 9500, keyCount: 4, existingKeyBytes: 0 },
      600,
      limits,
    );
    expect(result).toEqual({ ok: false, reason: 'per-user kv quota exceeded' });
  });

  it('correctly accounts for overwriting an existing key when projecting total', () => {
    // user has 9500 bytes total, of which 800 belong to the key we're writing.
    // overwriting with 1000 bytes should leave 9700 — under the 10k cap.
    const result = checkKvWrite(
      { totalBytes: 9500, keyCount: 4, existingKeyBytes: 800 },
      1000,
      limits,
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects a NEW key when keyCount is at limit', () => {
    const result = checkKvWrite(
      { totalBytes: 100, keyCount: 5, existingKeyBytes: 0 },
      10,
      limits,
    );
    expect(result).toEqual({
      ok: false,
      reason: 'per-user key count limit (5) exceeded',
    });
  });

  it('allows OVERWRITE of an existing key even when keyCount is at limit', () => {
    // Important: hitting the key-count limit must not block updates to keys
    // that already exist. Otherwise the user is locked out of their own data.
    const result = checkKvWrite(
      { totalBytes: 100, keyCount: 5, existingKeyBytes: 50 },
      30,
      limits,
    );
    expect(result).toEqual({ ok: true });
  });

  it('allows writing a value of exactly maxValueBytes', () => {
    const result = checkKvWrite(
      { totalBytes: 0, keyCount: 0, existingKeyBytes: 0 },
      1000,
      limits,
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects a write of one byte too many over total', () => {
    const result = checkKvWrite(
      { totalBytes: 9999, keyCount: 1, existingKeyBytes: 0 },
      2,
      limits,
    );
    expect(result).toEqual({ ok: false, reason: 'per-user kv quota exceeded' });
  });
});
