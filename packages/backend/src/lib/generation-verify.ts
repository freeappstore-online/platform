/**
 * Verdicts for community generation (#729): container and content type,
 * duration plausibility against the input text, `meta` sentence timings, and a
 * Workers AI Whisper transcript compared with the text by word error rate, or
 * character error rate for scripts written without spaces (#810).
 */
import { parseAudio } from './generation-audio.js';
import { simplified } from './zh-simplified.js';

const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
/** Audio up to this long is transcribed whole; longer audio as sampled windows. */
const WHOLE_MS = 60_000;
const WINDOW_MS = 20_000;
/** Sampled windows per long submission (one Whisper call each). */
export const WINDOWS = 3;
/** Timings may overrun the measured duration by this much (encoder padding). */
const SEGMENT_SLACK_S = 0.5;
/** Audio this short is never too long for its text: a two-character phrase plus silence (#810). */
const SHORT_MS = 3000;
/** Default characters-per-second bands by primary language subtag; others use the default. */
const CPS: Record<string, [number, number]> = { zh: [2, 9], yue: [2, 9], ja: [3, 15] };
const DEFAULT_CPS: [number, number] = [8, 30];
/** Scripts written without spaces between words: each letter is its own token. */
const SPACELESS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/gu;

/** Language codes Whisper accepts; it refuses any other (checked against the model, #810). */
export const WHISPER_LANGUAGES = new Set(
  (
    'af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr gl gu ha haw he ' +
    'hi hr ht hu hy id is it ja jw ka kk km kn ko la lb ln lo lt lv mg mi mk ml mn mr ms mt my ne ' +
    'nl nn no oc pa pl ps pt ro ru sa sd si sk sl sn so sq sr su sv sw ta te tg th tk tl tr tt uk ' +
    'ur uz vi yi yo yue zh'
  ).split(' '),
);

/** The primary subtag of a BCP 47 tag (`zh-Hans` → `zh`), which Whisper takes. */
export const primaryLanguage = (language: string) => language.split('-')[0]!.toLowerCase();

/** A set's default characters-per-second band for its language (null: unspecified). */
export function cpsBand(language: string | null): [number, number] {
  return (language && CPS[primaryLanguage(language)]) || DEFAULT_CPS;
}

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
  /** Each sampled window's transcript; null when the audio was transcribed whole. */
  windows?: string[] | null;
}

/** What Whisper heard in a passing submission, for comparing replicas. */
export interface Heard {
  transcript: string | null;
  windows: string[] | null;
}

export type Transcribe = (audio: Uint8Array) => Promise<string>;

/**
 * Lowercase words of letters and digits; in scripts without word spaces (Han,
 * kana, Thai, Lao, Khmer, Myanmar) each letter is a token, so the error rate
 * there is a character error rate. Punctuation and diacritics are dropped
 * (kana voicing marks kept) and Traditional Chinese is read as Simplified.
 */
