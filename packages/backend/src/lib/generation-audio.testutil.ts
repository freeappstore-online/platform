/** Test helpers: audio fixtures for community generation verification (#729). */
import { readFileSync } from 'node:fs';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../test-fixtures/generation/${name}`, import.meta.url)));
/** 70 s of real AAC-in-MP4 and Opus-in-Ogg from ffmpeg (a tone; Whisper is mocked). */
export const M4A = fixture('narration.m4a');
export const OGG = fixture('narration.ogg');

/** 16 kHz mono 16-bit PCM WAV: a tone, or silence. */
export function wav(seconds: number, silent = false): Uint8Array {
  const samples = seconds * 16000;
  const b = new Uint8Array(44 + samples * 2);
  const v = new DataView(b.buffer);
  b.set(new TextEncoder().encode('RIFF'), 0);
  v.setUint32(4, b.length - 8, true);
  b.set(new TextEncoder().encode('WAVEfmt '), 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  b.set(new TextEncoder().encode('data'), 36);
  v.setUint32(40, samples * 2, true);
  if (!silent)
    for (let i = 0; i < samples; i++)
      v.setInt16(44 + i * 2, Math.round(8000 * Math.sin((i * 2 * Math.PI * 440) / 16000)), true);
  return b;
}

export const SENTENCE = 'The quick brown fox jumps over the lazy dog. ';
