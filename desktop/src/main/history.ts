import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  GenerationAttemptRecord,
  GenerationEndReason,
  GenerationReport,
  GenerationSubmissionStatus,
} from '@freeappstore/sdk';
import { GenerationError } from '@freeappstore/sdk';

/**
 * This computer's Contribute history (#827): every job it tried, with what it measured and the
 * server's verdict, kept in userData. The audio and segments of the latest KEEP_AUDIO attempts
 * stay too, so Contribute can play them back (rejected ones included). Only the numbers go to the
 * server (`…/generation/events`); the text and the upload are already there.
 */
export interface HistoryItem {
  appId: string;
  jobId: string;
  key: string;
  /** When the job was claimed (ms epoch). */
  at: number;
  /** `in_progress`: the job in hand (#838), from its claim until it ends. */
  outcome: 'in_progress' | 'submitted' | 'skipped' | 'stopped' | 'failed';
  reason: string | null;
  /** The input, cut at TEXT_CHARS; `chars` is its whole length. */
  text: string;
  chars: number;
  record: GenerationAttemptRecord;
  /**
   * The server's verdict on the upload, once asked (`mySubmissions`), with this account's own
   * Good / Not good for it (#831). Records kept before #831 have no `submissionId` until asked again.
   */
  verdict: {
    submissionId?: string;
    status: GenerationSubmissionStatus;
    reason: string | null;
    durationMs: number | null;
    report?: GenerationReport | null;
  } | null;
}

const FILE = 'contribute-history.json';
const AUDIO = 'contribute-audio';
const MAX_ITEMS = 200;
const KEEP_AUDIO = 20;
export const TEXT_CHARS = 4000;

/** Why an item still In progress when the history is read again ended: its run went with the app. */
export const INTERRUPTED = 'interrupted: FreeAppStore closed before it finished';

/**
 * The history as saved. An item still `in_progress` was cut off by a quit or crash (#838): it is
 * `stopped`, interrupted. Its record is not sent: the server counts a lease that ran out unreleased
 * as interrupted and offers the job again (#841).
 */
export function loadHistory(dir: string): HistoryItem[] {
  try {
    const items = JSON.parse(readFileSync(join(dir, FILE), 'utf8'));
    if (!Array.isArray(items)) return [];
    return (items as HistoryItem[]).map((item) =>
      item.outcome === 'in_progress' ? { ...item, outcome: 'stopped', reason: INTERRUPTED } : item,
    );
  } catch {
    return []; // none yet, or unreadable: start a new one
  }
}

/** Newest first, at most MAX_ITEMS. */
export function saveHistory(dir: string, items: HistoryItem[]): HistoryItem[] {
  const kept = items.slice(0, MAX_ITEMS);
  writeFileSync(join(dir, FILE), JSON.stringify(kept));
  return kept;
}

/** Deletes the history and the kept audio (#848): an explicit sign-out or another account. */
export function clearHistory(dir: string): HistoryItem[] {
  rmSync(join(dir, FILE), { force: true });
  rmSync(join(dir, AUDIO), { recursive: true, force: true });
  return [];
}

const audioName = (appId: string, jobId: string) => `${appId}--${jobId}`;

/** Keep a job's audio and meta; the oldest beyond KEEP_AUDIO go. */
export function keepAudio(
  dir: string,
  appId: string,
  jobId: string,
  audio: Uint8Array,
  meta: unknown,
): void {
  const folder = join(dir, AUDIO);
  mkdirSync(folder, { recursive: true });
  const name = audioName(appId, jobId);
  writeFileSync(join(folder, `${name}.m4a`), audio);
  writeFileSync(join(folder, `${name}.json`), JSON.stringify(meta));
  // Names sort by when they were written only through the history, so go by its order
  const order = new Map(
    loadHistory(dir).map((item, i) => [audioName(item.appId, item.jobId), i] as const),
  );
  const names = [
    ...new Set(readdirSync(folder).map((file) => file.replace(/\.(m4a|json)$/, ''))),
  ].sort((a, b) =>
    a === name ? -1 : b === name ? 1 : (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9),
  );
  for (const old of names.slice(KEEP_AUDIO))
    for (const ext of ['m4a', 'json']) rmSync(join(folder, `${old}.${ext}`), { force: true });
}

/** A kept job's audio and meta, or null once pruned. */
export function readAudio(
  dir: string,
  appId: string,
  jobId: string,
): { audio: Uint8Array; meta: unknown } | null {
  const base = join(dir, AUDIO, audioName(appId, jobId));
  if (!existsSync(`${base}.m4a`) || !existsSync(`${base}.json`)) return null;
  return {
    audio: new Uint8Array(readFileSync(`${base}.m4a`)),
    meta: JSON.parse(readFileSync(`${base}.json`, 'utf8')),
  };
}

/**
 * An item's full record and its audio, for a bug report (#843): `record.json` (the item, with the
 * audio's sentence timings when kept) and `audio.m4a`, in a new folder `target`.
 */
export function saveRecord(dir: string, item: HistoryItem, target: string): void {
  const kept = readAudio(dir, item.appId, item.jobId);
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, 'record.json'),
    `${JSON.stringify({ ...item, ...(kept && { meta: kept.meta }) }, null, 2)}\n`,
  );
  if (kept) writeFileSync(join(target, 'audio.m4a'), kept.audio);
}

/** The #813 reason for how a job ended on this computer. */
export function endReason(
  outcome: HistoryItem['outcome'],
  reason: string | null,
  err?: unknown,
): GenerationEndReason {
  if (outcome === 'submitted') return 'submitted';
  if (err instanceof GenerationError)
    return err.status === 403 ? 'lease_403' : err.status >= 500 ? 'server_5xx' : 'server_4xx';
  if (err instanceof TypeError) return 'network';
  const text = reason ?? '';
  if (outcome === 'skipped')
    return /exceed/.test(text) ? 'too_large' : /lease/.test(text) ? 'lease_cap' : 'unsupported';
  if (outcome === 'stopped') return /lease/.test(text) ? 'lease_cap' : 'user_stop';
  return /network|fetch/i.test(text) ? 'network' : 'other';
}
