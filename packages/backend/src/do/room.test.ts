import { describe, expect, it } from 'vitest';
import { messageBytes } from './room.js';

describe('messageBytes', () => {
  it('counts UTF-8 bytes for strings', () => {
    expect(messageBytes('abc')).toBe(3);
    // 3 bytes per CJK character: 4096 of them is ~12KB, over the 4KB cap.
    expect(messageBytes('漢'.repeat(4096))).toBe(12288);
  });

  it('counts ArrayBuffer bytes', () => {
    expect(messageBytes(new ArrayBuffer(10))).toBe(10);
  });
});
