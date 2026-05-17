import { describe, expect, it } from 'vitest';
import { consume, newRateLimitState } from './rate-limit.js';

describe('rate-limit window', () => {
  it('admits the first request', () => {
    const state = newRateLimitState(1_700_000_000_000);
    expect(consume(state, 1_700_000_000_000, 5)).toBe(true);
  });

  it('admits up to and including the limit, then rejects', () => {
    const state = newRateLimitState(1_700_000_000_000);
    for (let i = 0; i < 5; i++) {
      expect(consume(state, 1_700_000_000_000, 5)).toBe(true);
    }
    expect(consume(state, 1_700_000_000_000, 5)).toBe(false);
    expect(consume(state, 1_700_000_000_999, 5)).toBe(false); // still in same second
  });

  it('resets the bucket on second rollover', () => {
    const state = newRateLimitState(1_700_000_000_000);
    for (let i = 0; i < 5; i++) consume(state, 1_700_000_000_000, 5);
    expect(consume(state, 1_700_000_000_000, 5)).toBe(false);

    // Cross into the next second.
    expect(consume(state, 1_700_000_001_000, 5)).toBe(true);
    expect(consume(state, 1_700_000_001_500, 5)).toBe(true);
  });

  it('handles the boundary: 999ms vs 1000ms', () => {
    const state = newRateLimitState(1_700_000_000_999);
    consume(state, 1_700_000_000_999, 1);
    // 999ms is still second 1700000000. 1000ms is second 1700000001.
    expect(consume(state, 1_700_000_000_999, 1)).toBe(false);
    expect(consume(state, 1_700_000_001_000, 1)).toBe(true);
  });

  it('does not get tricked by clock going backwards within the same second', () => {
    const state = newRateLimitState(1_700_000_000_500);
    consume(state, 1_700_000_000_500, 1);
    // Clock skews back 100ms — same second, must still reject.
    expect(consume(state, 1_700_000_000_400, 1)).toBe(false);
  });

  it('treats clock jumping forward by minutes as a fresh window', () => {
    const state = newRateLimitState(1_700_000_000_000);
    for (let i = 0; i < 5; i++) consume(state, 1_700_000_000_000, 5);
    expect(consume(state, 1_700_000_000_000, 5)).toBe(false);
    // Clock jumps forward 5 minutes.
    expect(consume(state, 1_700_000_300_000, 5)).toBe(true);
  });

  it('with limit=0, rejects everything', () => {
    const state = newRateLimitState(1_700_000_000_000);
    expect(consume(state, 1_700_000_000_000, 0)).toBe(false);
  });
});
