import { describe, expect, it } from 'vitest';
import { queryLimit, queryOffset } from './paging.js';

describe('queryLimit', () => {
  it('uses the fallback when the param is missing, zero, negative, or not a number', () => {
    expect(queryLimit(undefined, 50, 200)).toBe(50);
    expect(queryLimit('', 50, 200)).toBe(50);
    expect(queryLimit('0', 50, 200)).toBe(50);
    // A negative LIMIT is unlimited in SQLite, so it must not pass through.
    expect(queryLimit('-1', 50, 200)).toBe(50);
    expect(queryLimit('abc', 50, 200)).toBe(50);
  });

  it('caps a large page size and floors fractional values', () => {
    expect(queryLimit('10', 50, 200)).toBe(10);
    expect(queryLimit('9999', 50, 200)).toBe(200);
    expect(queryLimit('10.9', 50, 200)).toBe(10);
  });
});

describe('queryOffset', () => {
  it('treats missing, negative, and non-numeric offsets as zero', () => {
    expect(queryOffset(undefined)).toBe(0);
    expect(queryOffset('-1')).toBe(0);
    expect(queryOffset('abc')).toBe(0);
    expect(queryOffset('20')).toBe(20);
    expect(queryOffset('20.8')).toBe(20);
  });
});
