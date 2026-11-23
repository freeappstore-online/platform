/**
 * Uptime check: hits a URL with a 5s timeout, classifies the result.
 *
 * "ok" means we got an HTTP response with a non-5xx status. 4xx counts
 * as ok because lots of legitimate apps return 401/403/404 from "/" —
 * the goal here is "is the origin reachable + serving a Worker", not
 * "is every endpoint healthy". Per-app health endpoints can come later.
 */
export interface CheckResult {
  ok: boolean;
  status: number | null;
  durationMs: number;
  error: string | null;
}

const TIMEOUT_MS = 5000;

export async function checkUrl(url: string, now: () => number = Date.now): Promise<CheckResult> {
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal, redirect: 'manual' });
    const durationMs = now() - started;
    const ok = res.status < 500;
    return { ok, status: res.status, durationMs, error: ok ? null : `http ${res.status}` };
  } catch (err) {
    const durationMs = now() - started;
    const message = err instanceof Error ? err.message : String(err);
    const error = message.includes('aborted') ? `timeout after ${TIMEOUT_MS}ms` : message;
    return { ok: false, status: null, durationMs, error };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The list of targets to check. Hand-maintained for v0 — a registry-driven
 * list lives in `packages/cli/src/lib/apps.ts` but the Worker can't easily
 * import from a sibling package without bundling, so we duplicate here.
 *
 * Notably absent: `api.freeappstore.online` itself. A Worker fetching its
 * own custom domain hits a CF edge loop and returns 522. That's not a real
 * outage — it's a hosting-platform property — so we drop it. Health of the
 * API is implicit: if this cron runs and inserts rows, the API is up.
 *
 * Worth deduplicating once the registry is fetched from a remote URL.
 */
export const TARGETS: Array<{ id: string; url: string }> = [
  { id: 'freeappstore', url: 'https://freeappstore.online' },
  { id: 'chess', url: 'https://chess.freeappstore.online' },
  { id: 'language', url: 'https://language.freeappstore.online' },
  { id: 'math', url: 'https://math.freeappstore.online' },
  { id: 'quiz', url: 'https://quiz.freeappstore.online' },
  { id: 'books', url: 'https://books.freeappstore.online' },
  { id: 'music', url: 'https://music.freeappstore.online' },
  { id: 'puzzle', url: 'https://puzzle.freeappstore.online' },
];

/**
 * Concurrency-aware probe (#642). The 1101 outage of 2026-11-23 (#639) needed
 * overlapping requests in one isolate, so one request per target never saw it.
 * Each tick sends a concurrent burst to `run` plus a rotating sample of live
 * apps. Workers keep at most 6 connections open per invocation, so 6 is the
 * real overlap a burst can create; the sample stays small because the 15-minute
 * cron shares the 50-subrequest free-plan cap with push delivery.
 */
const BURST_REQUESTS = 6;
const BURST_SAMPLE = 4;
const ALWAYS_BURST = 'run';

/** `run` plus `size` app ids, rotating through the sorted list one window per tick. */
export function burstSample(ids: string[], tick: number, size = BURST_SAMPLE): string[] {
  const pool = [...new Set(ids)].filter((id) => id && id !== ALWAYS_BURST).sort();
  if (pool.length <= size) return [ALWAYS_BURST, ...pool];
  const start = (tick * size) % pool.length;
  return [
    ALWAYS_BURST,
    ...Array.from({ length: size }, (_, i) => pool[(start + i) % pool.length]!),
  ];
}

/** `requests` concurrent checks of one URL, folded into one result: any failure fails it. */
export async function burstCheck(url: string, requests = BURST_REQUESTS): Promise<CheckResult> {
  const results = await Promise.all(Array.from({ length: requests }, () => checkUrl(url)));
  const failed = results.filter((r) => !r.ok);
  const errors = [...new Set(failed.map((r) => r.error))].join(', ');
  return {
    ok: failed.length === 0,
    status: (failed[0] ?? results[0])?.status ?? null,
    durationMs: Math.max(...results.map((r) => r.durationMs)),
    error: failed.length ? `${failed.length}/${requests} failed: ${errors}` : null,
  };
}
