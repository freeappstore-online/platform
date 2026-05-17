import { describe, expect, it } from 'vitest';
import { toBytes } from './kv.js';

describe('toBytes (D1 BLOB normalization)', () => {
  it('passes Uint8Array through unchanged', () => {
    const u = new Uint8Array([1, 2, 3]);
    expect(toBytes(u)).toBe(u);
  });

  it('wraps ArrayBuffer as Uint8Array (production D1 case)', () => {
    const ab = new Uint8Array([7, 8, 9]).buffer;
    const out = toBytes(ab);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([7, 8, 9]);
  });

  it('coerces number[] from miniflare to Uint8Array (regression: kv-stringified-bytes)', () => {
    // Without this, `new Response([123, 34, 104, ...])` would return the
    // literal string "123,34,104,..." in the body — exactly the bug e2e caught.
    const out = toBytes([123, 34, 104, 105, 34, 125]);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(out)).toBe('{"hi"}');
  });

  it('returns empty Uint8Array for null/undefined/object', () => {
    expect(toBytes(null).length).toBe(0);
    expect(toBytes(undefined).length).toBe(0);
    expect(toBytes({}).length).toBe(0);
  });
});