export function tokens(text: string): string[] {
  return simplified(text)
    .normalize('NFKD')
    .replace(/(?![\u3099\u309a])\p{M}/gu, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(SPACELESS, ' $& ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Edits (substitutions, insertions, deletions) from `reference` to `hypothesis`, and the length
 * they are measured against (see `tokens`). With `within`, the reference may be any contiguous
 * stretch of `reference` (a sampled window) and the length is the hypothesis's.
 */
function edits(hypothesis: string[], reference: string[], within: boolean) {
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
  return {
    errors: within ? Math.min(...prev) : prev[reference.length]!,
    length: within ? hypothesis.length : reference.length,
  };
}

/** Token error rate of `hypothesis` against `reference` (see `edits`). */
export function wer(hypothesis: string[], reference: string[], within = false): number {
  if (!hypothesis.length || !reference.length) return 1;
  const { errors, length } = edits(hypothesis, reference, within);
  return errors / length;
}

/** Up to this many tokens, a match is judged by an absolute edit budget instead of the rate (#816). */
const SHORT_TOKENS = 3;

/**
 * Whether `hypothesis` matches `reference` (see `edits`): an error rate within `maxWer`, or for
 * at most 3 tokens, one edit at most that keeps a token of the reference. Whisper often hears
 * one extra character in a one-character reply (`对。` as `对呀`), an error rate of 1 (#816).
 */
export function matches(
  hypothesis: string[],
  reference: string[],
  maxWer: number,
  within = false,
): boolean {
  if (!hypothesis.length || !reference.length) return false;
  const { errors, length } = edits(hypothesis, reference, within);
  if (length > SHORT_TOKENS) return errors / length <= maxWer;
  return errors <= 1 && hypothesis.some((t) => reference.includes(t));
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
  /**
   * Window positions as fractions of the audio, drawn once per job: devices
   * cannot know them, and every replica of a job is sampled at the same points.
   */
  windowAt: number[],
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
  if (cps < limits.minCps && durationMs > SHORT_MS)
    return { ok: false, durationMs, reason: 'audio is too long for the text' };
  const segments = checkSegments(meta, text.length, durationMs / 1000);
  if (segments) return { ok: false, durationMs, reason: segments };
  const reference = tokens(text);
  let result: { wer: number; ok: boolean } & Heard;
  if (durationMs <= WHOLE_MS) {
    const transcript = await transcribe(bytes);
    const heard = tokens(transcript);
    result = {
      wer: wer(heard, reference),
      ok: matches(heard, reference, limits.maxWer),
      transcript,
      windows: null,
    };
  } else {
    // Proportional offsets: replicas at a slightly different pace still line up.
    let worst = 0;
    let ok = true;
    const windows: string[] = [];
    for (const at of windowAt) {
      const start = Math.floor(at * (durationMs - WINDOW_MS));
      const heard = await transcribe(audio.window(start, WINDOW_MS));
      windows.push(heard);
      worst = Math.max(worst, wer(trimEdges(heard), reference, true));
      ok &&= matches(trimEdges(heard), reference, limits.maxWer, true);
    }
    result = { wer: worst, ok, transcript: null, windows };
  }
  const rounded = Math.round(result.wer * 1000) / 1000;
  if (!result.ok)
    return {
      ok: false,
      durationMs,
      wer: rounded,
      transcript: result.transcript,
      windows: result.windows,
      reason: `transcript does not match the text (${text.match(SPACELESS) ? 'character' : 'word'} error rate ${rounded})`,
    };
  return {
    ok: true,
    durationMs,
    wer: rounded,
    transcript: result.transcript,
    windows: result.windows,
  };
}

/** A window's words without the first and last, which the window edges cut. */
const trimEdges = (heard: string) => tokens(heard).slice(1, -1);

/**
 * Whether two passing replicas of a job say the same thing (#784): whole
 * transcripts match each other (see `matches`); sampled windows (the same
 * fractions of each replica) each match the other's same window; a window
 * against a whole transcript, anywhere in it.
 */
export function agree(a: Heard, b: Heard, maxWer: number): boolean {
  if (a.transcript !== null && b.transcript !== null)
    return matches(tokens(b.transcript), tokens(a.transcript), maxWer);
  if (a.windows && b.windows) {
    const other = b.windows;
    return (
      a.windows.length === other.length &&
      a.windows.every((w, i) => matches(trimEdges(other[i]!), tokens(w), maxWer, true))
    );
  }
  const whole = a.transcript ?? b.transcript;
  const windows = a.windows ?? b.windows;
  // Verified before window transcripts were kept (#784): only durations compare.
  if (whole === null || !windows) return true;
  return windows.every((w) => matches(trimEdges(w), tokens(whole), maxWer, true));
}

/** Whisper, told the set's language when it has one (its primary subtag, e.g. `zh`). */
export function whisper(ai: Ai, language: string | null = null): Transcribe {
  return async (audio) => {
    let binary = '';
    for (let i = 0; i < audio.length; i += 0x8000)
      binary += String.fromCharCode(...audio.subarray(i, i + 0x8000));
    const result = await ai.run(WHISPER_MODEL, {
      audio: btoa(binary),
      ...(language ? { language: primaryLanguage(language) } : {}),
    });
    return result.text ?? '';
  };
}
