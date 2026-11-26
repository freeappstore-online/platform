import { describe, expect, it } from 'vitest';
import { narrationSentences } from './sentences.js';

const split = (text: string) => narrationSentences(text).map(([s, e, p]) => [text.slice(s, e), p]);

// The same pieces as Books' scripts/audio/segments.py (test_audio.py's Segments cases)
describe('narrationSentences (books#66)', () => {
  it('splits sentences and paragraphs', () => {
    expect(split('One. Two!  Three?\n\n“Four,” she said.\n\nFive')).toEqual([
      ['One.', false],
      ['Two!', false],
      ['Three?', true],
      ['“Four,” she said.', true],
      ['Five', true],
    ]);
  });

  it('keeps dialogue with its tag, and titles and initials with the name', () => {
    expect(split('“Oh dear!” said the Rabbit. Then Mr. Brown and L. Frank Baum left.')).toEqual([
      ['“Oh dear!” said the Rabbit.', false],
      ['Then Mr. Brown and L. Frank Baum left.', true],
    ]);
    expect(split('It was I. Then we left.')).toEqual([
      ['It was I.', false],
      ['Then we left.', true],
    ]);
  });

  it('counts offsets in UTF-16, as the reader does', () => {
    const text = '𝔄 one. Two.';
    expect(narrationSentences(text)).toEqual([
      [0, 7, false],
      [8, 12, true],
    ]);
  });
});
