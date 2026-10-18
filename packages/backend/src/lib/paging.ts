/**
 * Page size from a query string.
 *
 * SQLite treats a negative LIMIT as "no upper bound", so a value below 1
 * must not be passed through. Non-numeric input is NaN, and Math.min(NaN, max)
 * is NaN, which D1 then rejects — fall back instead.
 */
export function queryLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

/** Non-negative OFFSET. SQLite rejects a negative offset. */
export function queryOffset(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}
