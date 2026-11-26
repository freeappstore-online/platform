/**
 * Verdicts for community generation (#729): container and content type,
 * duration plausibility against the input text, `meta` sentence timings, and a
 * Workers AI Whisper transcript compared with the text by word error rate.
 */
import { parseAudio } from './generation-audio.js';

const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
/** Audio up to this long is transcribed whole; longer audio as sampled windows. */
const WHOLE_MS = 60_000;
const WINDOW_MS = 20_000;
const WINDOWS = 3;
/** Timings may overrun the measured duration by this much (encoder padding). */
const SEGMENT_SLACK_S = 0.5;

export interface VerifyLimits {
  minCps: number;
  maxCps: number;
  maxWer: number;
}

export interface Verdict {
  ok: boolean;
  reason?: string;
  durationMs?: number;
  wer?: number;
  /** The whole-file transcript; null when only windows were transcribed. */
  transcript?: string | null;
}

export type Transcribe = (audio: Uint8Array) => Promise<string>;

/** Lowercase words, letters and digits of any script only. */
export function words(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Word error rate of `hypothesis` against `reference`. With `within`, the
 * reference may be any contiguous stretch of `reference` (a sampled window).
 */
export function wer(hypothesis: string[], reference: string[], within = false): number {
  if (!hypothesis.length) return 1;
  if (!reference.length) return 1;
  // Rows: hypothesis words; columns: reference words. A free start/end in the
  // reference (semi-global alignment) when matching a window.
  let prev = Array.from({ length: reference.length + 1 }, (_, j) => (within ? 0 : j));
  for (let i = 1; i <= hypothesis.length; i++) {
    const row = [i];
    for (let j = 1; j <= reference.length; j++) {
      const same = hypothesis[i - 1] === reference[j - 1] ? 0 : 1;
      row.push(Math.min(prev[j - 1]! + same, prev[j]! + 1, row[j - 1]! + 1));
    }
    prev = row;
  }
  const errors = within ? Math.min(...prev) : prev[reference.length]!;
  return errors / (within ? hypothesis.length : reference.length);
}

/** Books-style sentence timings: `segments: [[charStart, charEnd, startSec, endSec], …]`. */
function checkSegments(meta: string | null, textLength: number, durationS: number): string | null {
  if (meta === null) return null;
  let parsed: { segments?: unknown };
  try {
    parsed = JSON.parse(meta);
  } catch {
    return 'meta is not valid JSON';
  }
  if (parsed.segments === undefined) return null;
  if (!Array.isArray(parsed.segments)) return 'meta segments must be an array';
  let lastChar = 0,
    lastTime = 0;
  for (const s of parsed.segments) {
    if (
      !Array.isArray(s) ||
      s.length < 4 ||
      s.slice(0, 4).some((n) => typeof n !== 'number' || !Number.isFinite(n)) ||
      s[0] < lastChar ||
      s[1] < s[0] ||
      s[1] > textLength ||
      s[2] < lastTime ||
      s[3] < s[2] ||
      s[3] > durationS + SEGMENT_SLACK_S
    )
      return 'meta segments are not monotonic within the text and audio';
    lastChar = s[1];
    lastTime = s[3];
  }
  return null;
}

export async function verdict(
  bytes: Uint8Array,
  contentType: string,
  meta: string | null,
  text: string,
  limits: VerifyLimits,
  transcribe: Transcribe,
): Promise<Verdict> {
  let audio;
  try {
    audio = parseAudio(bytes);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (audio.type !== contentType)
    return { ok: false, reason: `content type ${contentType} does not match ${audio.type} audio` };
  const durationMs = Math.round(audio.durationMs);
  const cps = text.trim().length / (durationMs / 1000);
  if (!durationMs || cps > limits.maxCps)
    return { ok: false, durationMs, reason: 'audio is too short for the text' };
  if (cps < limits.minCps)
    return { ok: false, durationMs, reason: 'audio is too long for the text' };
  const segments = checkSegments(meta, text.length, durationMs / 1000);
  if (segments) return { ok: false, durationMs, reason: segments };
  const reference = words(text);
  let result: { wer: number; transcript: string | null };
  if (durationMs <= WHOLE_MS) {
    const transcript = await transcribe(bytes);
    result = { wer: wer(words(transcript), reference), transcript };
  } else {
    // Random offsets, so a device cannot know which stretches are checked.
    let worst = 0;
    for (let i = 0; i < WINDOWS; i++) {
      const start = Math.floor(Math.random() * (durationMs - WINDOW_MS));
      const heard = words(await transcribe(audio.window(start, WINDOW_MS)));
      // Window edges cut words: ignore the first and last heard word.
      worst = Math.max(worst, wer(heard.slice(1, -1), reference, true));
    }
    result = { wer: worst, transcript: null };
  }
  const rounded = Math.round(result.wer * 1000) / 1000;
  if (result.wer > limits.maxWer)
    return {
      ok: false,
      durationMs,
      wer: rounded,
      transcript: result.transcript,
      reason: `transcript does not match the text (word error rate ${rounded})`,
    };
  return { ok: true, durationMs, wer: rounded, transcript: result.transcript };
}

export function whisper(ai: Ai): Transcribe {
  return async (audio) => {
    let binary = '';
    for (let i = 0; i < audio.length; i += 0x8000)
      binary += String.fromCharCode(...audio.subarray(i, i + 0x8000));
    const result = await ai.run(WHISPER_MODEL, { audio: btoa(binary) });
    return result.text ?? '';
  };
}
