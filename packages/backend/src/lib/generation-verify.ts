/**
 * Verdicts for community generation (#729): container and content type,
 * duration plausibility against the input text, and `meta` sentence timings.
 * No AI compute checks anything (#831): people judge the audio itself (#787).
 */
import { parseAudio } from './generation-audio.js';

/** Timings may overrun the measured duration by this much (encoder padding). */
const SEGMENT_SLACK_S = 0.5;
/** Audio this short is never too long for its text: a two-character phrase plus silence (#810). */
const SHORT_MS = 3000;
/** Default characters-per-second bands by primary language subtag; others use the default. */
const CPS: Record<string, [number, number]> = { zh: [2, 9], yue: [2, 9], ja: [3, 15] };
const DEFAULT_CPS: [number, number] = [8, 30];

/** The primary subtag of a BCP 47 tag (`zh-Hans` → `zh`). */
const primaryLanguage = (language: string) => language.split('-')[0]!.toLowerCase();

/** A set's default characters-per-second band for its language (null: unspecified). */
export function cpsBand(language: string | null): [number, number] {
  return (language && CPS[primaryLanguage(language)]) || DEFAULT_CPS;
}

export interface VerifyLimits {
  minCps: number;
  maxCps: number;
}

export interface Verdict {
  ok: boolean;
  reason?: string;
  durationMs?: number;
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

export function verdict(
  bytes: Uint8Array,
  contentType: string,
  meta: string | null,
  text: string,
  limits: VerifyLimits,
): Verdict {
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
  if (cps < limits.minCps && durationMs > SHORT_MS)
    return { ok: false, durationMs, reason: 'audio is too long for the text' };
  const segments = checkSegments(meta, text.length, durationMs / 1000);
  if (segments) return { ok: false, durationMs, reason: segments };
  return { ok: true, durationMs };
}
