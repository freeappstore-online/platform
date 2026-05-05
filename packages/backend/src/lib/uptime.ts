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
